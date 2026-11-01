import type { AsenaContext, AsenaNextHandler } from '@asenajs/asena/adapter';
import { Config, Controller, Middleware, Service } from '@asenajs/asena/decorators';
import { All, Connect, Delete, Get, Patch, Post, Put, Trace } from '@asenajs/asena/decorators/http';
import { Inject } from '@asenajs/asena/decorators/ioc';
import type { NotFoundRequest } from '@asenajs/asena/adapter';
import { AsenaMiddlewareService } from '@asenajs/asena/middleware';
import type { AsenaConfig } from '@asenajs/asena/server/config';

type Component = new (...args: any[]) => unknown;
type Ctx = AsenaContext<any, any>;

export interface Item {
  id: string;
  name: string;
}

export function crudFixture(): Component[] {
  @Service('RoutingItemService')
  class RoutingItemService {
    private readonly items = new Map<string, Item>();

    private next = 1;

    public list(): Item[] {
      return [...this.items.values()];
    }

    public create(name: string): Item {
      const item = { id: String(this.next++), name };

      this.items.set(item.id, item);

      return item;
    }

    public find(id: string): Item | undefined {
      return this.items.get(id);
    }

    public update(id: string, name: string): Item | undefined {
      const item = this.items.get(id);

      if (!item) return undefined;

      item.name = name;

      return item;
    }

    public remove(id: string): boolean {
      return this.items.delete(id);
    }
  }

  @Controller('/crud/items')
  class RoutingItemController {
    @Inject(RoutingItemService)
    private service!: RoutingItemService;

    @Get('/')
    public list(context: Ctx) {
      return context.send(this.service.list());
    }

    @Post('/')
    public async create(context: Ctx) {
      const { name } = await context.getBody<{ name: string }>();

      return context.send(this.service.create(name), 201);
    }

    @Get('/:id')
    public get(context: Ctx) {
      const item = this.service.find(context.getParam('id'));

      return item ? context.send(item) : context.send({ error: 'Item not found' }, 404);
    }

    @Put('/:id')
    public async update(context: Ctx) {
      const { name } = await context.getBody<{ name: string }>();
      const item = this.service.update(context.getParam('id'), name);

      return item ? context.send(item) : context.send({ error: 'Item not found' }, 404);
    }

    @Delete('/:id')
    public remove(context: Ctx) {
      return this.service.remove(context.getParam('id'))
        ? new Response(null, { status: 204 })
        : context.send({ error: 'Item not found' }, 404);
    }
  }

  return [RoutingItemController, RoutingItemService];
}

export function healthFixture(): Component[] {
  @Controller('/')
  class RoutingHealthController {
    @Get('/health')
    public health(context: Ctx) {
      return context.send({ status: 'ok', uptime: process.uptime() });
    }
  }

  return [RoutingHealthController];
}

export function paramsFixture(): Component[] {
  @Controller('/params')
  class RoutingParamsController {
    @Get('/one/:id')
    public one(context: Ctx) {
      return context.send({ id: context.getParam('id') });
    }

    @Get('/two/:group/:id')
    public two(context: Ctx) {
      return context.send({ group: context.getParam('group'), id: context.getParam('id') });
    }
  }

  return [RoutingParamsController];
}

export const SINGLE_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

export function methodsFixture(): Component[] {
  @Controller('/verbs')
  class RoutingVerbsController {
    @Get('/get')
    public get(context: Ctx) {
      return context.send({ handler: 'get' });
    }

    @Post('/post')
    public post(context: Ctx) {
      return context.send({ handler: 'post' });
    }

    @Put('/put')
    public put(context: Ctx) {
      return context.send({ handler: 'put' });
    }

    @Patch('/patch')
    public patch(context: Ctx) {
      return context.send({ handler: 'patch' });
    }

    @Delete('/delete')
    public delete(context: Ctx) {
      return context.send({ handler: 'delete' });
    }

    @All('/all')
    public all(context: Ctx) {
      return context.send({ handler: 'all' });
    }

    @Trace('/trace')
    public trace(context: Ctx) {
      return context.send({ handler: 'trace' });
    }

    @Connect('/connect')
    public connect(context: Ctx) {
      return context.send({ handler: 'connect' });
    }
  }

  return [RoutingVerbsController];
}

export function staticBeforeParamFixture(): Component[] {
  abstract class RoutingAccountsBase {
    @Get('/:id')
    public byId(context: Ctx) {
      return context.send({ handler: 'base.byId', id: context.getParam('id') });
    }
  }

  @Controller('/accounts')
  class RoutingAccountsController extends RoutingAccountsBase {
    @Get('/me')
    public me(context: Ctx) {
      return context.send({ handler: 'sub.me' });
    }
  }

  return [RoutingAccountsController];
}

export function trailingSlashFixture(): Component[] {
  @Controller('/slash')
  class RoutingSlashController {
    @Get('/x')
    public x(context: Ctx) {
      return context.send({ handler: 'x' });
    }
  }

  return [RoutingSlashController];
}

export function notFoundFixture(): Component[] {
  @Controller('/nf')
  class RoutingNotFoundController {
    @Get('/only-get')
    public onlyGet(context: Ctx) {
      return context.send({ handler: 'only-get' });
    }
  }

  @Config()
  class RoutingNotFoundConfig implements AsenaConfig {
    public onNotFound(context: Ctx, request: NotFoundRequest) {
      return context.send({ error: 'Not Found', path: request.path, method: request.method }, 404);
    }
  }

  return [RoutingNotFoundController, RoutingNotFoundConfig];
}

export function plainNotFoundFixture(): Component[] {
  @Controller('/plain')
  class RoutingPlainController {
    @Get('/here')
    public here(context: Ctx) {
      return context.send({ handler: 'here' });
    }
  }

  return [RoutingPlainController];
}

export function inheritanceFixture(): Component[] {
  abstract class RoutingInheritedBase {
    @Get('/base')
    public base(context: Ctx) {
      return context.send({ handler: 'base.base' });
    }

    @Get('/by-name')
    public byName(context: Ctx) {
      return context.send({ handler: 'base.byName' });
    }

    @Get('/decorated')
    public decorated(context: Ctx) {
      return context.send({ handler: 'base.decorated' });
    }
  }

  @Controller('/inherit')
  class RoutingInheritedController extends RoutingInheritedBase {
    @Get('/own')
    public own(context: Ctx) {
      return context.send({ handler: 'sub.own' });
    }

    public override byName(context: Ctx) {
      return context.send({ handler: 'sub.byName' });
    }

    @Get('/decorated')
    public override decorated(context: Ctx) {
      return context.send({ handler: 'sub.decorated' });
    }
  }

  abstract class RoutingPathOnlyBase {
    @Get('/ping')
    public ping(context: Ctx) {
      return context.send({ handler: 'pathOnly.ping' });
    }
  }

  @Controller('/path-only')
  class RoutingPathOnlyController extends RoutingPathOnlyBase {}

  return [RoutingInheritedController, RoutingPathOnlyController];
}

export const METADATA_ONLY_KEY = 'conformance:routing:metadata-only';

function MetadataOnly(): ClassDecorator & MethodDecorator {
  return (target: object, propertyKey?: string | symbol) => {
    if (propertyKey === undefined) Reflect.defineMetadata(METADATA_ONLY_KEY, true, target);
    else Reflect.defineMetadata(METADATA_ONLY_KEY, true, target, propertyKey);
  };
}

export function metadataOnlyFixture(): Component[] {
  @MetadataOnly()
  @Controller('/tagged')
  class RoutingTaggedController {
    @MetadataOnly()
    @Get('/method')
    public method(context: Ctx) {
      return context.send({ handler: 'tagged.method' });
    }

    @Get('/plain')
    public plain(context: Ctx) {
      return context.send({ handler: 'tagged.plain' });
    }
  }

  abstract class RoutingTaggedBase {
    @MetadataOnly()
    @Get('/dump')
    public dump(context: Ctx) {
      return context.send({ handler: 'taggedBase.dump' });
    }
  }

  @MetadataOnly()
  @Controller('/tagged-inherited')
  class RoutingTaggedInheritedController extends RoutingTaggedBase {}

  return [RoutingTaggedController, RoutingTaggedInheritedController];
}

export interface RoutePatternFixture {
  components: Component[];
  before: Record<string, string | undefined>;
  after: Record<string, string | undefined>;
}

export function routePatternFixture(): RoutePatternFixture {
  const before: RoutePatternFixture['before'] = {};
  const after: RoutePatternFixture['after'] = {};

  @Middleware()
  class RoutingPatternMiddleware extends AsenaMiddlewareService {
    public async handle(context: Ctx, next: AsenaNextHandler) {
      const path = new URL((context.req as { url: string }).url).pathname;

      before[path] = context.routePattern;
      await next();
      after[path] = context.routePattern;
    }
  }

  @Controller('/items')
  class RoutingPatternController {
    @Get('/:id')
    public item(context: Ctx) {
      return context.send({ id: context.getParam('id') });
    }
  }

  @Config()
  class RoutingPatternConfig implements AsenaConfig {
    public globalMiddlewares() {
      return [RoutingPatternMiddleware];
    }
  }

  return { components: [RoutingPatternController, RoutingPatternMiddleware, RoutingPatternConfig], before, after };
}
