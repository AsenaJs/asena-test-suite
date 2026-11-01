import type { AsenaContext, AsenaNextHandler } from '@asenajs/asena/adapter';
import { Component, Controller, Middleware, Service } from '@asenajs/asena/decorators';
import { Delete, Get, Post, Put } from '@asenajs/asena/decorators/http';
import { Inject } from '@asenajs/asena/decorators/ioc';
import { AsenaMiddlewareService } from '@asenajs/asena/middleware';
import { silentLogger } from '@asenajs/asena/test';
import { AsenaDatabaseService, BaseRepository, Database, Repository } from '@asenajs/asena-drizzle';
import { AsenaRedisService, Redis } from '@asenajs/asena-redis';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

type Ctx = AsenaContext<any, any>;
type ComponentClass = new (...args: any[]) => unknown;

export const PROTECTED_TOKEN = 'otel-extended-token';

export const tracedItems = pgTable('traced_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
});

export function createItemsSql(schema: string): string {
  return `CREATE TABLE IF NOT EXISTS "${schema}".traced_items (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL)`;
}

export interface ExtendedOptions {
  postgresUrl: string;
  redisUrl: string;
  keyPrefix: string;
}

export function extendedComponents({ postgresUrl, redisUrl, keyPrefix }: ExtendedOptions): ComponentClass[] {
  @Database(() => ({
    type: 'postgresql',
    config: { connectionString: postgresUrl },
    drizzleConfig: { schema: { tracedItems } },
    logger: silentLogger,
  }))
  class TracedDatabase extends AsenaDatabaseService {}

  @Repository({ databaseService: 'TracedDatabase', table: tracedItems })
  class TracedItemRepository extends BaseRepository<typeof tracedItems> {}

  @Redis(() => ({ config: { url: redisUrl }, logger: silentLogger }))
  class TracedRedis extends AsenaRedisService {}

  @Service('TracedCacheService')
  class TracedCacheService {
    @Inject(TracedRedis)
    private redis!: TracedRedis;

    public async getOrSet(key: string, factory: () => Promise<string>): Promise<string> {
      const cached = await this.redis.get(key);

      if (cached !== null) return cached;

      const value = await factory();

      await this.redis.set(key, value, 60);

      return value;
    }
  }

  @Component('TracedUtility')
  class TracedUtility {
    public stamp(value: string): string {
      return `stamped:${value}`;
    }
  }

  @Middleware()
  class TracedGuard extends AsenaMiddlewareService {
    public async handle(context: Ctx, next: AsenaNextHandler) {
      if (context.headers['x-token'] !== PROTECTED_TOKEN) return context.send({ error: 'unauthorized' }, 401);

      await next();
    }
  }

  @Controller('/items')
  class TracedItemController {
    @Inject('TracedItemRepository')
    private items!: TracedItemRepository;

    @Post('/')
    public async create(context: Ctx) {
      return context.send(await this.items.create(await context.getBody<{ name: string }>()), 201);
    }

    @Get('/')
    public async list(context: Ctx) {
      return context.send(await this.items.findAll());
    }

    @Put('/:id')
    public async update(context: Ctx) {
      return context.send(
        (await this.items.updateById(context.getParam('id'), await context.getBody<{ name: string }>())) ?? null,
      );
    }

    @Delete('/:id')
    public async remove(context: Ctx) {
      return context.send({ deleted: await this.items.deleteById(context.getParam('id')) });
    }
  }

  @Controller('/cached')
  class TracedCacheController {
    @Inject('TracedCacheService')
    private cache!: TracedCacheService;

    @Inject(TracedRedis)
    private redis!: TracedRedis;

    @Get('/:name')
    public async compute(context: Ctx) {
      const key = `${keyPrefix}${context.getParam('name')}`;

      return context.send({ value: await this.cache.getOrSet(key, async () => 'computed') });
    }

    @Post('/raw/:name')
    public async raw(context: Ctx) {
      const key = `${keyPrefix}raw:${context.getParam('name')}`;

      await this.redis.set(key, 'raw-value');

      return context.send({ value: await this.redis.get(key) });
    }
  }

  @Controller('/guarded')
  class TracedGuardedController {
    @Inject('TracedUtility')
    private utility!: TracedUtility;

    @Get({ path: '/data', middlewares: [TracedGuard] })
    public data(context: Ctx) {
      return context.send({ data: this.utility.stamp('secret') });
    }
  }

  return [
    TracedDatabase,
    TracedItemRepository,
    TracedRedis,
    TracedCacheService,
    TracedUtility,
    TracedGuard,
    TracedItemController,
    TracedCacheController,
    TracedGuardedController,
  ];
}
