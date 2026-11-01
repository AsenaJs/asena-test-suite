import type { AsenaAdapter, AsenaContext, AsenaNextHandler, AsenaServeOptions } from '@asenajs/asena/adapter';
import { Config, Controller, Middleware, Service } from '@asenajs/asena/decorators';
import { Get, Post } from '@asenajs/asena/decorators/http';
import { Inject, OnStart } from '@asenajs/asena/decorators/ioc';
import { ICoreServiceNames } from '@asenajs/asena/ioc/types';
import { AsenaMiddlewareService } from '@asenajs/asena/middleware';
import type { AsenaConfig } from '@asenajs/asena/server/config';
import { HttpMethod } from '@asenajs/asena/web-types';

type Component = new (...args: any[]) => unknown;

export function pingFixture(prefix = '/lifecycle'): Component[] {
  @Controller(prefix)
  class LifecyclePingController {
    @Get('/ping')
    public ping(context: AsenaContext<any, any>) {
      return context.send({ pong: prefix });
    }
  }

  return [LifecyclePingController];
}

export const BODY_LIMIT = 1024;

export function bodyLimitFixture(mode: 'sync' | 'async'): Component[] {
  @Controller('/lifecycle')
  class LifecycleBodyController {
    @Post('/body')
    public async body(context: AsenaContext<any, any>) {
      const text = await context.getBody<unknown>();

      return context.send({ received: JSON.stringify(text).length });
    }
  }

  @Config()
  class LifecycleSyncServeConfig implements AsenaConfig {
    public serveOptions(): AsenaServeOptions {
      return { serveOptions: { maxRequestBodySize: BODY_LIMIT } };
    }
  }

  @Config()
  class LifecycleAsyncServeConfig {
    public async serveOptions(): Promise<AsenaServeOptions> {
      await Promise.resolve();

      return { serveOptions: { maxRequestBodySize: BODY_LIMIT } };
    }
  }

  return [LifecycleBodyController, mode === 'sync' ? LifecycleSyncServeConfig : LifecycleAsyncServeConfig];
}

export const GLOBAL_MARK = 'lifecycle-global';

export interface ThirdPartyFixture {
  components: Component[];
  errors: string[];
  onStartRan: () => boolean;
}

export function thirdPartyFixture(options: { controller?: boolean } = {}): ThirdPartyFixture {
  const errors: string[] = [];
  let ran = false;

  @Middleware()
  class LifecycleGlobalMiddleware extends AsenaMiddlewareService {
    public async handle(context: AsenaContext<any, any>, next: AsenaNextHandler) {
      context.setValue(GLOBAL_MARK, 'ran');
      await next();
    }
  }

  @Service()
  class LifecycleThirdPartyRoutes {
    @Inject(ICoreServiceNames.ASENA_ADAPTER)
    private adapter!: AsenaAdapter<any, any>;

    @OnStart()
    public async register(): Promise<void> {
      ran = true;

      await this.adapter.registerRoute({
        method: HttpMethod.GET,
        path: '/lifecycle/third-party',
        middlewares: [],
        handler: (context: AsenaContext<any, any>) =>
          context.send({ thirdParty: true, global: context.getValue(GLOBAL_MARK) ?? null }),
        staticServe: undefined as never,
        validator: undefined as never,
        controllerName: 'LifecycleThirdPartyRoutes',
      });

      await this.adapter.registerRoute({
        method: HttpMethod.GET,
        path: '/lifecycle/third-party-boom',
        middlewares: [],
        handler: () => {
          throw new Error('third-party-boom');
        },
        staticServe: undefined as never,
        validator: undefined as never,
        controllerName: 'LifecycleThirdPartyRoutes',
      });
    }
  }

  @Config()
  class LifecycleThirdPartyConfig implements AsenaConfig {
    public serveOptions(): AsenaServeOptions {
      return {};
    }

    public onError(error: Error, context: AsenaContext<any, any>) {
      errors.push(error.message);

      return context.send({ handled: error.message }, 418);
    }

    public globalMiddlewares() {
      return [LifecycleGlobalMiddleware];
    }
  }

  const components: Component[] = [LifecycleThirdPartyRoutes, LifecycleThirdPartyConfig, LifecycleGlobalMiddleware];

  if (options.controller) components.push(...pingFixture());

  return { components, errors, onStartRan: () => ran };
}

export interface SlowFixture {
  components: Component[];
  entered: () => number;
  release: () => void;
}

export function slowFixture(): SlowFixture {
  let entered = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });

  @Controller('/lifecycle')
  class LifecycleSlowController {
    @Get('/slow')
    public async slow(context: AsenaContext<any, any>) {
      entered++;
      await gate;

      return context.send({ slow: 'done' });
    }

    @Get('/ping')
    public ping(context: AsenaContext<any, any>) {
      return context.send({ pong: true });
    }
  }

  return { components: [LifecycleSlowController], entered: () => entered, release: () => open() };
}

export interface NotFoundFixture {
  components: Component[];
  hookCalls: () => number;
}

export function notFoundFixture(): NotFoundFixture {
  let calls = 0;

  @Config()
  class LifecycleNotFoundConfig implements AsenaConfig {
    public onNotFound(context: AsenaContext<any, any>) {
      calls++;

      return context.send({ custom: true }, 404);
    }
  }

  return { components: [...pingFixture(), LifecycleNotFoundConfig], hookCalls: () => calls };
}
