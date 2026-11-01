import type { AsenaContext, AsenaNextHandler } from '@asenajs/asena/adapter';
import { Config, Controller, Middleware, Service } from '@asenajs/asena/decorators';
import { Get, Post } from '@asenajs/asena/decorators/http';
import { Inject } from '@asenajs/asena/decorators/ioc';
import { AsenaMiddlewareService } from '@asenajs/asena/middleware';
import type { AsenaConfig } from '@asenajs/asena/server/config';
import { silentLogger } from '@asenajs/asena/test';
import {
  AsenaDatabaseService,
  BaseRepository,
  Database,
  Drizzle,
  Repository,
  Transaction,
  TransactionPostProcessor,
} from '@asenajs/asena-drizzle';
import { asc, eq, sql } from 'drizzle-orm';
import { type SuiteUsers, suiteUsers } from './schema.ts';

type Ctx = AsenaContext<any, any>;
type Component = new (...args: any[]) => unknown;

export interface UserPayload {
  name: string;
  email: string;
  tag?: string;
}

export class RollbackSignal extends Error {}

const UNIQUE_VIOLATION = '23505';
const READ_ONLY_TRANSACTION = '25006';

function pgCode(error: unknown): string | undefined {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;

    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

function rollbackSignal(error: unknown): RollbackSignal | undefined {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    if (current instanceof RollbackSignal) return current;
    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

export interface DrizzleFixture {
  components: Component[];
  middlewareRuns: string[];
}

export function drizzleFixture(connectionString: string): DrizzleFixture {
  const middlewareRuns: string[] = [];

  @Database(() => ({
    type: 'postgresql',
    config: { connectionString, pool: { max: 30 } },
    drizzleConfig: { schema: { suiteUsers } },
    logger: silentLogger,
  }))
  class SuiteDatabase extends AsenaDatabaseService {}

  @Drizzle({ defaultDb: 'SuiteDatabase' })
  class SuiteDrizzle extends TransactionPostProcessor {}

  @Repository({ databaseService: 'SuiteDatabase', table: suiteUsers })
  class SuiteUserRepository extends BaseRepository<SuiteUsers> {
    public findByEmail(email: string) {
      return this.findOne(eq(suiteUsers.email, email));
    }

    public async show(setting: 'transaction_isolation' | 'transaction_read_only'): Promise<string> {
      const result = await this.db.execute(sql.raw(`SHOW ${setting}`));

      return (result as { rows: Record<string, string>[] }).rows[0][setting];
    }
  }

  abstract class UnitOfWorkBase {
    @Inject('SuiteUserRepository')
    protected repo!: SuiteUserRepository;

    @Transaction()
    public async inheritedRollback(users: UserPayload[]) {
      for (const user of users) await this.repo.create(user);

      throw new RollbackSignal('inherited rollback');
    }

    @Transaction()
    public async inheritedCommit(users: UserPayload[]) {
      for (const user of users) await this.repo.create(user);
    }
  }

  @Service('SuiteTxService')
  class SuiteTxService extends UnitOfWorkBase {
    @Transaction()
    public async required(users: UserPayload[], failAfter?: number) {
      let inserted = 0;

      for (const user of users) {
        await this.repo.create(user);

        if (++inserted === failAfter) throw new RollbackSignal('required rollback');
      }
    }

    @Transaction()
    public async nestedInnerFails(outer: UserPayload, inner: UserPayload) {
      await this.repo.create(outer);

      try {
        await this.nestedInner(inner, true);
      } catch (error) {
        if (!(error instanceof RollbackSignal)) throw error;
      }
    }

    @Transaction()
    public async nestedOuterFails(outer: UserPayload, inner: UserPayload) {
      await this.repo.create(outer);
      await this.nestedInner(inner, false);

      throw new RollbackSignal('outer rollback after savepoint');
    }

    @Transaction({ propagation: 'NESTED' })
    public async nestedInner(user: UserPayload, fail: boolean) {
      await this.repo.create(user);

      if (fail) throw new RollbackSignal('savepoint rollback');
    }

    @Transaction()
    public async requiresNewOuter(outer: UserPayload, inner: UserPayload) {
      await this.repo.create(outer);
      await this.requiresNewInner(inner);

      throw new RollbackSignal('outer rollback after requires-new');
    }

    @Transaction({ propagation: 'REQUIRES_NEW' })
    public async requiresNewInner(user: UserPayload) {
      await this.repo.create(user);
    }

    @Transaction({ isolationLevel: 'serializable' })
    public async serializable(user: UserPayload) {
      await this.repo.create(user);

      return this.repo.show('transaction_isolation');
    }

    @Transaction({ isolationLevel: 'repeatable read' })
    public async repeatableRead() {
      return this.repo.show('transaction_isolation');
    }

    @Transaction({ accessMode: 'read only' })
    public async readOnlyWrite(user: UserPayload) {
      await this.repo.create(user);
    }

    public async programmatic(users: UserPayload[], fail: boolean) {
      await this.repo.transaction(async (tx) => {
        for (const user of users) await (tx as any).insert(suiteUsers).values(user);

        if (fail) throw new RollbackSignal('programmatic rollback');
      });
    }

    @Transaction()
    public async concurrent(index: number) {
      await this.repo.create({ name: `c${index}-a`, email: `c${index}-a@suite.test`, tag: 'concurrent' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await this.repo.create({ name: `c${index}-b`, email: `c${index}-b@suite.test`, tag: 'concurrent' });

      if (index % 2 === 1) throw new RollbackSignal(`concurrent ${index} rollback`);
    }
  }

  @Controller('/users')
  class SuiteUserController {
    @Inject('SuiteUserRepository')
    private repo!: SuiteUserRepository;

    @Post('/')
    public async create(context: Ctx) {
      return context.send(await this.repo.create(await context.getBody<UserPayload>()), 201);
    }

    @Post('/bulk')
    public async bulk(context: Ctx) {
      return context.send(await this.repo.createMany(await context.getBody<UserPayload[]>()), 201);
    }

    @Get('/by-id/:id')
    public async byId(context: Ctx) {
      const user = await this.repo.findById(context.getParam('id'));

      return user ? context.send(user) : context.send({ error: 'not found' }, 404);
    }

    @Get('/by-email/:email')
    public async byEmail(context: Ctx) {
      const user = await this.repo.findByEmail(context.getParam('email'));

      return user ? context.send(user) : context.send({ error: 'not found' }, 404);
    }

    @Get('/page')
    public async page(context: Ctx) {
      const page = Number(await context.getQuery('page'));
      const limit = Number(await context.getQuery('limit'));

      return context.send(await this.repo.paginate(page, limit, undefined, asc(suiteUsers.name)));
    }

    @Get('/count')
    public async count(context: Ctx) {
      return context.send({ count: await this.repo.count() });
    }
  }

  @Controller('/tx')
  class SuiteTxController {
    @Inject('SuiteTxService')
    private tx!: SuiteTxService;

    @Post('/required')
    public async required(context: Ctx) {
      const { users, failAfter } = await context.getBody<{ users: UserPayload[]; failAfter?: number }>();

      await this.tx.required(users, failAfter);

      return context.send({ ok: true });
    }

    @Post('/nested/:which')
    public async nested(context: Ctx) {
      const { outer, inner } = await context.getBody<{ outer: UserPayload; inner: UserPayload }>();

      if (context.getParam('which') === 'inner-fails') await this.tx.nestedInnerFails(outer, inner);
      else await this.tx.nestedOuterFails(outer, inner);

      return context.send({ ok: true });
    }

    @Post('/requires-new')
    public async requiresNew(context: Ctx) {
      const { outer, inner } = await context.getBody<{ outer: UserPayload; inner: UserPayload }>();

      await this.tx.requiresNewOuter(outer, inner);

      return context.send({ ok: true });
    }

    @Post('/isolation')
    public async isolation(context: Ctx) {
      const serializable = await this.tx.serializable(await context.getBody<UserPayload>());

      return context.send({ serializable, repeatableRead: await this.tx.repeatableRead() });
    }

    @Post('/read-only')
    public async readOnly(context: Ctx) {
      await this.tx.readOnlyWrite(await context.getBody<UserPayload>());

      return context.send({ ok: true });
    }

    @Post('/programmatic/:outcome')
    public async programmatic(context: Ctx) {
      const users = await context.getBody<UserPayload[]>();

      await this.tx.programmatic(users, context.getParam('outcome') === 'rollback');

      return context.send({ ok: true });
    }

    @Post('/inherited/:outcome')
    public async inherited(context: Ctx) {
      const users = await context.getBody<UserPayload[]>();

      if (context.getParam('outcome') === 'rollback') await this.tx.inheritedRollback(users);
      else await this.tx.inheritedCommit(users);

      return context.send({ ok: true });
    }

    @Post('/concurrent/:index')
    public async concurrent(context: Ctx) {
      await this.tx.concurrent(Number(context.getParam('index')));

      return context.send({ ok: true });
    }
  }

  @Middleware()
  class AwaitingGlobalMiddleware extends AsenaMiddlewareService {
    public async handle(context: Ctx, next: AsenaNextHandler) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      middlewareRuns.push(new URL((context.req as { url: string }).url).pathname);
      await next();
    }
  }

  @Config()
  class SuiteDrizzleConfig implements AsenaConfig {
    public globalMiddlewares() {
      return [AwaitingGlobalMiddleware];
    }

    public onError(error: Error, context: Ctx) {
      const signal = rollbackSignal(error);

      if (signal) return context.send({ error: 'rolled back', reason: signal.message }, 422);

      switch (pgCode(error)) {
        case UNIQUE_VIOLATION:
          return context.send({ error: 'conflict' }, 409);
        case READ_ONLY_TRANSACTION:
          return context.send({ error: 'read-only transaction' }, 403);
        default:
          return context.send({ error: 'internal' }, 500);
      }
    }
  }

  const components = [
    SuiteDatabase,
    SuiteDrizzle,
    SuiteUserRepository,
    SuiteTxService,
    SuiteUserController,
    SuiteTxController,
    AwaitingGlobalMiddleware,
    SuiteDrizzleConfig,
  ];

  return { components, middlewareRuns };
}
