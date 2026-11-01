import type { AsenaContext } from '@asenajs/asena/adapter';
import { Controller, Middleware } from '@asenajs/asena/decorators';
import { Post } from '@asenajs/asena/decorators/http';
import type { AsenaValidationService } from '@asenajs/asena/middleware';
import { type ZodType, z } from 'zod';

type Component = new (...args: any[]) => unknown;

export interface ZodErrorsFixture {
  components: Component[];
  calls: { handler: number };
}

export function zodErrorsFixture(): ZodErrorsFixture {
  const calls = { handler: 0 };

  @Middleware({ validator: true })
  class ErrorsZodValidator implements AsenaValidationService<ZodType> {
    public json() {
      return z.object({ name: z.string().min(1) });
    }
  }

  @Controller('/errors-zod')
  class ErrorsZodController {
    @Post({ path: '/create', validator: ErrorsZodValidator })
    public create(context: AsenaContext<any, any>) {
      calls.handler++;

      return context.send({ created: true });
    }
  }

  return { components: [ErrorsZodController, ErrorsZodValidator], calls };
}
