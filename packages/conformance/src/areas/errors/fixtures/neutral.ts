import { type AsenaContext, type AsenaNextHandler, HttpException } from '@asenajs/asena/adapter';
import { Config, Controller, Middleware } from '@asenajs/asena/decorators';
import { Get, Post } from '@asenajs/asena/decorators/http';
import { AsenaMiddlewareService } from '@asenajs/asena/middleware';
import type { AsenaConfig } from '@asenajs/asena/server/config';
import { ErrorsGuardedBase } from './base.ts';

type Component = new (...args: any[]) => unknown;

export const SECRET = 'errors-secret-db-host-10.0.0.7';
export const NOT_FOUND_BODY = { error: 'missing-item' };
export const TEAPOT_BODY = { error: 'teapot' };
export const CONFLICT_BODY = { error: 'conflict' };
export const MW_BEFORE = 'errors-mw-before';
export const MW_AFTER = 'errors-mw-after';

export type OnErrorMode = 'none' | 'answers' | 'async' | 'throws';

export interface ErrorsFixture {
  components: Component[];
  seen: string[];
  handlerCalls: string[];
}

@Middleware()
class ErrorsThrowBeforeNext extends AsenaMiddlewareService {
  public async handle(_context: AsenaContext<any, any>, _next: AsenaNextHandler) {
    throw new Error(MW_BEFORE);
  }
}

@Middleware()
class ErrorsThrowAfterNext extends AsenaMiddlewareService {
  public async handle(_context: AsenaContext<any, any>, next: AsenaNextHandler) {
    await next();
    throw new Error(MW_AFTER);
  }
}

function answer(error: Error, context: AsenaContext<any, any>): Response | Promise<Response> {
  if (error instanceof HttpException) return context.send(error.body, error.status);

  return context.send({ handled: error.message }, 503);
}

export function errorsFixture(mode: OnErrorMode): ErrorsFixture {
  const seen: string[] = [];
  const handlerCalls: string[] = [];

  @Controller('/errors')
  class ErrorsController extends ErrorsGuardedBase {
    @Get('/not-found-exception')
    public notFoundException(): Response {
      throw new HttpException(404, NOT_FOUND_BODY);
    }

    @Get('/base')
    public base(): Response {
      return this.deny();
    }

    @Get('/headers')
    public headers(): Response {
      throw new HttpException(429, 'slow down', { headers: { 'retry-after': '60', 'x-errors-marker': 'set' } });
    }

    @Get('/plain')
    public plain(): Response {
      throw new Error(SECRET);
    }

    @Get('/teapot')
    public teapot(): Response {
      throw new HttpException(418, TEAPOT_BODY);
    }

    @Get('/conflict')
    public conflict(): Response {
      throw new HttpException(409, CONFLICT_BODY);
    }

    @Get('/ok')
    public ok(context: AsenaContext<any, any>) {
      return context.send({ ok: true });
    }

    @Get({ path: '/mw-before', middlewares: [ErrorsThrowBeforeNext] })
    public mwBefore(context: AsenaContext<any, any>) {
      handlerCalls.push('mw-before');

      return context.send({ reached: true });
    }

    @Get({ path: '/mw-after', middlewares: [ErrorsThrowAfterNext] })
    public mwAfter(context: AsenaContext<any, any>) {
      handlerCalls.push('mw-after');

      return context.send({ reached: true });
    }
  }

  const components: Component[] = [ErrorsController, ErrorsThrowBeforeNext, ErrorsThrowAfterNext];

  if (mode === 'answers') {
    @Config()
    class ErrorsAnsweringConfig implements AsenaConfig {
      public onError(error: Error, context: AsenaContext<any, any>) {
        seen.push(error.message);

        return answer(error, context);
      }
    }

    components.push(ErrorsAnsweringConfig);
  } else if (mode === 'async') {
    @Config()
    class ErrorsAsyncConfig implements AsenaConfig {
      public async onError(error: Error, context: AsenaContext<any, any>) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        seen.push(error.message);

        return answer(error, context);
      }
    }

    components.push(ErrorsAsyncConfig);
  } else if (mode === 'throws') {
    @Config()
    class ErrorsThrowingConfig implements AsenaConfig {
      public onError(error: Error): Response {
        seen.push(error.message);
        throw new Error('errors-onError-exploded');
      }
    }

    components.push(ErrorsThrowingConfig);
  }

  return { components, seen, handlerCalls };
}

export function foreignExceptionFixture(Foreign: new (status: number, body?: string | object) => Error): Component[] {
  @Controller('/errors-foreign')
  class ErrorsForeignController {
    @Get('/throw')
    public throwForeign(): Response {
      throw new Foreign(451, { error: 'foreign-copy' });
    }
  }

  return [ErrorsForeignController];
}

export interface ContractFixture {
  components: Component[];
  calls: { validate: number; handler: number };
}

export function contractFixture(define: (schemas: object) => new (...args: any[]) => unknown): ContractFixture {
  const calls = { validate: 0, handler: 0 };
  const body = {
    '~standard': {
      version: 1 as const,
      vendor: 'asena-conformance',
      validate(value: unknown) {
        calls.validate++;

        const name = (value as { name?: unknown } | null)?.name;

        if (typeof name === 'string' && name.length > 0) return { value: { name } };

        return { issues: [{ message: 'name must be a non-empty string', path: ['name'] }] };
      },
      types: undefined as unknown as { input: unknown; output: { name: string } },
    },
  };
  const Base = define({ body }) as new (...args: any[]) => AsenaContext<any, any>;

  class ErrorsContractContext extends Base {}

  @Controller('/errors-contract')
  class ErrorsContractController {
    @Post('/create')
    public create(context: ErrorsContractContext) {
      calls.handler++;

      return context.send({ created: true });
    }
  }

  return { components: [ErrorsContractController], calls };
}
