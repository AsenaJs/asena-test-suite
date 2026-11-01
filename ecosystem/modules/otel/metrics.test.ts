import { afterAll, beforeAll, beforeEach, expect } from 'bun:test';
import type { TestApp } from '@asenajs/asena/test';
import { bootApp, scenario } from '@asenajs/adapter-conformance';
import { type MetricPoint, otelFixture, type Telemetry } from './fixtures/otel.ts';
import { settle } from './fixtures/spans.ts';

const COUNTER = 'http.server.request.count';
const DURATION = 'http.server.request.duration';

let app: TestApp;
let telemetry: Telemetry;

beforeAll(async () => {
  const fixture = otelFixture();

  telemetry = fixture.telemetry;
  app = await bootApp({ components: fixture.components });
});

afterAll(async () => {
  await app?.stop();
});

beforeEach(async () => {
  await telemetry.reset();
});

function total(points: MetricPoint[]): number {
  return points.reduce((sum, point) => sum + Number(point.value), 0);
}

function byRoute(points: MetricPoint[]): Record<string, unknown>[] {
  return points
    .map((point): Record<string, unknown> => ({ ...point.attributes, value: point.value }))
    .sort((a, b) => String(a['http.route']).localeCompare(String(b['http.route'])));
}

scenario(
  'P2.otel.010',
  'the request counter and duration histogram get one series per route, method and status',
  async () => {
    expect((await app.get('/users/1')).status).toBe(200);
    expect((await app.get('/users/2')).status).toBe(200);
    expect((await app.post('/users')).status).toBe(201);

    await settle(telemetry, () => total(telemetry.points(COUNTER)) === 3, 'three counted requests');

    expect(byRoute(telemetry.points(COUNTER))).toEqual([
      { 'http.request.method': 'POST', 'http.route': '/users', 'http.response.status_code': 201, value: 1 },
      { 'http.request.method': 'GET', 'http.route': '/users/:id', 'http.response.status_code': 200, value: 2 },
    ]);

    const histogram = telemetry.points(DURATION);

    expect(
      histogram.map((point) => [point.attributes['http.route'], point.value.count]).sort((a, b) => b[1] - a[1]),
    ).toEqual([
      ['/users/:id', 2],
      ['/users', 1],
    ]);
    expect(histogram.every((point) => point.value.sum >= 0)).toBe(true);
  },
  { requires: ['optional.routePattern'] },
);

scenario('P2.otel.011', 'unmatched paths collapse into one 404 series', async () => {
  for (const path of ['/wp-admin/setup.php', '/.env', '/scan/a/b/c', '/users/1/unknown'])
    expect((await app.get(path)).status).toBe(404);

  await settle(telemetry, () => total(telemetry.points(COUNTER)) === 4, 'four counted requests');

  expect(byRoute(telemetry.points(COUNTER))).toEqual([
    { 'http.request.method': 'GET', 'http.route': 'unmatched', 'http.response.status_code': 404, value: 4 },
  ]);
});

scenario('P2.otel.012', '200 unique scanner paths stay one bounded metric series', async () => {
  const scanned = 200;

  for (let index = 0; index < scanned; index++) {
    expect((await app.get(`/scanner-${index}-${crypto.randomUUID()}`)).status).toBe(404);
  }

  await settle(telemetry, () => total(telemetry.points(COUNTER)) === scanned, 'every scanner request counted');

  expect(byRoute(telemetry.points(COUNTER))).toEqual([
    { 'http.request.method': 'GET', 'http.route': 'unmatched', 'http.response.status_code': 404, value: scanned },
  ]);
  expect(telemetry.points(DURATION)).toHaveLength(1);
});
