import type { AsenaContext } from '@asenajs/asena/adapter';
import { Controller, Service } from '@asenajs/asena/decorators';
import { Get, Post } from '@asenajs/asena/decorators/http';
import { Inject } from '@asenajs/asena/decorators/ioc';
import { silentLogger } from '@asenajs/asena/test';
import { AsenaRedisService, Redis } from '@asenajs/asena-redis';

type Component = new (...args: any[]) => unknown;

export const REDIS_SERVICE = 'SuiteRedis';

export interface CacheProbe {
  factoryCalls: number;
}

export interface RedisFixture {
  components: Component[];
  probe: CacheProbe;
}

export function redisFixture(url: string, prefix: string): RedisFixture {
  const probe: CacheProbe = { factoryCalls: 0 };

  @Redis(() => ({ config: { url }, logger: silentLogger }))
  class SuiteRedis extends AsenaRedisService {}

  @Service('SuiteCache')
  class SuiteCache {
    @Inject(SuiteRedis)
    private redis!: SuiteRedis;

    public async getOrSet<T>(key: string, ttl: number, factory: () => Promise<T>): Promise<T> {
      const cached = await this.redis.get(key);

      if (cached !== null) return JSON.parse(cached) as T;

      const value = await factory();

      await this.redis.set(key, JSON.stringify(value), ttl);

      return value;
    }

    public async invalidate(key: string): Promise<void> {
      await this.redis.del(key);
    }
  }

  @Controller('/cache')
  class SuiteCacheController {
    @Inject('SuiteCache')
    private cache!: SuiteCache;

    @Get('/computed/:name')
    public async computed(context: AsenaContext<any, any>) {
      const key = `${prefix}cache:${context.getParam('name')}`;
      const value = await this.cache.getOrSet(key, 60, async () => {
        probe.factoryCalls++;

        return { data: 'computed', call: probe.factoryCalls };
      });

      return context.send(value);
    }

    @Post('/invalidate/:name')
    public async invalidate(context: AsenaContext<any, any>) {
      await this.cache.invalidate(`${prefix}cache:${context.getParam('name')}`);

      return context.send({ ok: true });
    }
  }

  return { components: [SuiteRedis, SuiteCache, SuiteCacheController], probe };
}
