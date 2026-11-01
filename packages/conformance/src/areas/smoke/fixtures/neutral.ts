import type { AsenaContext, AsenaNextHandler } from '@asenajs/asena/adapter';
import { Config, Controller, Middleware } from '@asenajs/asena/decorators';
import { Get } from '@asenajs/asena/decorators/http';
import { AsenaMiddlewareService } from '@asenajs/asena/middleware';
import type { AsenaConfig } from '@asenajs/asena/server/config';

type Component = new (...args: any[]) => unknown;

export function pingFixture(): Component[] {
  @Controller('/smoke')
  class SmokePingController {
    @Get('/ping')
    public ping(context: AsenaContext<any, any>) {
      return context.send({ pong: true });
    }
  }

  return [SmokePingController];
}

export const SMOKE_MIDDLEWARE_VALUE = 'smoke-middleware';

@Middleware()
export class SmokeMarkMiddleware extends AsenaMiddlewareService {
  public async handle(context: AsenaContext<any, any>, next: AsenaNextHandler) {
    context.setValue(SMOKE_MIDDLEWARE_VALUE, 'ran');
    await next();
  }
}

export interface OnErrorFixture {
  components: Component[];
  seen: string[];
}

export function onErrorFixture(): OnErrorFixture {
  const seen: string[] = [];

  @Controller('/smoke')
  class SmokeBoomController {
    @Get('/boom')
    public boom(): Response {
      throw new Error('smoke-boom');
    }
  }

  @Config()
  class SmokeErrorConfig implements AsenaConfig {
    public onError(error: Error, context: AsenaContext<any, any>) {
      seen.push(error.message);

      return context.send({ handled: error.message }, 418);
    }
  }

  return { components: [SmokeBoomController, SmokeErrorConfig], seen };
}

export function corsFixture(Base: abstract new () => object): Component[] {
  @Middleware()
  class SmokeCorsMiddleware extends Base {}

  @Controller({ path: '/smoke-cors', middlewares: [SmokeCorsMiddleware as never] })
  class SmokeCorsController {
    @Get('/hello')
    public hello(context: AsenaContext<any, any>) {
      return context.send({ hello: true });
    }
  }

  return [SmokeCorsController, SmokeCorsMiddleware];
}
