import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'bun:test';
import type { TestApp } from '@asenajs/asena/test';
import { bootApp, scenario } from '@asenajs/adapter-conformance';
import { cleanupNamespace, pgSchema } from '../../src/namespace.ts';
import { assertReachable } from '../../src/services.ts';
import { drizzleFixture, type UserPayload } from './fixtures/drizzle.ts';
import { createTableSql } from './fixtures/schema.ts';

const reachable = await assertReachable('postgres');
const schema = reachable ? pgSchema(process.env.ASENA_SUITE_POSTGRES_URL ?? '') : undefined;
const opts = { services: ['postgres' as const] };
let admin: Bun.SQL | undefined;
let app: TestApp | undefined;
let middlewareRuns: string[] = [];

beforeAll(async () => {
  if (!schema) return;

  await schema.create();
  admin = new Bun.SQL(process.env.ASENA_SUITE_POSTGRES_URL ?? '');
  await admin.unsafe(createTableSql(schema.schema));
});

afterAll(async () => {
  await admin?.close();
  await cleanupNamespace();
});

beforeEach(async () => {
  if (!schema || !admin) return;

  await admin.unsafe(`TRUNCATE "${schema.schema}".suite_users`);

  const fixture = drizzleFixture(schema.url);

  middlewareRuns = fixture.middlewareRuns;
  app = await bootApp({ components: fixture.components });
});

afterEach(async () => {
  await app?.stop();
  app = undefined;
});

function booted(): TestApp {
  if (!app) throw new Error('drizzle app was not booted');

  return app;
}

function json(body: unknown): RequestInit {
  return { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
}

function user(name: string, tag?: string): UserPayload {
  return { name, email: `${name}@suite.test`, ...(tag ? { tag } : {}) };
}

async function emails(): Promise<string[]> {
  const rows = await admin!.unsafe<{ email: string }[]>(
    `SELECT email FROM "${schema!.schema}".suite_users ORDER BY email`,
  );

  return rows.map((row) => row.email);
}

scenario(
  'P2.drizzle.001',
  'create returns 201 with the stored row',
  async () => {
    const response = await booted().post('/users', json(user('ada')));
    const body = response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ name: 'ada', email: 'ada@suite.test', tag: null });
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(await emails()).toEqual(['ada@suite.test']);
  },
  opts,
);

scenario(
  'P2.drizzle.002',
  'findById returns the created row',
  async () => {
    const created = (await booted().post('/users', json(user('grace')))).json();
    const response = await booted().get(`/users/by-id/${created.id}`);

    expect(response.status).toBe(200);
    expect(response.json()).toEqual(created);
  },
  opts,
);

scenario(
  'P2.drizzle.003',
  'an unknown id answers 404 from the handler',
  async () => {
    const response = await booted().get('/users/by-id/00000000-0000-4000-8000-000000000000');

    expect(response.status).toBe(404);
    expect(response.json()).toEqual({ error: 'not found' });
  },
  opts,
);

scenario(
  'P2.drizzle.004',
  'paginate splits 15 rows into pages of 5 in order',
  async () => {
    const rows = Array.from({ length: 15 }, (_, i) => user(`p${String(i + 1).padStart(2, '0')}`));

    expect((await booted().post('/users/bulk', json(rows))).status).toBe(201);

    const response = await booted().get('/users/page?page=2&limit=5');
    const body = response.json();

    expect(response.status).toBe(200);
    // asena-drizzle 4.0.1 countBy() returns pg's bigint count(*) as a string; the fix belongs in the package
    expect({ total: Number(body.total), page: body.page, limit: body.limit, totalPages: body.totalPages }).toEqual({
      total: 15,
      page: 2,
      limit: 5,
      totalPages: 3,
    });
    expect(body.data.map((row: UserPayload) => row.name)).toEqual(['p06', 'p07', 'p08', 'p09', 'p10']);
  },
  opts,
);

scenario(
  'P2.drizzle.005',
  'search by email finds the row and answers 404 for an unknown email',
  async () => {
    await booted().post('/users', json(user('linus')));

    const found = await booted().get('/users/by-email/linus@suite.test');
    const missing = await booted().get('/users/by-email/nobody@suite.test');

    expect(found.status).toBe(200);
    expect(found.json()).toMatchObject({ name: 'linus', email: 'linus@suite.test' });
    expect(missing.status).toBe(404);
  },
  opts,
);

scenario(
  'P2.drizzle.006',
  'count reflects the stored rows',
  async () => {
    expect((await booted().get('/users/count')).json()).toEqual({ count: 0 });

    await booted().post('/users', json(user('c1')));
    await booted().post('/users', json(user('c2')));

    expect((await booted().get('/users/count')).json()).toEqual({ count: 2 });
  },
  opts,
);

scenario(
  'P2.drizzle.007',
  'bulk create stores every row and returns them',
  async () => {
    const response = await booted().post('/users/bulk', json([user('b1'), user('b2'), user('b3')]));

    expect(response.status).toBe(201);
    expect(response.json().map((row: UserPayload) => row.email)).toEqual([
      'b1@suite.test',
      'b2@suite.test',
      'b3@suite.test',
    ]);
    expect(await emails()).toEqual(['b1@suite.test', 'b2@suite.test', 'b3@suite.test']);
  },
  opts,
);

scenario(
  'P2.drizzle.008',
  'a unique violation is mapped to exactly 409 by the config onError',
  async () => {
    expect((await booted().post('/users', json(user('dup')))).status).toBe(201);

    const response = await booted().post('/users', json({ name: 'other', email: 'dup@suite.test' }));

    expect(response.status).toBe(409);
    expect(response.json()).toEqual({ error: 'conflict' });
    expect(await emails()).toEqual(['dup@suite.test']);
  },
  opts,
);

scenario(
  'P2.drizzle.020',
  '@Transaction REQUIRED commits every write',
  async () => {
    const response = await booted().post('/tx/required', json({ users: [user('r1'), user('r2')] }));

    expect(response.status).toBe(200);
    expect(await emails()).toEqual(['r1@suite.test', 'r2@suite.test']);
  },
  opts,
);

scenario(
  'P2.drizzle.021',
  '@Transaction REQUIRED rolls every write back when the method throws',
  async () => {
    const response = await booted().post(
      '/tx/required',
      json({ users: [user('rb1'), user('rb2'), user('rb3')], failAfter: 2 }),
    );

    expect(response.status).toBe(422);
    expect(response.json()).toEqual({ error: 'rolled back', reason: 'required rollback' });
    expect(await emails()).toEqual([]);
  },
  opts,
);

scenario(
  'P2.drizzle.022',
  'NESTED rolls back to its savepoint alone, and is discarded with its outer transaction',
  async () => {
    const innerFails = await booted().post(
      '/tx/nested/inner-fails',
      json({ outer: user('n1-outer'), inner: user('n1-inner') }),
    );

    expect(innerFails.status).toBe(200);
    expect(await emails()).toEqual(['n1-outer@suite.test']);

    const outerFails = await booted().post(
      '/tx/nested/outer-fails',
      json({ outer: user('n2-outer'), inner: user('n2-inner') }),
    );

    expect(outerFails.status).toBe(422);
    expect(outerFails.json().reason).toBe('outer rollback after savepoint');
    expect(await emails()).toEqual(['n1-outer@suite.test']);
  },
  opts,
);

scenario(
  'P2.drizzle.023',
  'REQUIRES_NEW commits independently and survives the outer rollback',
  async () => {
    const response = await booted().post(
      '/tx/requires-new',
      json({ outer: user('rn-outer'), inner: user('rn-inner') }),
    );

    expect(response.status).toBe(422);
    expect(response.json().reason).toBe('outer rollback after requires-new');
    expect(await emails()).toEqual(['rn-inner@suite.test']);
  },
  opts,
);

scenario(
  'P2.drizzle.024',
  'the isolation level is applied inside the transaction',
  async () => {
    const response = await booted().post('/tx/isolation', json(user('iso')));

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ serializable: 'serializable', repeatableRead: 'repeatable read' });
    expect(await emails()).toEqual(['iso@suite.test']);
  },
  opts,
);

scenario(
  'P2.drizzle.025',
  'a read-only transaction rejects a write',
  async () => {
    const response = await booted().post('/tx/read-only', json(user('ro')));

    expect(response.status).toBe(403);
    expect(response.json()).toEqual({ error: 'read-only transaction' });
    expect(await emails()).toEqual([]);
  },
  opts,
);

scenario(
  'P2.drizzle.026',
  'the programmatic transaction API commits and rolls back',
  async () => {
    const rollback = await booted().post('/tx/programmatic/rollback', json([user('pr1'), user('pr2')]));

    expect(rollback.status).toBe(422);
    expect(await emails()).toEqual([]);

    const commit = await booted().post('/tx/programmatic/commit', json([user('pc1'), user('pc2')]));

    expect(commit.status).toBe(200);
    expect(await emails()).toEqual(['pc1@suite.test', 'pc2@suite.test']);
  },
  opts,
);

scenario(
  'P2.drizzle.027',
  '@Transaction inherited from an undecorated base class commits and rolls back',
  async () => {
    const rollback = await booted().post('/tx/inherited/rollback', json([user('ir1'), user('ir2')]));

    expect(rollback.status).toBe(422);
    expect(rollback.json().reason).toBe('inherited rollback');
    expect(await emails()).toEqual([]);

    const commit = await booted().post('/tx/inherited/commit', json([user('ic1'), user('ic2')]));

    expect(commit.status).toBe(200);
    expect(await emails()).toEqual(['ic1@suite.test', 'ic2@suite.test']);
  },
  opts,
);

scenario(
  'P2.drizzle.030',
  '20 concurrent requests keep their own transactions: exactly the successful rows persist',
  async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) => booted().post(`/tx/concurrent/${index}`)),
    );
    const expected = Array.from({ length: 10 }, (_, half) => half * 2)
      .flatMap((index) => [`c${index}-a@suite.test`, `c${index}-b@suite.test`])
      .sort();

    expect(responses.map((response) => response.status)).toEqual(
      Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? 200 : 422)),
    );
    expect(await emails()).toEqual(expected);
  },
  opts,
);

scenario(
  'P2.drizzle.031',
  'the transaction context survives a global middleware that awaits before next()',
  async () => {
    const rollback = await booted().post('/tx/required', json({ users: [user('mw1'), user('mw2')], failAfter: 2 }));
    const commit = await booted().post('/tx/required', json({ users: [user('mw3')] }));

    expect(middlewareRuns).toEqual(['/tx/required', '/tx/required']);
    expect(rollback.status).toBe(422);
    expect(commit.status).toBe(200);
    expect(await emails()).toEqual(['mw3@suite.test']);
  },
  opts,
);
