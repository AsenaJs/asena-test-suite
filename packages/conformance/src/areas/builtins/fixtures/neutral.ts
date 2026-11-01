import type { AsenaContext } from '@asenajs/asena/adapter';
import { Config, Controller, Middleware } from '@asenajs/asena/decorators';
import { Get, Options } from '@asenajs/asena/decorators/http';
import type { AsenaConfig } from '@asenajs/asena/server/config';

type Component = new (...args: any[]) => unknown;
type BuiltinBase = abstract new () => object;

export function corsRouteFixture(Base: BuiltinBase): Component[] {
  @Middleware()
  class BuiltinsRouteCors extends Base {}

  @Controller({ path: '/builtins-cors', middlewares: [BuiltinsRouteCors as never] })
  class BuiltinsCorsController {
    @Get('/hello')
    public hello(context: AsenaContext<any, any>) {
      return context.send({ hello: true });
    }

    @Options('/hello')
    public preflight(context: AsenaContext<any, any>) {
      return context.send({ reachedHandler: true });
    }

    @Get('/events')
    public events(context: AsenaContext<any, any>) {
      return context.streamSSE(async (stream) => {
        await stream.writeSSE({ event: 'tick', data: 'one' });
      });
    }
  }

  return [BuiltinsCorsController, BuiltinsRouteCors];
}

export function corsGlobalFixture(Base: BuiltinBase): Component[] {
  @Middleware()
  class BuiltinsGlobalCors extends Base {}

  @Config()
  class BuiltinsGlobalCorsConfig implements AsenaConfig {
    public globalMiddlewares() {
      return [BuiltinsGlobalCors as never];
    }
  }

  @Controller('/builtins-global-cors')
  class BuiltinsGlobalCorsController {
    @Get('/items')
    public items(context: AsenaContext<any, any>) {
      return context.send({ items: [] });
    }
  }

  return [BuiltinsGlobalCorsController, BuiltinsGlobalCors, BuiltinsGlobalCorsConfig];
}

export function rateLimitedRouteFixture(Base: BuiltinBase, prefix: string): Component[] {
  @Middleware()
  class BuiltinsRouteRateLimiter extends Base {}

  @Controller({ path: prefix, middlewares: [BuiltinsRouteRateLimiter as never] })
  class BuiltinsRateLimitedController {
    @Get('/hit')
    public hit(context: AsenaContext<any, any>) {
      return context.send({ ok: true });
    }
  }

  return [BuiltinsRateLimitedController, BuiltinsRouteRateLimiter];
}

export const EXCLUDED_PREFIX = '/builtins-rl-exclude';

export function rateLimitedExcludeFixture(Base: BuiltinBase): Component[] {
  @Middleware()
  class BuiltinsGlobalRateLimiter extends Base {}

  @Config()
  class BuiltinsRateLimiterConfig implements AsenaConfig {
    public globalMiddlewares() {
      return [{ middleware: BuiltinsGlobalRateLimiter as never, routes: { exclude: [`${EXCLUDED_PREFIX}/health`] } }];
    }
  }

  @Controller(EXCLUDED_PREFIX)
  class BuiltinsExcludeController {
    @Get('/health')
    public health(context: AsenaContext<any, any>) {
      return context.send({ healthy: true });
    }

    @Get('/limited')
    public limited(context: AsenaContext<any, any>) {
      return context.send({ limited: true });
    }
  }

  return [BuiltinsExcludeController, BuiltinsGlobalRateLimiter, BuiltinsRateLimiterConfig];
}
