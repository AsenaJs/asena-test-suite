import { afterAll, beforeAll, beforeEach, expect } from 'bun:test';
import type { TestApp } from '@asenajs/asena/test';
import { SpanKind } from '@opentelemetry/api';
import { bootApp, getDescriptor, scenario } from '@asenajs/adapter-conformance';
import { MESSAGE_PATTERN, otelFixture, type Telemetry } from './fixtures/otel.ts';
import { internalSpan, parentOf, serverSpanFor, serverSpans, settle } from './fixtures/spans.ts';

let app: TestApp;
let telemetry: Telemetry;

beforeAll(async () => {
  const fixture = otelFixture({ define: (schemas) => getDescriptor().defineContext(schemas) });

  telemetry = fixture.telemetry;
  app = await bootApp({ components: fixture.components });
});

afterAll(async () => {
  await app?.stop();
});

beforeEach(async () => {
  await telemetry.reset();
});

scenario('P2.otel.001', 'one SERVER span per request carries method, url.path and status', async () => {
  expect((await app.get('/users/42')).status).toBe(200);

  const span = await settle(telemetry, () => serverSpanFor(telemetry, '/users/42'), 'server span');

  expect(serverSpans(telemetry)).toHaveLength(1);
  expect(span.attributes['http.request.method']).toBe('GET');
  expect(span.attributes['url.path']).toBe('/users/42');
  expect(span.attributes['http.response.status_code']).toBe(200);
});

scenario(
  'P2.otel.002',
  'span name and http.route use the route pattern, not the concrete path',
  async () => {
    expect((await app.get('/users/1')).status).toBe(200);
    expect((await app.get('/users/abc-2')).status).toBe(200);

    await settle(telemetry, () => serverSpans(telemetry).length === 2, 'two server spans');

    for (const span of serverSpans(telemetry)) {
      expect(span.name).toBe('GET /users/:id');
      expect(span.attributes['http.route']).toBe('/users/:id');
    }
    expect(serverSpans(telemetry).map((span) => span.attributes['url.path'])).toEqual(['/users/1', '/users/abc-2']);
  },
  { requires: ['optional.routePattern'] },
);

scenario(
  'P2.otel.003',
  'the status attribute equals the real status for 200, 201, HttpException 403, validation 400 and unmatched 404',
  async () => {
    const json = { body: '{}', headers: { 'content-type': 'application/json' } };
    const statuses = [
      (await app.get('/users/7')).status,
      (await app.post('/users')).status,
      (await app.get('/trace/forbidden')).status,
      (await app.post('/validated', json)).status,
      (await app.get('/no-such/route')).status,
    ];

    expect(statuses).toEqual([200, 201, 403, 400, 404]);

    await settle(telemetry, () => serverSpans(telemetry).length === 5, 'five server spans');

    expect(
      ['/users/7', '/users', '/trace/forbidden', '/validated', '/no-such/route'].map(
        (path) => serverSpanFor(telemetry, path)?.attributes['http.response.status_code'],
      ),
    ).toEqual(statuses);
  },
);

scenario('P2.otel.004', 'controller and service INTERNAL spans are parented to the SERVER span', async () => {
  expect((await app.get('/users/9')).status).toBe(200);

  const server = await settle(telemetry, () => serverSpanFor(telemetry, '/users/9'), 'server span');
  const controller = internalSpan(telemetry, 'TraceUserController.byId');
  const service = internalSpan(telemetry, 'TraceGreetingService.greet');

  expect(parentOf(controller)).toBe(server.spanContext().spanId);
  expect(parentOf(service)).toBe(controller?.spanContext().spanId);
  expect(
    [server, controller, service].map((span) => span?.spanContext().traceId === server.spanContext().traceId),
  ).toEqual([true, true, true]);
});

scenario('P2.otel.005', 'an incoming traceparent continues the trace', async () => {
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
  const parentSpanId = '00f067aa0ba902b7';
  const response = await app.get('/users/5', { headers: { traceparent: `00-${traceId}-${parentSpanId}-01` } });

  expect(response.status).toBe(200);

  const server = await settle(telemetry, () => serverSpanFor(telemetry, '/users/5'), 'server span');

  expect(server.spanContext().traceId).toBe(traceId);
  expect(parentOf(server)).toBe(parentSpanId);
});

scenario(
  'P2.otel.006',
  'a ulak send from a handler carries traceparent and the consumer span joins the trace',
  async () => {
    const response = await app.post('/trace/message');

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ echoed: 'traced' });

    const server = await settle(telemetry, () => serverSpanFor(telemetry, '/trace/message'), 'server span');
    const traceId = server.spanContext().traceId;
    const consumer = telemetry.spans().find((span) => span.kind === SpanKind.CONSUMER);
    const producer = telemetry.spans().find((span) => span.kind === SpanKind.PRODUCER);

    expect(telemetry.consumed).toHaveLength(1);
    expect(telemetry.consumed[0].traceId).toBe(traceId);
    expect(telemetry.consumed[0].traceparent).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
    expect(producer?.name).toBe(`send ${MESSAGE_PATTERN}`);
    expect(consumer?.name).toBe(`process ${MESSAGE_PATTERN}`);
    expect(consumer?.spanContext().traceId).toBe(traceId);
    expect(parentOf(consumer)).toBe(producer?.spanContext().spanId);
  },
);
