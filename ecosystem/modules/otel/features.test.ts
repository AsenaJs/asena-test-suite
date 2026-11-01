import { afterAll, beforeAll, beforeEach, expect } from 'bun:test';
import type { TestApp } from '@asenajs/asena/test';
import { bootApp, scenario } from '@asenajs/adapter-conformance';
import { otelFixture, type Telemetry } from './fixtures/otel.ts';
import { serverSpanFor, serverSpans, settle } from './fixtures/spans.ts';

const COUNTER = 'http.server.request.count';

let app: TestApp;
let telemetry: Telemetry;

beforeAll(async () => {
  const fixture = otelFixture({ ignoreRoutes: ['/health'] });

  telemetry = fixture.telemetry;
  app = await bootApp({ components: fixture.components });
});

afterAll(async () => {
  await app?.stop();
});

beforeEach(async () => {
  await telemetry.reset();
});

scenario('P2.otel.020', 'ignoreRoutes leaves /health without a span and without a metric point', async () => {
  expect((await app.get('/health')).status).toBe(200);
  expect((await app.get('/users/3')).status).toBe(200);

  await settle(telemetry, () => serverSpanFor(telemetry, '/users/3'), 'traced request span');
  await settle(telemetry, () => telemetry.points(COUNTER).length > 0, 'traced request metric');

  const points = telemetry.points(COUNTER);

  expect(points.map((point) => point.attributes['http.request.method'])).toEqual(['GET']);
  expect(points.map((point) => point.value)).toEqual([1]);
  expect(points.filter((point) => String(point.attributes['http.route']).startsWith('/health'))).toEqual([]);
  expect(serverSpans(telemetry).map((span) => span.attributes['url.path'])).toEqual(['/users/3']);
});
