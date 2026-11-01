import { afterAll, beforeAll, beforeEach, expect } from 'bun:test';
import type { TestApp } from '@asenajs/asena/test';
import { SpanKind } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { bootApp, scenario } from '@asenajs/adapter-conformance';
import { cleanupNamespace, pgSchema, redisPrefix, trackRedisPrefix } from '../../src/namespace.ts';
import { assertReachable } from '../../src/services.ts';
import { createItemsSql, extendedComponents, PROTECTED_TOKEN } from './fixtures/extended.ts';
import { otelFixture, type Telemetry } from './fixtures/otel.ts';
import { internalSpan, parentOf, serverSpanFor, settle } from './fixtures/spans.ts';

const ready = (await assertReachable('postgres')) && (await assertReachable('redis'));
const services = { services: ['postgres' as const, 'redis' as const] };
let app: TestApp | undefined;
let telemetry: Telemetry;

beforeAll(async () => {
  if (!ready) return;

  const postgresUrl = process.env.ASENA_SUITE_POSTGRES_URL ?? '';
  const redisUrl = process.env.ASENA_SUITE_REDIS_URL ?? '';
  const schema = pgSchema(postgresUrl);
  const keyPrefix = trackRedisPrefix(redisUrl, `${redisPrefix()}otel:`);
  const admin = new Bun.SQL(postgresUrl);

  await schema.create();

  try {
    await admin.unsafe(createItemsSql(schema.schema));
  } finally {
    await admin.close();
  }

  const fixture = otelFixture({ extra: extendedComponents({ postgresUrl: schema.url, redisUrl, keyPrefix }) });

  telemetry = fixture.telemetry;
  app = await bootApp({ components: fixture.components });
});

afterAll(async () => {
  await app?.stop();
  await cleanupNamespace();
});

beforeEach(async () => {
  if (app) await telemetry.reset();
});

function booted(): TestApp {
  if (!app) throw new Error('otel extended app was not booted');

  return app;
}

function json(body: unknown): RequestInit {
  return { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
}

function internalNames(): string[] {
  return telemetry
    .spans()
    .filter((span) => span.kind === SpanKind.INTERNAL)
    .map((span) => span.name);
}

function sameTrace(spans: (ReadableSpan | undefined)[]): boolean {
  const traceId = spans[0]?.spanContext().traceId;

  return traceId !== undefined && spans.every((span) => span?.spanContext().traceId === traceId);
}

scenario(
  'P2.otel.030',
  '@Repository CRUD calls produce INTERNAL spans under the controller span',
  async () => {
    const created = await booted().post('/items', json({ name: 'first' }));
    const id = created.json().id as string;

    expect(created.status).toBe(201);
    expect((await booted().get('/items')).status).toBe(200);
    expect((await booted().put(`/items/${id}`, json({ name: 'renamed' }))).json()).toMatchObject({ name: 'renamed' });
    expect((await booted().delete(`/items/${id}`)).json()).toEqual({ deleted: true });

    const server = await settle(telemetry, () => serverSpanFor(telemetry, '/items'), 'create request span');
    const names = internalNames();

    for (const name of [
      'TracedItemRepository.create',
      'TracedItemRepository.findAll',
      'TracedItemRepository.updateById',
      'TracedItemRepository.deleteById',
    ]) {
      expect(names).toContain(name);
    }

    const controller = telemetry
      .spans()
      .find(
        (span) =>
          span.name === 'TracedItemController.create' && span.spanContext().traceId === server.spanContext().traceId,
      );
    const repository = internalSpan(telemetry, 'TracedItemRepository.create');

    expect(parentOf(controller)).toBe(server.spanContext().spanId);
    expect(parentOf(repository)).toBe(controller?.spanContext().spanId);
  },
  services,
);

scenario(
  'P2.otel.031',
  '@Redis and CacheService calls produce INTERNAL spans in the request trace',
  async () => {
    expect((await booted().get('/cached/answer')).json()).toEqual({ value: 'computed' });
    expect((await booted().post('/cached/raw/direct')).json()).toEqual({ value: 'raw-value' });

    const server = await settle(telemetry, () => serverSpanFor(telemetry, '/cached/answer'), 'cache request span');
    const controller = internalSpan(telemetry, 'TracedCacheController.compute');
    const cache = internalSpan(telemetry, 'TracedCacheService.getOrSet');
    const redisGet = telemetry
      .spans()
      .find((span) => span.name === 'TracedRedis.get' && parentOf(span) === cache?.spanContext().spanId);
    const redisSet = telemetry
      .spans()
      .find((span) => span.name === 'TracedRedis.set' && parentOf(span) === cache?.spanContext().spanId);

    expect(parentOf(controller)).toBe(server.spanContext().spanId);
    expect(parentOf(cache)).toBe(controller?.spanContext().spanId);
    expect(sameTrace([server, controller, cache, redisGet, redisSet])).toBe(true);
    expect(
      internalNames()
        .filter((name) => name.startsWith('TracedRedis.'))
        .sort(),
    ).toEqual(['TracedRedis.get', 'TracedRedis.get', 'TracedRedis.set', 'TracedRedis.set']);
  },
  services,
);

scenario(
  'P2.otel.032',
  '@Middleware and @Component classes are not traced',
  async () => {
    const response = await booted().get('/guarded/data', { headers: { 'x-token': PROTECTED_TOKEN } });

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ data: 'stamped:secret' });

    await settle(telemetry, () => internalSpan(telemetry, 'TracedGuardedController.data'), 'controller span');

    expect(
      internalNames().filter((name) => name.startsWith('TracedGuard.') || name.startsWith('TracedUtility.')),
    ).toEqual([]);
    expect(internalNames()).toEqual(['TracedGuardedController.data']);
  },
  services,
);

scenario(
  'P2.otel.033',
  'a controller behind a route middleware keeps the request trace, and a rejected request has no controller span',
  async () => {
    expect((await booted().get('/guarded/data')).status).toBe(401);
    expect((await booted().get('/guarded/data', { headers: { 'x-token': PROTECTED_TOKEN } })).status).toBe(200);

    await settle(
      telemetry,
      () => telemetry.spans().filter((span) => span.kind === SpanKind.SERVER).length === 2,
      'both server spans',
    );

    const controllers = telemetry.spans().filter((span) => span.name === 'TracedGuardedController.data');
    const servers = telemetry.spans().filter((span) => span.kind === SpanKind.SERVER);
    const parent = servers.find((span) => span.spanContext().spanId === parentOf(controllers[0]));

    expect(controllers).toHaveLength(1);
    expect(parent?.attributes['url.path']).toBe('/guarded/data');
    expect(sameTrace([parent, controllers[0]])).toBe(true);
  },
  services,
);
