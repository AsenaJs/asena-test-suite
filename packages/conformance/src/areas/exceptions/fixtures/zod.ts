import { type AsenaContext, HttpException, isValidationError } from '@asenajs/asena/adapter';
import { Controller, ExceptionHandler, Middleware } from '@asenajs/asena/decorators';
import { Post } from '@asenajs/asena/decorators/http';
import { Catch, type ExceptionContext } from '@asenajs/asena/exception';
import type { AsenaValidationService } from '@asenajs/asena/middleware';
import { type ZodType, z } from 'zod';

type Component = new (...args: any[]) => unknown;
type Ctx = AsenaContext<any, any>;

export interface ZodExceptionsFixture {
  components: Component[];
  calls: string[];
}

/** A legacy (zod) validator failure, with `@Catch(HttpException)` and `@Catch(Error)` competing for it. */
export function zodExceptionsFixture(): ZodExceptionsFixture {
  const calls: string[] = [];

  @Middleware({ validator: true })
  class ExceptionsZodValidator implements AsenaValidationService<ZodType> {
    public json() {
      return z.object({ name: z.string().min(1) });
    }
  }

  @Controller('/exceptions-zod')
  class ExceptionsZodController {
    @Post({ path: '/create', validator: ExceptionsZodValidator })
    public create(context: Ctx) {
      calls.push('handler');

      return context.send({ created: true });
    }
  }

  @ExceptionHandler()
  class ExceptionsZodHandler {
    @Catch(HttpException)
    public http(error: HttpException, ctx: ExceptionContext<Ctx>) {
      calls.push('http');

      if (ctx.scope !== 'http') return undefined;

      const target = isValidationError(error) ? error.target : undefined;

      return ctx.context.send({ by: 'http', status: error.status, validation: target !== undefined, target }, 520);
    }

    @Catch(Error)
    public error(error: Error, ctx: ExceptionContext<Ctx>) {
      calls.push('error');

      if (ctx.scope !== 'http') return undefined;

      return ctx.context.send({ by: 'error', name: error.name }, 520);
    }
  }

  return { components: [ExceptionsZodController, ExceptionsZodValidator, ExceptionsZodHandler], calls };
}
