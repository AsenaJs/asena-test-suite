import type { AsenaContext } from '@asenajs/asena/adapter';
import { Config, Controller, Middleware } from '@asenajs/asena/decorators';
import { Get, Post } from '@asenajs/asena/decorators/http';
import type { AsenaValidationService } from '@asenajs/asena/middleware';
import type { AsenaConfig } from '@asenajs/asena/server/config';
import { type ZodType, z } from 'zod';

type Component = new (...args: any[]) => unknown;

export interface LegacyFixture {
  components: Component[];
  calls: { handler: number; factory: number };
}

export function legacyTargetsFixture(): LegacyFixture {
  const calls = { handler: 0, factory: 0 };

  @Middleware({ validator: true })
  class LegacyCreateUserValidator implements AsenaValidationService<ZodType> {
    public json() {
      return z.object({ name: z.string().min(1), email: z.email(), age: z.number().optional() });
    }
  }

  @Middleware({ validator: true })
  class LegacyParamValidator implements AsenaValidationService<ZodType> {
    public param() {
      return z.object({ id: z.uuid() });
    }
  }

  @Middleware({ validator: true })
  class LegacyQueryValidator implements AsenaValidationService<ZodType> {
    public query() {
      return z.object({ page: z.coerce.number() });
    }
  }

  @Middleware({ validator: true })
  class LegacyFormValidator implements AsenaValidationService<ZodType> {
    public form() {
      return z.object({ title: z.string().min(1) });
    }
  }

  @Middleware({ validator: true })
  class LegacyHeaderValidator implements AsenaValidationService<ZodType> {
    public header() {
      return z.object({ 'x-api-key': z.string().min(3) });
    }
  }

  @Controller('/legacy')
  class LegacyTargetsController {
    @Post({ path: '/users', validator: LegacyCreateUserValidator })
    public async create(context: AsenaContext<any, any>) {
      calls.handler++;

      return context.send(await context.getBody(), 201);
    }

    @Get({ path: '/users/:id', validator: LegacyParamValidator })
    public byId(context: AsenaContext<any, any>) {
      calls.handler++;

      return context.send({ id: context.getParam('id') });
    }

    @Get({ path: '/users', validator: LegacyQueryValidator })
    public async list(context: AsenaContext<any, any>) {
      calls.handler++;

      return context.send({ page: await context.getQuery('page') });
    }

    @Post({ path: '/form', validator: LegacyFormValidator })
    public form(context: AsenaContext<any, any>) {
      calls.handler++;

      return context.send({ ok: true });
    }

    @Get({ path: '/header', validator: LegacyHeaderValidator })
    public header(context: AsenaContext<any, any>) {
      calls.handler++;

      return context.send({ ok: true });
    }
  }

  return {
    components: [
      LegacyTargetsController,
      LegacyCreateUserValidator,
      LegacyParamValidator,
      LegacyQueryValidator,
      LegacyFormValidator,
      LegacyHeaderValidator,
    ],
    calls,
  };
}

export interface OnErrorFixture extends LegacyFixture {
  errors: Error[];
}

export function legacyOnErrorFixture(): OnErrorFixture {
  const base = legacyTargetsFixture();
  const errors: Error[] = [];

  @Config()
  class LegacyOnErrorConfig implements AsenaConfig {
    public onError(error: Error, context: AsenaContext<any, any>) {
      errors.push(error);

      return context.send({ captured: true }, 499);
    }
  }

  return { ...base, components: [...base.components, LegacyOnErrorConfig], errors };
}

export function isZodError(value: unknown): boolean {
  return value instanceof z.ZodError;
}

export function legacyInheritedFixture(): LegacyFixture {
  const calls = { handler: 0, factory: 0 };

  @Middleware({ validator: true })
  class LegacyInheritedValidator implements AsenaValidationService<ZodType> {
    public json() {
      calls.factory++;

      return z.object({ name: z.string().min(1) });
    }
  }

  class LegacyBaseController {
    @Post({ path: '/inherited', validator: LegacyInheritedValidator })
    public async inherited(context: AsenaContext<any, any>) {
      calls.handler++;

      return context.send(await context.getBody());
    }
  }

  @Controller('/legacy-child')
  class LegacyChildController extends LegacyBaseController {}

  return { components: [LegacyChildController, LegacyInheritedValidator], calls };
}

export function legacyHookFixture(): LegacyFixture & { hookResults: boolean[] } {
  const calls = { handler: 0, factory: 0 };
  const hookResults: boolean[] = [];

  @Middleware({ validator: true })
  class LegacyHookValidator implements AsenaValidationService<unknown> {
    public json() {
      return {
        schema: z.object({ name: z.string().min(1) }),
        hook: (result: { success: boolean }) => {
          hookResults.push(result.success);

          if (result.success) return undefined;

          return new Response(JSON.stringify({ hooked: true }), {
            status: 422,
            headers: { 'content-type': 'application/json' },
          });
        },
      };
    }
  }

  @Controller('/legacy')
  class LegacyHookController {
    @Post({ path: '/hook', validator: LegacyHookValidator })
    public async hook(context: AsenaContext<any, any>) {
      calls.handler++;

      return context.send(await context.getBody());
    }
  }

  return { components: [LegacyHookController, LegacyHookValidator], calls, hookResults };
}

export function legacyCacheFixture(): LegacyFixture {
  const calls = { handler: 0, factory: 0 };

  @Middleware({ validator: true })
  class LegacyCachedValidator implements AsenaValidationService<ZodType> {
    public json() {
      calls.factory++;

      return z.object({ count: z.coerce.number().int() });
    }
  }

  @Controller('/legacy')
  class LegacyCacheController {
    @Post({ path: '/cached', validator: LegacyCachedValidator, validatorCache: true })
    public async cached(context: AsenaContext<any, any>) {
      calls.handler++;

      return context.send(await context.getBody());
    }
  }

  return { components: [LegacyCacheController, LegacyCachedValidator], calls };
}

export function legacyParsedFixture(): LegacyFixture {
  const calls = { handler: 0, factory: 0 };

  @Middleware({ validator: true })
  class LegacyParsedValidator implements AsenaValidationService<ZodType> {
    public json() {
      return z.object({ name: z.string().trim(), role: z.string().default('member') });
    }
  }

  @Controller('/legacy')
  class LegacyParsedController {
    @Post({ path: '/parsed', validator: LegacyParsedValidator })
    public async parsed(context: AsenaContext<any, any>) {
      calls.handler++;

      return context.send({ body: await context.getBody() });
    }
  }

  return { components: [LegacyParsedController, LegacyParsedValidator], calls };
}
