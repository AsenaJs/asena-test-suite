import {
  ASENA_CONTEXT_ADAPTER,
  ASENA_CONTEXT_CONTRACT,
  type AsenaContext,
  type AsenaNextHandler,
  type RequestSchemas,
} from '@asenajs/asena/adapter';
import { Config, Controller, Middleware } from '@asenajs/asena/decorators';
import { Get, Post } from '@asenajs/asena/decorators/http';
import { type AsenaValidationService, AsenaMiddlewareService } from '@asenajs/asena/middleware';
import type { AsenaConfig } from '@asenajs/asena/server/config';
import { coerceNumber, object, optional, string, traced } from './standardSchema.ts';

type Component = new (...args: any[]) => unknown;

export type ContractContext = AsenaContext<any, any> & { readonly input: Record<string, any> };

export type ContractContextClass = (new (...args: any[]) => ContractContext) & {
  readonly [ASENA_CONTEXT_CONTRACT]: Readonly<RequestSchemas>;
};

export type DefineContext = (schemas: object) => ContractContextClass;

export interface Calls {
  handler: number;
}

export interface ContractFixture {
  components: Component[];
  calls: Calls;
}

export function inputFixture(define: DefineContext): ContractFixture {
  const calls: Calls = { handler: 0 };
  const Base = define({
    body: object({ name: string() }),
    query: object({ tag: string() }),
    params: object({ id: string() }),
    headers: object({ 'x-suite': string() }),
  });

  class InputContext extends Base {}

  @Controller('/contract')
  class ContractInputController {
    @Post('/input/:id')
    public input(context: InputContext) {
      calls.handler++;

      return context.send({
        subclass: context instanceof InputContext,
        body: context.input.body,
        query: context.input.query,
        params: context.input.params,
        headers: context.input.headers,
      });
    }
  }

  return { components: [ContractInputController], calls };
}

export function bodyFixture(define: DefineContext): ContractFixture {
  const calls: Calls = { handler: 0 };

  class StrictBodyContext extends define({ body: object({ name: string() }) }) {}

  class OptionalBodyContext extends define({ body: optional(object({ name: string() })) }) {}

  @Controller('/contract')
  class ContractBodyController {
    @Post('/body')
    public strict(context: StrictBodyContext) {
      calls.handler++;

      return context.send({ body: context.input.body });
    }

    @Post('/optional-body')
    public optional(context: OptionalBodyContext) {
      calls.handler++;

      return context.send({ hasBody: 'body' in context.input, bodyIsUndefined: context.input.body === undefined });
    }
  }

  return { components: [ContractBodyController], calls };
}

export interface OrderFixture extends ContractFixture {
  order: string[];
}

export function orderFixture(define: DefineContext): OrderFixture {
  const calls: Calls = { handler: 0 };
  const order: string[] = [];
  const query = traced('query', order, object({ q: string() }));
  const params = traced('params', order, object({ id: coerceNumber() }));
  const headers = traced('headers', order, object({ 'x-suite': string() }));

  class BodyOrderContext extends define({
    body: traced('body', order, object({ b: string() })),
    query,
    params,
    headers,
  }) {}

  class FormOrderContext extends define({
    form: traced('form', order, object({ f: string() })),
    query,
    params,
    headers,
  }) {}

  @Controller('/contract')
  class ContractOrderController {
    @Post('/order/:id')
    public body(context: BodyOrderContext) {
      calls.handler++;

      return context.send({ ok: true });
    }

    @Post('/form-order/:id')
    public form(context: FormOrderContext) {
      calls.handler++;

      return context.send({ ok: true });
    }
  }

  return { components: [ContractOrderController], calls, order };
}

export const FOREIGN_ADAPTER_ID = 'other';

export function foreignFixture(define: DefineContext): ContractFixture {
  const calls: Calls = { handler: 0 };

  class ForeignContext extends define({ query: object({}) }) {}

  Object.defineProperty(ForeignContext, ASENA_CONTEXT_ADAPTER, { value: FOREIGN_ADAPTER_ID });

  @Controller('/contract')
  class ContractForeignController {
    @Get('/foreign')
    public foreign(context: ForeignContext) {
      calls.handler++;

      return context.send({ ok: true });
    }
  }

  return { components: [ContractForeignController], calls };
}

export interface ConflictFixture extends ContractFixture {
  factoryCalls: { json: number };
}

export function conflictFixture(define: DefineContext): ConflictFixture {
  const calls: Calls = { handler: 0 };
  const factoryCalls = { json: 0 };

  class ConflictContext extends define({ body: object({ name: string() }) }) {}

  @Middleware({ validator: true })
  class ContractConflictValidator implements AsenaValidationService<unknown> {
    public json() {
      factoryCalls.json++;

      return { neutralSchema: true };
    }
  }

  @Controller('/contract')
  class ContractConflictController {
    @Post({ path: '/conflict', validator: ContractConflictValidator })
    public conflict(context: ConflictContext) {
      calls.handler++;

      return context.send({ ok: true });
    }
  }

  return { components: [ContractConflictController, ContractConflictValidator], calls, factoryCalls };
}

export interface TransformFixture extends ContractFixture {
  order: string[];
  middlewareSaw: string[];
}

function observeInput(context: AsenaContext<any, any>): string {
  try {
    return (context as Partial<ContractContext>).input === undefined ? 'undefined' : 'available';
  } catch {
    return 'throws';
  }
}

export function transformFixture(define: DefineContext): TransformFixture {
  const calls: Calls = { handler: 0 };
  const order: string[] = [];
  const middlewareSaw: string[] = [];

  class TransformContext extends define({
    body: traced('body', order, object({ name: string({ trim: true }) })),
    query: traced('query', order, object({ count: coerceNumber() })),
  }) {}

  @Middleware()
  class ContractObserveMiddleware extends AsenaMiddlewareService {
    public async handle(context: AsenaContext<any, any>, next: AsenaNextHandler) {
      order.push('middleware');
      middlewareSaw.push(observeInput(context));
      await next();
    }
  }

  @Config()
  class ContractTransformConfig implements AsenaConfig {
    public globalMiddlewares() {
      return [ContractObserveMiddleware];
    }
  }

  @Controller('/contract')
  class ContractTransformController {
    @Post('/transform')
    public transform(context: TransformContext) {
      calls.handler++;
      order.push('handler');

      return context.send({
        body: context.input.body,
        query: context.input.query,
        countType: typeof context.input.query.count,
      });
    }
  }

  return {
    components: [ContractTransformController, ContractObserveMiddleware, ContractTransformConfig],
    calls,
    order,
    middlewareSaw,
  };
}
