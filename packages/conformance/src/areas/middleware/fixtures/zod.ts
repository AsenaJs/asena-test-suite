import type { AsenaContext } from '@asenajs/asena/adapter';
import { Controller, Middleware } from '@asenajs/asena/decorators';
import { Post } from '@asenajs/asena/decorators/http';
import type { AsenaValidationService } from '@asenajs/asena/middleware';
import { type ZodType, z } from 'zod';
import { type OrderFixture, orderMiddlewares } from './neutral.ts';

export function legacyOrderFixture(): OrderFixture {
  const order: string[] = [];
  const chain = orderMiddlewares(order);

  @Middleware({ validator: true })
  class MiddlewareOrderValidator implements AsenaValidationService<ZodType> {
    public json() {
      return z.object({ name: z.string().min(1) });
    }
  }

  @Controller({ path: '/mw-order-legacy', middlewares: [chain.Controller] })
  class MiddlewareLegacyOrderController {
    @Post({ path: '/run', middlewares: [chain.Route], validator: MiddlewareOrderValidator })
    public run(context: AsenaContext<any, any>) {
      order.push('handler');

      return context.send({ ok: true });
    }
  }

  return { components: [MiddlewareLegacyOrderController, MiddlewareOrderValidator, ...chain.components], order };
}
