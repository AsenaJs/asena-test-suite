import { join } from 'node:path';
import type { AsenaContext, AsenaNextHandler } from '@asenajs/asena/adapter';
import { Config, Controller, FrontendController, Middleware, Override, StaticServe } from '@asenajs/asena/decorators';
import { Get, Page } from '@asenajs/asena/decorators/http';
import { AsenaMiddlewareService, AsenaStaticServeService } from '@asenajs/asena/middleware';
import type { AsenaConfig } from '@asenajs/asena/server/config';

type Component = new (...args: any[]) => unknown;
type Ctx = AsenaContext<any, any>;

export const STATIC_ROOT = join(import.meta.dir, 'public');
export const OUTSIDE_SECRET = 'STATIC-SECRET-OUTSIDE-ROOT';
export const SIBLING_SECRET = 'STATIC-SECRET-SIBLING-ROOT';
export const PAGE_MARKER = '<h1>Asena Test</h1>';

export interface StaticProbe {
  rewrites: string[];
  found: string[];
  notFound: string[];
  configNotFound: string[];
  handler: number;
}

export interface StaticFixture {
  components: Component[];
  probe: StaticProbe;
}

export interface StaticFixtureOptions {
  overrideNotFound?: boolean;
  configNotFound?: boolean;
}

function newProbe(): StaticProbe {
  return { rewrites: [], found: [], notFound: [], configNotFound: [], handler: 0 };
}

function stripPrefix(path: string, prefix: string): string {
  const rest = path.startsWith(prefix) ? path.slice(prefix.length) : path;

  return rest === '/renamed.txt' ? '/hello.txt' : rest;
}

export function staticFixture(options: StaticFixtureOptions = {}): StaticFixture {
  const probe = newProbe();

  @StaticServe({ root: STATIC_ROOT })
  class ConformanceStaticServe extends AsenaStaticServeService<Ctx> {
    public rewriteRequestPath(path: string): string {
      probe.rewrites.push(path);

      return stripPrefix(path, '/static');
    }

    public onFound(path: string): void {
      probe.found.push(path);
    }

    public onNotFound(path: string): void {
      probe.notFound.push(path);
    }
  }

  @StaticServe({ root: STATIC_ROOT })
  class ConformanceOverrideStaticServe extends AsenaStaticServeService<Ctx> {
    public rewriteRequestPath(path: string): string {
      probe.rewrites.push(path);

      return stripPrefix(path, '/static');
    }

    @Override()
    public onNotFound(path: string): void {
      probe.notFound.push(path);
    }
  }

  const Serve = options.overrideNotFound ? ConformanceOverrideStaticServe : ConformanceStaticServe;

  @Controller('/static')
  class ConformanceStaticController {
    @Get({ path: '/*', staticServe: Serve })
    public serve(context: Ctx) {
      probe.handler++;

      return context.send({ fellThrough: true });
    }
  }

  @StaticServe({ root: STATIC_ROOT })
  class ConformanceInheritedStaticServe extends AsenaStaticServeService<Ctx> {
    public rewriteRequestPath(path: string): string {
      return stripPrefix(path, '/inherited-static');
    }
  }

  abstract class ConformanceStaticControllerBase {
    @Get({ path: '/*', staticServe: ConformanceInheritedStaticServe })
    public serve() {}
  }

  @Controller('/inherited-static')
  class ConformanceInheritedStaticController extends ConformanceStaticControllerBase {}

  const components: Component[] = [
    Serve,
    ConformanceStaticController,
    ConformanceInheritedStaticServe,
    ConformanceInheritedStaticController,
  ];

  if (options.configNotFound) {
    @Config()
    class ConformanceStaticConfig implements AsenaConfig {
      public onNotFound(context: Ctx, request: { path: string }) {
        probe.configNotFound.push(request.path);

        return context.send({ shaped: true }, 404);
      }
    }

    components.push(ConformanceStaticConfig);
  }

  return { components, probe };
}

export interface StaticMissProbe {
  before: Record<string, string | undefined>;
  notFound: Record<string, string | undefined>;
  fallback: string[];
  handler: number;
}

export interface StaticMissFixture {
  components: Component[];
  probe: StaticMissProbe;
}

function pathOf(context: Ctx): string {
  return new URL((context.req as { url: string }).url).pathname;
}

export function staticMissFixture(options: { fallback?: boolean } = {}): StaticMissFixture {
  const probe: StaticMissProbe = { before: {}, notFound: {}, fallback: [], handler: 0 };

  @StaticServe({ root: STATIC_ROOT })
  class ConformanceSiteAssetsServe extends AsenaStaticServeService<Ctx> {
    public rewriteRequestPath(path: string): string {
      return stripPrefix(path, '/site/assets');
    }
  }

  @Controller('/site/assets')
  class ConformanceSiteAssetsController {
    @Get({ path: '/:file', staticServe: ConformanceSiteAssetsServe })
    public serve(context: Ctx) {
      probe.handler++;

      return context.send({ assetsHandler: true });
    }
  }

  @Controller('/site')
  class ConformanceSiteFallbackController {
    @Get('/*')
    public fallback(context: Ctx) {
      probe.fallback.push(pathOf(context));

      return context.send({ fallback: true });
    }
  }

  @Middleware()
  class ConformanceSitePatternMiddleware extends AsenaMiddlewareService {
    public async handle(context: Ctx, next: AsenaNextHandler) {
      probe.before[pathOf(context)] = context.routePattern;
      await next();
    }
  }

  @Config()
  class ConformanceSiteConfig implements AsenaConfig {
    public globalMiddlewares() {
      return [ConformanceSitePatternMiddleware];
    }

    public onNotFound(context: Ctx, request: { path: string }) {
      probe.notFound[request.path] = context.routePattern;

      return context.send({ notFound: true }, 404);
    }
  }

  const components: Component[] = [
    ConformanceSiteAssetsServe,
    ConformanceSiteAssetsController,
    ConformanceSitePatternMiddleware,
    ConformanceSiteConfig,
  ];

  if (options.fallback) components.push(ConformanceSiteFallbackController);

  return { components, probe };
}

export function pageFixture(): Component[] {
  @FrontendController('/ui')
  class ConformanceUiFrontend {
    @Page('/')
    public home() {
      return import('./pages/home.html');
    }
  }

  abstract class ConformancePageBase {
    @Page('/home')
    public home() {
      return import('./pages/home.html');
    }
  }

  @FrontendController('/ui-inherited')
  class ConformanceInheritedFrontend extends ConformancePageBase {}

  return [ConformanceUiFrontend, ConformanceInheritedFrontend];
}

export function guardedPageFixture(): Component[] {
  @Middleware()
  class ConformanceDenyAllGuard extends AsenaMiddlewareService {
    public async handle(context: Ctx, _next: AsenaNextHandler) {
      return context.send({ denied: true }, 401);
    }
  }

  @Config()
  class ConformanceGuardConfig implements AsenaConfig {
    public globalMiddlewares() {
      return [ConformanceDenyAllGuard];
    }
  }

  @Controller('/guarded')
  class ConformanceGuardedController {
    @Get('/api')
    public api(context: Ctx) {
      return context.send({ reached: true });
    }
  }

  return [...pageFixture(), ConformanceDenyAllGuard, ConformanceGuardConfig, ConformanceGuardedController];
}

export function collidingPageFixture(): Component[] {
  @Controller('/collide')
  class ConformanceCollideController {
    @Get('/')
    public api(context: Ctx) {
      return context.send({ from: 'api' });
    }
  }

  @FrontendController('/collide')
  class ConformanceCollideFrontend {
    @Page('/')
    public page() {
      return import('./pages/home.html');
    }
  }

  return [ConformanceCollideController, ConformanceCollideFrontend];
}
