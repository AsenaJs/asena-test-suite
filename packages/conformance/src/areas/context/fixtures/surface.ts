import { type AsenaContext, type AsenaNextHandler, HttpException } from '@asenajs/asena/adapter';
import { Config, Controller, Middleware } from '@asenajs/asena/decorators';
import { Get, Post } from '@asenajs/asena/decorators/http';
import { AsenaMiddlewareService } from '@asenajs/asena/middleware';
import type { AsenaConfig } from '@asenajs/asena/server/config';

type Context = AsenaContext<any, any>;
type Component = new (...args: any[]) => unknown;

export const COOKIE_SECRET = 'context-cookie-secret';

export function querySurfaceFixture(): Component[] {
  @Controller('/ctx-query')
  class ContextQueryController {
    @Get('/one')
    public async one(context: Context) {
      const name = await context.getQuery('name');
      const blank = await context.getQuery('blank');

      return context.send({ name, blank });
    }

    @Get('/all')
    public async all(context: Context) {
      return context.send({ color: await context.getQueryAll('color') });
    }

    @Get('/every')
    public every(context: Context) {
      return context.send(context.getAllQueries());
    }

    @Get('/missing')
    public async missing(context: Context) {
      const one = await context.getQuery('nope');
      const all = await context.getQueryAll('nope');

      return context.send({
        one: one ?? 'undefined',
        every: context.getAllQueries(),
        all: (all as string[] | undefined) ?? 'undefined',
      });
    }
  }

  return [ContextQueryController];
}

export function headerSurfaceFixture(): Component[] {
  @Controller('/ctx-headers')
  class ContextHeadersController {
    @Get('/echo')
    public echo(context: Context) {
      return context.send(context.headers);
    }
  }

  return [ContextHeadersController];
}

export function cookieSurfaceFixture(): Component[] {
  @Controller('/ctx-cookie')
  class ContextCookieController {
    @Get('/read')
    public async read(context: Context) {
      const missing = await context.getCookie('nope');

      return context.send({
        session: await context.getCookie('session'),
        missing: (missing as string | false | undefined) ?? 'undefined',
      });
    }

    @Get('/set')
    public async set(context: Context) {
      await context.setCookie('theme', 'dark', {
        extraOptions: { path: '/', httpOnly: true, maxAge: 3600, sameSite: 'strict' },
      });

      return context.send({ set: true });
    }

    @Get('/delete')
    public async delete(context: Context) {
      await context.deleteCookie('theme', { extraOptions: { path: '/' } });

      return context.send({ deleted: true });
    }

    @Get('/sign')
    public async sign(context: Context) {
      await context.setCookie('signed', 'payload', { secret: COOKIE_SECRET, extraOptions: { path: '/' } });

      return context.send({ signed: true });
    }

    @Get('/read-signed')
    public async readSigned(context: Context) {
      return context.send({ value: await context.getCookie('signed', COOKIE_SECRET) });
    }
  }

  return [ContextCookieController];
}

const VALUE_KEY = 'ctx-request-id';

export function valueSurfaceFixture(): Component[] {
  @Middleware()
  class ContextValueMiddleware extends AsenaMiddlewareService {
    public async handle(context: Context, next: AsenaNextHandler) {
      const id = await context.getQuery('id');

      context.setValue(VALUE_KEY, id);
      await new Promise((resolve) => setTimeout(resolve, Number(id ?? 0) % 7));
      await next();
    }
  }

  @Controller({ path: '/ctx-value', middlewares: [ContextValueMiddleware] })
  class ContextValueController {
    @Get('/read')
    public async read(context: Context) {
      await new Promise((resolve) => setTimeout(resolve, 3));

      return context.send({ value: context.getValue<string>(VALUE_KEY) });
    }
  }

  return [ContextValueController, ContextValueMiddleware];
}

export interface AfterNextRecord {
  method: string;
  url: string;
  status: number;
}

export interface AfterNextFixture {
  components: Component[];
  records: AfterNextRecord[];
}

export function afterNextFixture(): AfterNextFixture {
  const records: AfterNextRecord[] = [];

  @Middleware()
  class ContextAfterNextMiddleware extends AsenaMiddlewareService {
    public async handle(context: Context, next: AsenaNextHandler) {
      await next();

      const req = context.req as { method: string; url: string };
      const res = context.res as Response;

      records.push({ method: req.method, url: req.url, status: res.status });
    }
  }

  @Controller('/ctx-after')
  class ContextAfterNextController {
    @Get('/ok')
    public ok(context: Context) {
      return context.send({ ok: true });
    }

    @Post('/created')
    public created(context: Context) {
      return context.send({ created: true }, 201);
    }

    @Get('/forbidden')
    public forbidden(): Response {
      throw new HttpException(403, { error: 'forbidden' });
    }
  }

  @Config()
  class ContextAfterNextConfig implements AsenaConfig {
    public globalMiddlewares() {
      return [ContextAfterNextMiddleware];
    }
  }

  return { components: [ContextAfterNextController, ContextAfterNextMiddleware, ContextAfterNextConfig], records };
}

export function responseSurfaceFixture(): Component[] {
  @Controller('/ctx-send')
  class ContextSendController {
    @Get('/object')
    public object(context: Context) {
      return context.send({ kind: 'object' });
    }

    @Get('/string')
    public string(context: Context) {
      return context.send('plain text');
    }

    @Get('/status')
    public status(context: Context) {
      return context.send({ kind: 'status' }, 201);
    }

    @Get('/options')
    public options(context: Context) {
      return context.send({ kind: 'options' }, { status: 202, headers: { 'x-send-option': 'yes' } });
    }

    @Get('/redirect')
    public redirect(context: Context) {
      return context.redirect('/ctx-send/object');
    }

    @Get('/html')
    public html(context: Context) {
      return context.html('<h1>hi</h1>');
    }

    @Get('/set-header')
    public setHeader(context: Context) {
      context.setResponseHeader!('x-over', 'first');
      context.setResponseHeader!('x-over', 'second');

      return context.send({ ok: true });
    }

    @Get('/append-header')
    public appendHeader(context: Context) {
      context.appendResponseHeader!('x-multi', 'a');
      context.appendResponseHeader!('x-multi', 'b');

      return context.send({ ok: true });
    }

    @Get('/ip')
    public ip(context: Context) {
      return context.send({ ip: context.getRequestIp!() });
    }
  }

  return [ContextSendController];
}
