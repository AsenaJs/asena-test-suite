import type { AsenaContext } from '@asenajs/asena/adapter';
import { Controller, Middleware } from '@asenajs/asena/decorators';
import { Get } from '@asenajs/asena/decorators/http';
import type { AsenaValidationService } from '@asenajs/asena/middleware';
import { type ZodType, z } from 'zod';

type Component = new (...args: any[]) => unknown;

export const HARNESS_PARAM_VALIDATOR = 'HarnessParamValidator';
export const HARNESS_QUERY_VALIDATOR = 'HarnessQueryValidator';

export function validatedControllerFixture(): Component {
  @Middleware({ name: HARNESS_PARAM_VALIDATOR, validator: true })
  class HarnessParamValidator implements AsenaValidationService<ZodType> {
    public param() {
      return z.object({ id: z.uuid() });
    }
  }

  @Middleware({ name: HARNESS_QUERY_VALIDATOR, validator: true })
  class HarnessQueryValidator implements AsenaValidationService<ZodType> {
    public query() {
      return z.object({ limit: z.coerce.number().optional() });
    }
  }

  @Controller('/harness/validated')
  class HarnessValidatedController {
    @Get({ path: '/', validator: HarnessQueryValidator })
    public list(context: AsenaContext<any, any>) {
      return context.send([]);
    }

    @Get({ path: '/:id', validator: HarnessParamValidator })
    public byId(context: AsenaContext<any, any>) {
      return context.send({ id: context.getParam('id') });
    }
  }

  return HarnessValidatedController;
}
