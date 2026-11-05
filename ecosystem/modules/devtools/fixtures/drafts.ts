import { type AsenaContext, HttpException, isValidationError } from '@asenajs/asena/adapter';
import { Config, Controller, ExceptionHandler, Middleware } from '@asenajs/asena/decorators';
import { Get, Post } from '@asenajs/asena/decorators/http';
import { Catch, type ExceptionContext } from '@asenajs/asena/exception';
import type { AsenaValidationService } from '@asenajs/asena/middleware';
import type { AsenaConfig } from '@asenajs/asena/server/config';
import { type ZodType, z } from 'zod';

type Ctx = AsenaContext<any, any>;

const title = () => z.object({ title: z.string().min(1) });

@Middleware({ validator: true })
export class DraftHookValidator implements AsenaValidationService<unknown> {
  public json() {
    return {
      schema: title(),
      hook: (result: { success: boolean }) =>
        result.success
          ? undefined
          : new Response(JSON.stringify({ by: 'hook' }), {
              status: 422,
              headers: { 'content-type': 'application/json' },
            }),
    };
  }
}

@Middleware({ validator: true })
export class DraftValidator implements AsenaValidationService<ZodType> {
  public json() {
    return title();
  }
}

@Middleware({ validator: true })
export class DraftQueryValidator implements AsenaValidationService<ZodType> {
  public query() {
    return z.object({ q: z.string().min(1) });
  }
}

@Controller('/drafts')
export class DraftController {
  @Post({ path: '/hooked', validator: DraftHookValidator })
  public hooked(context: Ctx) {
    return context.send({ created: true }, 201);
  }

  @Post({ path: '/caught', validator: DraftValidator })
  public caught(context: Ctx) {
    return context.send({ created: true }, 201);
  }

  @Get({ path: '/search', validator: DraftQueryValidator })
  public search(context: Ctx) {
    return context.send({ found: [] });
  }
}

/** Adapters each throw their own ValidationError class; the shared base is core's HttpException. */
@ExceptionHandler()
export class DraftErrors {
  @Catch(HttpException)
  public validation(error: HttpException, ctx: ExceptionContext<Ctx>) {
    if (ctx.scope !== 'http' || !isValidationError(error) || error.target !== 'json') return undefined;

    return ctx.context.send({ by: 'catch', target: error.target }, 422);
  }
}

@Config()
export class DraftConfig implements AsenaConfig {
  public onError(error: Error, context: Ctx) {
    return context.send({ by: 'onError', target: isValidationError(error) ? error.target : null }, 422);
  }
}

/** What `main.drafts.ts` hands `AsenaServerFactory.create`: validation failures answered three ways. */
export const draftComponents = [
  DraftHookValidator,
  DraftValidator,
  DraftQueryValidator,
  DraftController,
  DraftErrors,
  DraftConfig,
];
