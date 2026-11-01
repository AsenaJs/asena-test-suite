import type { AsenaContext } from '@asenajs/asena/adapter';
import { Controller, Middleware } from '@asenajs/asena/decorators';
import { Post } from '@asenajs/asena/decorators/http';
import type { AsenaValidationService } from '@asenajs/asena/middleware';
import { type ZodType, z } from 'zod';
import { SMOKE_MIDDLEWARE_VALUE, SmokeMarkMiddleware } from './neutral.ts';

type Component = new (...args: any[]) => unknown;

export function zodSmokeFixture(): Component[] {
  @Middleware({ validator: true })
  class SmokeZodValidator implements AsenaValidationService<ZodType> {
    public json() {
      return z.object({ name: z.string().min(1) });
    }
  }

  @Controller('/smoke')
  class SmokeZodController {
    @Post({ path: '/echo', middlewares: [SmokeMarkMiddleware], validator: SmokeZodValidator })
    public async echo(context: AsenaContext<any, any>) {
      const body = await context.getBody<{ name: string }>();

      return context.send({ name: body.name, middleware: context.getValue<string>(SMOKE_MIDDLEWARE_VALUE) });
    }
  }

  return [SmokeZodController, SmokeZodValidator, SmokeMarkMiddleware];
}
