import { afterAll, expect } from 'bun:test';
import type { TestApp } from '@asenajs/asena/test';
import { bootApp, scenario } from '@asenajs/adapter-conformance';
import { waitFor } from '@asenajs/adapter-conformance/helpers';
import { cleanupNamespace, redisPrefix, trackRedisPrefix } from '../../src/namespace.ts';
import { assertReachable } from '../../src/services.ts';
import { REDIS_SERVICE, redisFixture } from './fixtures/redis.ts';
import type { AsenaRedisService } from '@asenajs/asena-redis';

const reachable = await assertReachable('redis');
const url = process.env.ASENA_SUITE_REDIS_URL ?? '';
const prefix = `${redisPrefix()}redis:`;

if (reachable) trackRedisPrefix(url, prefix);

afterAll(cleanupNamespace);

const opts = { services: ['redis' as const] };

async function boot(): Promise<{ app: TestApp; redis: AsenaRedisService; probe: { factoryCalls: number } }> {
  const fixture = redisFixture(url, prefix);
  const app = await bootApp({ components: fixture.components });

  return { app, redis: await app.resolve<AsenaRedisService>(REDIS_SERVICE), probe: fixture.probe };
}

async function clientNames(): Promise<string[]> {
  const client = new Bun.RedisClient(url);

  try {
    const list = String(await client.send('CLIENT', ['LIST']));

    return [...list.matchAll(/\bname=(\S*)/g)].map((match) => match[1]);
  } finally {
    client.close();
  }
}

scenario(
  'P2.redis.001',
  'string set/get/del/incr/decr/exists',
  async () => {
    const { app, redis } = await boot();
    await using _ = app;
    const key = `${prefix}s001:str`;
    const counter = `${prefix}s001:counter`;

    await redis.set(key, 'hello');
    expect(await redis.get(key)).toBe('hello');
    expect(await redis.exists(key)).toBe(true);
    expect(await redis.del(key)).toBe(1);
    expect(await redis.exists(key)).toBe(false);
    expect(await redis.get(key)).toBeNull();

    await redis.set(counter, '10');
    expect(await redis.incr(counter)).toBe(11);
    expect(await redis.decr(counter)).toBe(10);
    expect(await redis.decr(counter)).toBe(9);
  },
  opts,
);

scenario(
  'P2.redis.002',
  'set with ttl and expire give a ttl in (0, n]',
  async () => {
    const { app, redis } = await boot();
    await using _ = app;
    const withTtl = `${prefix}s002:ttl`;
    const expiring = `${prefix}s002:expire`;

    await redis.set(withTtl, 'v', 10);
    await redis.set(expiring, 'v');
    expect(await redis.ttl(expiring)).toBe(-1);
    expect(await redis.expire(expiring, 30)).toBe(1);

    const ttl = await redis.ttl(withTtl);
    const expireTtl = await redis.ttl(expiring);

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10);
    expect(expireTtl).toBeGreaterThan(0);
    expect(expireTtl).toBeLessThanOrEqual(30);
  },
  opts,
);

scenario(
  'P2.redis.003',
  'hash hmset/hget/hmget',
  async () => {
    const { app, redis } = await boot();
    await using _ = app;
    const key = `${prefix}s003:hash`;

    await redis.hmset(key, ['name', 'Ada', 'role', 'admin']);
    expect(await redis.hget(key, 'name')).toBe('Ada');
    expect(await redis.hget(key, 'missing')).toBeNull();
    expect(await redis.hmget(key, ['role', 'name', 'missing'])).toEqual(['admin', 'Ada', null]);
  },
  opts,
);

scenario(
  'P2.redis.004',
  'set sadd/srem/smembers/sismember',
  async () => {
    const { app, redis } = await boot();
    await using _ = app;
    const key = `${prefix}s004:set`;

    expect(await redis.sadd(key, 'a')).toBe(1);
    expect(await redis.sadd(key, 'b')).toBe(1);
    expect(await redis.sadd(key, 'a')).toBe(0);
    expect((await redis.smembers(key)).sort()).toEqual(['a', 'b']);
    expect(await redis.sismember(key, 'a')).toBe(true);
    expect(await redis.srem(key, 'a')).toBe(1);
    expect(await redis.sismember(key, 'a')).toBe(false);
    expect(await redis.smembers(key)).toEqual(['b']);
  },
  opts,
);

scenario(
  'P2.redis.005',
  'keys by pattern stay inside the run namespace',
  async () => {
    const { app, redis } = await boot();
    await using _ = app;

    await redis.set(`${prefix}s005:keys:a`, '1');
    await redis.set(`${prefix}s005:keys:b`, '2');
    await redis.set(`${prefix}s005:other`, '3');

    expect((await redis.keys(`${prefix}s005:keys:*`)).sort()).toEqual([`${prefix}s005:keys:a`, `${prefix}s005:keys:b`]);
    expect((await redis.keys(`${prefix}s005:*`)).sort()).toEqual([
      `${prefix}s005:keys:a`,
      `${prefix}s005:keys:b`,
      `${prefix}s005:other`,
    ]);
  },
  opts,
);

scenario(
  'P2.redis.010',
  'CacheService.getOrSet on a miss calls the factory once and stores the value',
  async () => {
    const { app, redis, probe } = await boot();
    await using _ = app;
    const response = await app.get('/cache/computed/s010');

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ data: 'computed', call: 1 });
    expect(probe.factoryCalls).toBe(1);
    expect(await redis.get(`${prefix}cache:s010`)).toBe(JSON.stringify({ data: 'computed', call: 1 }));
  },
  opts,
);

scenario(
  'P2.redis.011',
  'CacheService.getOrSet on a hit does not call the factory again',
  async () => {
    const { app, probe } = await boot();
    await using _ = app;
    const first = await app.get('/cache/computed/s011');
    const second = await app.get('/cache/computed/s011');

    expect(first.json()).toEqual({ data: 'computed', call: 1 });
    expect(second.status).toBe(200);
    expect(second.json()).toEqual({ data: 'computed', call: 1 });
    expect(probe.factoryCalls).toBe(1);
  },
  opts,
);

scenario(
  'P2.redis.012',
  'CacheService.invalidate makes the next getOrSet call the factory again',
  async () => {
    const { app, probe } = await boot();
    await using _ = app;

    expect((await app.get('/cache/computed/s012')).json()).toEqual({ data: 'computed', call: 1 });
    expect((await app.post('/cache/invalidate/s012')).status).toBe(200);
    expect((await app.get('/cache/computed/s012')).json()).toEqual({ data: 'computed', call: 2 });
    expect(probe.factoryCalls).toBe(2);
  },
  opts,
);

scenario(
  'P2.redis.020',
  'the @Redis component connects through the env URL and disconnects when the app stops',
  async () => {
    const { app, redis } = await boot();
    const name = `${prefix.replace(/:/g, '_')}s020`;
    let stopped = false;

    try {
      const client = redis.client;

      expect(await redis.ping()).toBe('PONG');
      expect(await redis.send('CLIENT', ['SETNAME', name])).toBe('OK');
      expect((await clientNames()).filter((entry) => entry === name)).toHaveLength(1);

      await app.stop();
      stopped = true;

      expect(client.isConnected).toBe(false);
      await waitFor(async () => !(await clientNames()).includes(name), { timeout: 2000, label: 'named client gone' });
      expect((await clientNames()).filter((entry) => entry === name)).toHaveLength(0);
    } finally {
      if (!stopped) await app.stop();
    }
  },
  opts,
);
