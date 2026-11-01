import { afterAll, describe, expect, it } from 'bun:test';
import { runWave } from '../../ecosystem/modules/otel-leak-sim/harness/traffic.ts';

const users = new Map<string, unknown>();
const outcomes = new Map<string, number>();

const record = (key: string) => outcomes.set(key, (outcomes.get(key) ?? 0) + 1);

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const match = /^\/api\/users\/([^/]+)$/.exec(pathname);

    if (pathname === '/api/users' && request.method === 'POST') {
      const body = (await request.json()) as { name?: string };

      if (!body.name) return Response.json({}, { status: 400 });

      const id = crypto.randomUUID();

      users.set(id, body);

      return Response.json({ id }, { status: 201 });
    }

    if (!match) return Response.json({});

    const id = match[1];
    const exists = users.has(id);

    if (request.method === 'DELETE' && exists) users.delete(id);

    const status = exists ? 200 : 404;

    record(`${request.method} ${status}`);

    return Response.json({}, { status });
  },
});

afterAll(() => server.stop(true));

describe('leak-sim normal traffic', () => {
  it('reads, updates and deletes existing users by id, and also misses', async () => {
    await runWave(`http://127.0.0.1:${server.port}`, { normal: 600, attacker: 0, scanner: 0, tag: 't' });

    expect(outcomes.get('GET 200') ?? 0).toBeGreaterThan(0);
    expect(outcomes.get('GET 404') ?? 0).toBeGreaterThan(0);
    expect(outcomes.get('PUT 200') ?? 0).toBeGreaterThan(0);
    expect(outcomes.get('DELETE 200') ?? 0).toBeGreaterThan(0);
  });
});
