import { afterAll, expect } from 'bun:test';
import { scenario } from '@asenajs/adapter-conformance';
import { randomPort } from '@asenajs/adapter-conformance/helpers';
import {
  cleanupNamespace,
  dropRedisPrefix,
  kafkaTopic,
  pgSchema,
  redisPrefix,
  runNamespace,
  trackRedisPrefix,
} from '../src/namespace.ts';
import { assertReachable, serviceConfig, serviceEndpoints } from '../src/services.ts';

async function closedPort(): Promise<number> {
  for (;;) {
    const port = randomPort();

    try {
      const probe = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } });

      probe.stop(true);

      return port;
    } catch {
      // taken; draw again
    }
  }
}

await assertReachable('redis');
await assertReachable('postgres');

afterAll(cleanupNamespace);

scenario('P2.services.001', 'serviceConfig reads the three service variables and require mode', () => {
  const config = serviceConfig({
    ASENA_SUITE_REDIS_URL: 'redis://cache:6380',
    ASENA_SUITE_POSTGRES_URL: 'postgres://u:p@db:5433/suite',
    ASENA_SUITE_KAFKA_BROKERS: ' k1:9092 , k2:9093 ,',
    ASENA_SUITE_REQUIRE_SERVICES: '1',
  });

  expect(config).toEqual({
    redisUrl: 'redis://cache:6380',
    postgresUrl: 'postgres://u:p@db:5433/suite',
    kafkaBrokers: ['k1:9092', 'k2:9093'],
    requireServices: true,
  });
  expect(serviceConfig({ ASENA_SUITE_REDIS_URL: '  ', ASENA_SUITE_REQUIRE_SERVICES: 'true' })).toEqual({
    redisUrl: undefined,
    postgresUrl: undefined,
    kafkaBrokers: undefined,
    requireServices: false,
  });
});

scenario('P2.services.002', 'endpoints come from the URL or broker list with default ports', () => {
  const config = serviceConfig({
    ASENA_SUITE_REDIS_URL: 'redis://localhost',
    ASENA_SUITE_POSTGRES_URL: 'postgres://u:p@db:5433/suite',
    ASENA_SUITE_KAFKA_BROKERS: 'k1:19092,k2',
  });

  expect(serviceEndpoints('redis', config)).toEqual([{ host: 'localhost', port: 6379 }]);
  expect(serviceEndpoints('postgres', config)).toEqual([{ host: 'db', port: 5433 }]);
  expect(serviceEndpoints('kafka', config)).toEqual([
    { host: 'k1', port: 19092 },
    { host: 'k2', port: 9092 },
  ]);
  expect(serviceEndpoints('redis', serviceConfig({}))).toEqual([]);
});

scenario('P2.services.003', 'skip mode: an unreachable service is unset with a reason and reported false', async () => {
  const port = await closedPort();
  const env: Record<string, string | undefined> = { ASENA_SUITE_REDIS_URL: `redis://127.0.0.1:${port}` };
  const lines: string[] = [];

  expect(await assertReachable('redis', { env, log: (line) => lines.push(line), timeoutMs: 500 })).toBe(false);
  expect(env.ASENA_SUITE_REDIS_URL).toBeUndefined();
  expect(lines).toEqual([
    `[services] redis: 127.0.0.1:${port} from ASENA_SUITE_REDIS_URL is unreachable; its scenarios are skipped with [svc:redis]`,
  ]);
  expect(await assertReachable('postgres', { env: {}, log: (line) => lines.push(line) })).toBe(false);
  expect(lines).toHaveLength(1);
});

scenario('P2.services.004', 'require mode: an unreachable or unset service throws', async () => {
  const port = await closedPort();

  const unreachable = await assertReachable('kafka', {
    env: { ASENA_SUITE_KAFKA_BROKERS: `127.0.0.1:${port}`, ASENA_SUITE_REQUIRE_SERVICES: '1' },
    timeoutMs: 500,
  }).catch((error: unknown) => error);
  const unset = await assertReachable('postgres', { env: { ASENA_SUITE_REQUIRE_SERVICES: '1' } }).catch(
    (error: unknown) => error,
  );

  expect(unreachable).toBeInstanceOf(Error);
  expect((unreachable as Error).message).toBe(
    `kafka: 127.0.0.1:${port} from ASENA_SUITE_KAFKA_BROKERS is unreachable (ASENA_SUITE_REQUIRE_SERVICES=1)`,
  );
  expect(unset).toBeInstanceOf(Error);
  expect((unset as Error).message).toBe(
    'postgres: ASENA_SUITE_REQUIRE_SERVICES=1 but ASENA_SUITE_POSTGRES_URL is not set',
  );
});

scenario('P2.services.005', 'a reachable service is reported true and stays set', async () => {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const env: Record<string, string | undefined> = { ASENA_SUITE_REDIS_URL: `redis://127.0.0.1:${server.port}` };

  try {
    expect(await assertReachable('redis', { env, log: () => {} })).toBe(true);
    expect(env.ASENA_SUITE_REDIS_URL).toBe(`redis://127.0.0.1:${server.port}`);
  } finally {
    server.stop(true);
  }
});

scenario('P2.services.006', 'the run namespace is per process and safe as a schema, key and topic prefix', () => {
  const ns = runNamespace();

  expect(ns).toMatch(new RegExp(`^asena_[a-z0-9_]+_${process.pid}_[a-z0-9]{6}$`));
  expect(runNamespace()).toBe(ns);
  expect(redisPrefix()).toBe(`${ns}:`);
  expect(kafkaTopic(ns, 'orders')).toBe(`${ns}.orders`);
  expect(pgSchema('postgres://u:p@db:5432/suite', ns).url).toBe(
    `postgres://u:p@db:5432/suite?options=-c+search_path%3D${ns}`,
  );
});

scenario(
  'P2.services.007',
  'a tracked Redis prefix is removed by cleanupNamespace and other keys survive',
  async () => {
    const url = process.env.ASENA_SUITE_REDIS_URL!;
    const { createClient } = await import('redis');
    const client = createClient({ url });
    const prefix = `${runNamespace()}_007:`;
    const outside = `${runNamespace()}_007_outside`;

    await client.connect();

    try {
      trackRedisPrefix(url, prefix);
      await client.set(`${prefix}a`, '1');
      await client.set(`${prefix}b`, '2');
      await client.set(outside, '3');

      await cleanupNamespace();

      expect(await client.exists([`${prefix}a`, `${prefix}b`])).toBe(0);
      expect(await client.get(outside)).toBe('3');
    } finally {
      await dropRedisPrefix(url, outside);
      client.destroy();
    }
  },
  { services: ['redis'] },
);

scenario(
  'P2.services.008',
  'a created Postgres schema is the search_path of its URL and is dropped by cleanupNamespace',
  async () => {
    const base = process.env.ASENA_SUITE_POSTGRES_URL!;
    const { Client } = (await import('pg')).default;
    const schema = pgSchema(base, `${runNamespace()}_008`);
    const exists = async (): Promise<boolean> => {
      const client = new Client({ connectionString: base });

      await client.connect();

      try {
        const result = await client.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [
          schema.schema,
        ]);

        return result.rowCount === 1;
      } finally {
        await client.end();
      }
    };

    await schema.create();
    expect(await exists()).toBe(true);

    const scoped = new Client({ connectionString: schema.url });

    await scoped.connect();

    try {
      const result = await scoped.query<{ schema: string }>('SELECT current_schema() AS schema');

      expect(result.rows[0]?.schema).toBe(schema.schema);
    } finally {
      await scoped.end();
    }

    await cleanupNamespace();
    expect(await exists()).toBe(false);
  },
  { services: ['postgres'] },
);
