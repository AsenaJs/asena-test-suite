import { type AsenaContext, type AsenaNextHandler, isHttpException } from '@asenajs/asena/adapter';
import { Config, Controller, Middleware } from '@asenajs/asena/decorators';
import { Post } from '@asenajs/asena/decorators/http';
import { AsenaMiddlewareService } from '@asenajs/asena/middleware';
import type { AsenaConfig } from '@asenajs/asena/server/config';

type Context = AsenaContext<unknown, Response>;
type Component = new (...args: any[]) => unknown;

async function describeEntry(entry: FormDataEntryValue | undefined) {
  if (entry === undefined) return { kind: 'missing' };
  if (typeof entry === 'string') return { kind: 'string', value: entry };

  return { kind: 'file', name: entry.name, size: entry.size, type: entry.type, text: await entry.text() };
}

export function bodyFixture(): Component[] {
  @Middleware()
  class ContextBodyPeekMiddleware extends AsenaMiddlewareService<Context> {
    public async handle(context: Context, next: AsenaNextHandler) {
      context.setValue('ctx-body-peek', await context.getBody());
      await next();
    }
  }

  @Controller('/ctx-body')
  class ContextBodyController {
    @Post('/json')
    public async json(context: Context) {
      return context.send({ body: await context.getBody() });
    }

    @Post('/array-buffer')
    public async arrayBuffer(context: Context) {
      const buffer = await context.getArrayBuffer();

      return context.send({
        isArrayBuffer: buffer instanceof ArrayBuffer,
        size: buffer.byteLength,
        bytes: [...new Uint8Array(buffer)],
      });
    }

    @Post('/blob')
    public async blob(context: Context) {
      const blob = await context.getBlob();

      return context.send({ isBlob: blob instanceof Blob, size: blob.size, type: blob.type, text: await blob.text() });
    }

    @Post('/form-data')
    public async formData(context: Context) {
      const form = await context.getFormData();

      return context.send({
        isFormData: form instanceof FormData,
        title: await describeEntry(form.get('title') ?? undefined),
        upload: await describeEntry(form.get('upload') ?? undefined),
      });
    }

    @Post('/parse-body')
    public async parseBody(context: Context) {
      const parsed = (await context.getParseBody()) as Record<string, FormDataEntryValue>;
      const described: Record<string, unknown> = {};

      for (const key of Object.keys(parsed).sort()) {
        described[key] = await describeEntry(parsed[key]);
      }

      return context.send(described);
    }

    @Post({ path: '/twice', middlewares: [ContextBodyPeekMiddleware] })
    public async twice(context: Context) {
      return context.send({ middleware: context.getValue('ctx-body-peek'), handler: await context.getBody() });
    }
  }

  return [ContextBodyController, ContextBodyPeekMiddleware];
}

export interface InvalidJsonFixture {
  components: Component[];
  calls: { handlerReturned: number };
}

export function invalidJsonFixture(): InvalidJsonFixture {
  const calls = { handlerReturned: 0 };

  @Controller('/ctx-body')
  class ContextInvalidJsonController {
    @Post('/invalid-json')
    public async invalid(context: Context) {
      const body = await context.getBody();

      calls.handlerReturned++;

      return context.send({ body });
    }
  }

  @Config()
  class ContextInvalidJsonConfig implements AsenaConfig {
    public onError(error: Error, context: Context) {
      if (isHttpException(error)) {
        return context.send({ httpException: true, status: error.status }, error.status);
      }

      return context.send({ httpException: false, name: error.name }, 599);
    }
  }

  return { components: [ContextInvalidJsonController, ContextInvalidJsonConfig], calls };
}
