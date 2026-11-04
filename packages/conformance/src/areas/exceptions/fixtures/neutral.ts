import {
  type AsenaContext,
  type AsenaNextHandler,
  ContractValidationError,
  HttpException,
  type NotFoundRequest,
  NotFoundException,
} from '@asenajs/asena/adapter';
import { Config, Controller, ExceptionHandler, Middleware } from '@asenajs/asena/decorators';
import { Get, Post } from '@asenajs/asena/decorators/http';
import { Catch, type ExceptionContext, NotFound } from '@asenajs/asena/exception';
import { AsenaMiddlewareService } from '@asenajs/asena/middleware';
import type { AsenaConfig } from '@asenajs/asena/server/config';

type Component = new (...args: any[]) => unknown;
type Ctx = AsenaContext<any, any>;

export const SECRET = 'exceptions-secret-db-host-10.0.0.9';
export const REJECTED = 'exceptions-order-rejected';
export const MW_BEFORE = 'exceptions-mw-before';
export const MW_AFTER = 'exceptions-mw-after';
export const IN_VALIDATOR = 'exceptions-in-validator';
export const CONFLICT_BODY = { error: 'exceptions-conflict' };
export const MISSING_BODY = { error: 'exceptions-missing-order' };
export const HANDLER_EXPLODED = 'exceptions-handler-exploded';
export const THROWN_TEXT = 'exceptions-thrown-text';
export const JSON_HEADERS = { 'content-type': 'application/json' };

export class OrderRejectedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OrderRejectedError';
  }
}

export interface Seen {
  calls: string[];
  scopes: string[];
  handlerCalls: string[];
}

export function newSeen(): Seen {
  return { calls: [], scopes: [], handlerCalls: [] };
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The routes every scenario of the area throws from. */
export function ordersFixture(seen: Seen, define: (schemas: object) => new (...args: any[]) => unknown): Component[] {
  @Middleware()
  class ExceptionsThrowBeforeNext extends AsenaMiddlewareService {
    public async handle(_context: Ctx, _next: AsenaNextHandler) {
      throw new OrderRejectedError(MW_BEFORE);
    }
  }

  @Middleware()
  class ExceptionsThrowAfterNext extends AsenaMiddlewareService {
    public async handle(_context: Ctx, next: AsenaNextHandler) {
      await next();
      throw new OrderRejectedError(MW_AFTER);
    }
  }

  const body = {
    '~standard': {
      version: 1 as const,
      vendor: 'asena-conformance',
      validate(value: unknown) {
        const name = (value as { name?: unknown } | null)?.name;

        if (name === 'reject') throw new OrderRejectedError(IN_VALIDATOR);
        if (typeof name === 'string' && name.length > 0) return { value: { name } };

        return { issues: [{ message: 'name must be a non-empty string', path: ['name'] }] };
      },
      types: undefined as unknown as { input: unknown; output: { name: string } },
    },
  };
  const Base = define({ body }) as new (...args: any[]) => Ctx;

  class ExceptionsOrderContext extends Base {}

  @Controller('/exceptions')
  class ExceptionsOrderController {
    @Get('/domain')
    public domain(): Response {
      throw new OrderRejectedError(REJECTED);
    }

    @Get('/plain')
    public plain(): Response {
      throw new Error(SECRET);
    }

    @Get('/type-error')
    public typeError(): Response {
      throw new TypeError(SECRET);
    }

    @Get('/http')
    public http(): Response {
      throw new HttpException(409, CONFLICT_BODY);
    }

    @Get('/not-found-exception')
    public notFoundException(): Response {
      throw new NotFoundException(MISSING_BODY);
    }

    @Get('/thrown-text')
    public thrownText(): Response {
      throw THROWN_TEXT as unknown;
    }

    @Get('/ok')
    public ok(context: Ctx) {
      return context.send({ ok: true });
    }

    @Get({ path: '/mw-before', middlewares: [ExceptionsThrowBeforeNext] })
    public mwBefore(context: Ctx) {
      seen.handlerCalls.push('mw-before');

      return context.send({ reached: true });
    }

    @Get({ path: '/mw-after', middlewares: [ExceptionsThrowAfterNext] })
    public mwAfter(context: Ctx) {
      seen.handlerCalls.push('mw-after');

      return context.send({ reached: true });
    }

    @Post('/validated')
    public validated(context: ExceptionsOrderContext) {
      seen.handlerCalls.push('validated');

      return context.send({ created: true });
    }
  }

  return [ExceptionsOrderController, ExceptionsThrowBeforeNext, ExceptionsThrowAfterNext];
}

export type DomainMode = 'answers' | 'async' | 'declines' | 'throws' | 'non-response';

/** `@Catch(OrderRejectedError)`, answering 422 or misbehaving as `mode` says. */
export function domainHandler(seen: Seen, mode: DomainMode): Component {
  @ExceptionHandler()
  class ExceptionsDomainHandler {
    @Catch(OrderRejectedError)
    public async rejected(error: OrderRejectedError, ctx: ExceptionContext<Ctx>) {
      seen.calls.push(`domain:${error.message}`);
      seen.scopes.push(ctx.scope);

      if (ctx.scope !== 'http') return undefined;

      switch (mode) {
        case 'answers':
          return ctx.context.send({ rejected: error.message, path: new URL(ctx.context.req.url).pathname }, 422);
        case 'async':
          await new Promise((resolve) => setTimeout(resolve, 10));

          return ctx.context.send({ rejected: error.message }, 422);
        case 'declines':
          return undefined;
        case 'throws':
          throw new Error(HANDLER_EXPLODED);
        case 'non-response':
          return { rejected: error.message };
      }
    }
  }

  return ExceptionsDomainHandler;
}

/** `@Catch(Error)`, which declines or answers. Never registered together with `domainHandler(..., 'answers')`. */
export function errorHandler(seen: Seen, mode: 'answers' | 'declines' | 'throws' | 'non-response'): Component {
  @ExceptionHandler()
  class ExceptionsErrorHandler {
    @Catch(Error)
    public error(error: Error, ctx: ExceptionContext<Ctx>) {
      seen.calls.push(`error:${error.name}`);

      if (ctx.scope !== 'http') return undefined;
      if (mode === 'throws') throw new Error(HANDLER_EXPLODED);
      if (mode === 'non-response') return { handled: true };

      return mode === 'answers' ? ctx.context.send({ by: 'error', name: error.name }, 520) : undefined;
    }
  }

  return ExceptionsErrorHandler;
}

/** `@Catch(ContractValidationError)`, `@Catch(NotFoundException)`, `@Catch(HttpException)` and `@Catch(Error)` in one class. */
export function layeredHandler(seen: Seen): Component {
  const answer = (by: string, error: Error, ctx: ExceptionContext<Ctx>) => {
    seen.calls.push(`${by}:${error.name}`);

    if (ctx.scope !== 'http') return undefined;

    return ctx.context.send({ by, name: error.name }, 520);
  };

  @ExceptionHandler()
  class ExceptionsLayeredHandler {
    @Catch(ContractValidationError)
    public validation(error: ContractValidationError, ctx: ExceptionContext<Ctx>) {
      return answer('validation', error, ctx);
    }

    @Catch(NotFoundException)
    public missing(error: NotFoundException, ctx: ExceptionContext<Ctx>) {
      return answer('not-found', error, ctx);
    }

    @Catch(HttpException)
    public http(error: HttpException, ctx: ExceptionContext<Ctx>) {
      return answer('http', error, ctx);
    }

    @Catch(Error)
    public error(error: Error, ctx: ExceptionContext<Ctx>) {
      return answer('error', error, ctx);
    }
  }

  return ExceptionsLayeredHandler;
}

/** The single catch-all, `@Catch()`. */
export function catchAllHandler(seen: Seen, mode: 'answers' | 'declines'): Component {
  @ExceptionHandler()
  class ExceptionsCatchAllHandler {
    @Catch()
    public all(error: unknown, ctx: ExceptionContext<Ctx>) {
      seen.calls.push(`all:${nameOf(error)}:${messageOf(error)}`);

      if (ctx.scope !== 'http' || mode === 'declines') return undefined;

      return ctx.context.send({ by: 'all', name: nameOf(error) }, 520);
    }
  }

  return ExceptionsCatchAllHandler;
}

export type NotFoundMode = 'answers' | 'declines' | 'throws';

export function notFoundHandler(seen: Seen, mode: NotFoundMode): Component {
  @ExceptionHandler()
  class ExceptionsNotFoundHandler {
    @NotFound()
    public missing(context: Ctx, request: NotFoundRequest) {
      seen.calls.push(`not-found:${request.method} ${request.path}`);

      if (mode === 'throws') throw new Error(HANDLER_EXPLODED);
      if (mode === 'declines') return undefined;

      return context.send({ by: 'not-found', path: request.path, method: request.method }, 404);
    }
  }

  return ExceptionsNotFoundHandler;
}

/** A deprecated `@Config.onError`, answering 503. */
export function legacyOnErrorConfig(seen: Seen): Component {
  @Config()
  class ExceptionsLegacyOnErrorConfig implements AsenaConfig {
    public onError(error: Error, context: Ctx) {
      seen.calls.push(`config.onError:${error.message}`);

      return context.send({ by: 'config.onError', message: error.message }, 503);
    }
  }

  return ExceptionsLegacyOnErrorConfig;
}

/** A deprecated `@Config.onNotFound`, answering 404 with its own body. */
export function legacyOnNotFoundConfig(seen: Seen): Component {
  @Config()
  class ExceptionsLegacyOnNotFoundConfig implements AsenaConfig {
    public onNotFound(context: Ctx, request: NotFoundRequest) {
      seen.calls.push(`config.onNotFound:${request.path}`);

      return context.send({ by: 'config.onNotFound', path: request.path }, 404);
    }
  }

  return ExceptionsLegacyOnNotFoundConfig;
}
