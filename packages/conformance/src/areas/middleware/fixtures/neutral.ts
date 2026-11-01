import { AsyncLocalStorage } from 'node:async_hooks';
import type { AsenaContext, AsenaNextHandler, RequestSchema } from '@asenajs/asena/adapter';
import { Config, Controller, Middleware, Service } from '@asenajs/asena/decorators';
import { Delete, Get, Post } from '@asenajs/asena/decorators/http';
import { Inject } from '@asenajs/asena/decorators/ioc';
import { AsenaMiddlewareService } from '@asenajs/asena/middleware';
import type { AsenaConfig } from '@asenajs/asena/server/config';

type Ctx = AsenaContext<any, any>;
type Component = new (...args: any[]) => unknown;

export const TOKEN = 'Bearer mw-ok';

export interface PatternFixture {
  components: Component[];
  stamped: string[];
}

export function globalPatternFixture(): PatternFixture {
  const stamped: string[] = [];

  @Middleware()
  class MiddlewareTokenGuard extends AsenaMiddlewareService {
    public async handle(context: Ctx, next: AsenaNextHandler) {
      if (context.headers.authorization !== TOKEN) return context.send({ error: 'unauthorized' }, 401);

      await next();
    }
  }

  @Middleware()
  class MiddlewareStamp extends AsenaMiddlewareService {
    public async handle(context: Ctx, next: AsenaNextHandler) {
      stamped.push(new URL((context.req as { url: string }).url).pathname);
      await next();
    }
  }

  @Controller('/')
  class MiddlewarePatternController {
    @Get('/api/protected/data')
    public protectedData(context: Ctx) {
      return context.send({ data: 'protected' });
    }

    @Get('/api/public/data')
    public publicData(context: Ctx) {
      return context.send({ data: 'public' });
    }

    @Get('/health')
    public health(context: Ctx) {
      return context.send({ status: 'ok' });
    }
  }

  @Config()
  class MiddlewarePatternConfig implements AsenaConfig {
    public globalMiddlewares() {
      return [
        { middleware: MiddlewareTokenGuard, routes: { include: ['/api/protected/*'] } },
        { middleware: MiddlewareStamp, routes: { exclude: ['/health'] } },
      ];
    }
  }

  return {
    components: [MiddlewarePatternController, MiddlewareTokenGuard, MiddlewareStamp, MiddlewarePatternConfig],
    stamped,
  };
}

export interface OrderFixture {
  components: Component[];
  order: string[];
}

/** Global, controller and route middlewares that append their label to `order`. */
export function orderMiddlewares(order: string[]) {
  @Middleware()
  class MiddlewareOrderGlobal extends AsenaMiddlewareService {
    public async handle(_context: Ctx, next: AsenaNextHandler) {
      order.push('global');
      await next();
    }
  }

  @Middleware()
  class MiddlewareOrderController extends AsenaMiddlewareService {
    public async handle(_context: Ctx, next: AsenaNextHandler) {
      order.push('controller');
      await next();
    }
  }

  @Middleware()
  class MiddlewareOrderRoute extends AsenaMiddlewareService {
    public async handle(_context: Ctx, next: AsenaNextHandler) {
      order.push('route');
      await next();
    }
  }

  @Config()
  class MiddlewareOrderConfig implements AsenaConfig {
    public globalMiddlewares() {
      return [MiddlewareOrderGlobal];
    }
  }

  return {
    Controller: MiddlewareOrderController,
    Route: MiddlewareOrderRoute,
    components: [MiddlewareOrderGlobal, MiddlewareOrderController, MiddlewareOrderRoute, MiddlewareOrderConfig],
  };
}

function nameSchema(): RequestSchema<unknown, { name: string }> {
  return {
    '~standard': {
      version: 1,
      vendor: 'asena-suite',
      validate: (value) => {
        const name = (value as { name?: unknown } | null)?.name;

        return typeof name === 'string' && name.length > 0
          ? { value: { name } }
          : { issues: [{ message: 'Expected a non-empty string', path: ['name'] }] };
      },
    },
  };
}

export function contractOrderFixture(define: (schemas: object) => new (...args: any[]) => unknown): OrderFixture {
  const order: string[] = [];
  const chain = orderMiddlewares(order);
  const Base = define({ body: nameSchema() }) as new (...args: any[]) => Ctx;

  class MiddlewareOrderContext extends Base {}

  @Controller({ path: '/mw-order-contract', middlewares: [chain.Controller] })
  class MiddlewareContractOrderController {
    @Post({ path: '/run', middlewares: [chain.Route] })
    public run(context: MiddlewareOrderContext) {
      order.push('handler');

      return context.send({ ok: true });
    }
  }

  return { components: [MiddlewareContractOrderController, ...chain.components], order };
}

export interface InheritanceFixture {
  components: Component[];
}

export function inheritedClassMiddlewareFixture(): InheritanceFixture {
  @Middleware()
  class MiddlewareClassGuard extends AsenaMiddlewareService {
    public async handle(context: Ctx, next: AsenaNextHandler) {
      if (context.headers.authorization !== TOKEN) return context.send({ error: 'unauthorized' }, 401);

      await next();
    }
  }

  @Controller({ path: '/mw-reports/v1', middlewares: [MiddlewareClassGuard] })
  class MiddlewareReportsV1Controller {
    @Get('/summary')
    public summary(context: Ctx) {
      return context.send({ route: 'summary', servedBy: this.constructor.name });
    }
  }

  @Controller('/mw-reports/v2')
  class MiddlewareReportsV2Controller extends MiddlewareReportsV1Controller {
    @Get('/extra')
    public extra(context: Ctx) {
      return context.send({ route: 'extra', servedBy: this.constructor.name });
    }
  }

  return { components: [MiddlewareReportsV1Controller, MiddlewareReportsV2Controller, MiddlewareClassGuard] };
}

export function siblingGuardFixture(): InheritanceFixture {
  @Middleware()
  class MiddlewareReadGuard extends AsenaMiddlewareService {
    public async handle(context: Ctx, next: AsenaNextHandler) {
      if (context.headers['x-read-token'] !== 'read-ok') return context.send({ error: 'read token required' }, 401);

      await next();
    }
  }

  @Middleware()
  class MiddlewareAdminGuard extends AsenaMiddlewareService {
    public async handle(context: Ctx, next: AsenaNextHandler) {
      if (context.headers['x-admin-token'] !== 'admin-ok') {
        return context.send({ error: 'admin token required' }, 401);
      }

      await next();
    }
  }

  @Controller('/mw-items')
  class MiddlewareSiblingController {
    @Get({ path: '/:id', middlewares: [MiddlewareReadGuard] })
    public read(context: Ctx) {
      return context.send({ action: 'read', id: context.getParam('id') });
    }

    @Delete({ path: '/:id', middlewares: [MiddlewareAdminGuard] })
    public remove(context: Ctx) {
      return context.send({ action: 'delete', id: context.getParam('id') });
    }
  }

  return { components: [MiddlewareSiblingController, MiddlewareReadGuard, MiddlewareAdminGuard] };
}

export interface UndecoratedFixture {
  components: Component[];
  ran: string[];
}

export function undecoratedGuardFixture(): UndecoratedFixture {
  const ran: string[] = [];

  @Middleware()
  class MiddlewareBaseGuard extends AsenaMiddlewareService {
    public async handle(_context: Ctx, next: AsenaNextHandler) {
      ran.push('base');
      await next();
    }
  }

  class MiddlewareUndecoratedGuard extends MiddlewareBaseGuard {
    public override async handle(_context: Ctx, next: AsenaNextHandler) {
      ran.push('undecorated');
      await next();
    }
  }

  @Controller('/mw-undecorated')
  class MiddlewareUndecoratedController {
    @Get({ path: '/danger', middlewares: [MiddlewareUndecoratedGuard] })
    public danger(context: Ctx) {
      ran.push('handler');

      return context.send({ ok: true });
    }
  }

  return { components: [MiddlewareUndecoratedController, MiddlewareBaseGuard], ran };
}

export interface FlowFixture {
  components: Component[];
  handlerRuns: string[];
}

export function flowFixture(): FlowFixture {
  const handlerRuns: string[] = [];

  @Middleware()
  class MiddlewareDeny extends AsenaMiddlewareService {
    public async handle(): Promise<boolean> {
      return false;
    }
  }

  @Middleware()
  class MiddlewareShortCircuit extends AsenaMiddlewareService {
    public async handle(): Promise<Response> {
      return new Response(JSON.stringify({ shortCircuit: true }), {
        status: 299,
        headers: { 'content-type': 'application/json', 'x-short-circuit': 'yes' },
      });
    }
  }

  @Middleware()
  class MiddlewareAfterNextHeader extends AsenaMiddlewareService {
    public async handle(context: Ctx, next: AsenaNextHandler) {
      await next();
      (context.res as Response).headers.set('x-after-next', 'added');
    }
  }

  @Controller('/mw-flow')
  class MiddlewareFlowController {
    @Get({ path: '/deny', middlewares: [MiddlewareDeny] })
    public deny(context: Ctx) {
      handlerRuns.push('deny');

      return context.send({ reached: true });
    }

    @Get({ path: '/short', middlewares: [MiddlewareShortCircuit] })
    public short(context: Ctx) {
      handlerRuns.push('short');

      return context.send({ reached: true });
    }

    @Get({ path: '/after', middlewares: [MiddlewareAfterNextHeader] })
    public after(context: Ctx) {
      handlerRuns.push('after');

      return context.send({ reached: true });
    }
  }

  return {
    components: [MiddlewareFlowController, MiddlewareDeny, MiddlewareShortCircuit, MiddlewareAfterNextHeader],
    handlerRuns,
  };
}

export function asyncContextFixture(): Component[] {
  const storage = new AsyncLocalStorage<{ requestId: string }>();

  @Middleware()
  class MiddlewareAsyncContext extends AsenaMiddlewareService {
    public async handle(context: Ctx, next: AsenaNextHandler) {
      const requestId = context.headers['x-request-id'] ?? 'none';

      await storage.run({ requestId }, () => next());
    }
  }

  @Service('MiddlewareAsyncContextReader')
  class MiddlewareAsyncContextReader {
    public read(): string | undefined {
      return storage.getStore()?.requestId;
    }
  }

  @Controller({ path: '/mw-als', middlewares: [MiddlewareAsyncContext] })
  class MiddlewareAsyncContextController {
    @Inject(MiddlewareAsyncContextReader)
    private reader!: MiddlewareAsyncContextReader;

    @Get('/read')
    public async read(context: Ctx) {
      await new Promise((resolve) => setTimeout(resolve, 2));

      return context.send({ handler: storage.getStore()?.requestId ?? null, service: this.reader.read() ?? null });
    }
  }

  return [MiddlewareAsyncContextController, MiddlewareAsyncContext, MiddlewareAsyncContextReader];
}
