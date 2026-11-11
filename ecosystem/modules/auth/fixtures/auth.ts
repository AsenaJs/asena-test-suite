import type { AsenaContext, AsenaNextHandler } from '@asenajs/asena/adapter';
import { AUTH_GUARD_CLASS_KEY, AUTH_GUARD_METHODS_KEY, getAuthSession, Protected, Roles } from '@asenajs/asena/auth';
import { Config, Controller, Middleware, Service, WebSocket } from '@asenajs/asena/decorators';
import { All, Get, Post } from '@asenajs/asena/decorators/http';
import { Inject, OnStart } from '@asenajs/asena/decorators/ioc';
import { AsenaMiddlewareService, type AsenaValidationService } from '@asenajs/asena/middleware';
import { defineTypedMetadata } from '@asenajs/asena/utils';
import { AsenaWebSocketService } from '@asenajs/asena/web-socket';
import {
  applySessionCookie,
  AsenaAuthService,
  Auth,
  AuthGuard,
  AuthGuardMiddleware,
  AuthProviderRegistry,
  AuthSessionMiddleware,
  AuthWebSocketMiddleware,
  BetterAuth,
  type BetterAuthInstance,
  BetterAuthService,
  clearSessionCookie,
  getRawRequest,
} from '@asenajs/asena-auth';
import { type ZodType, z } from 'zod';

type Ctx = AsenaContext<any, any>;
type Component = new (...args: any[]) => unknown;
export type DefineContext = (schemas: object) => new (...args: any[]) => unknown;

export const SESSION_COOKIE = 'asena_session';
export const HOST_COOKIE = '__Host-session';
export const GUARD = [AuthGuard, AuthGuardMiddleware, AuthProviderRegistry];
export const ALL_AUTH = [...GUARD, AuthSessionMiddleware, AuthWebSocketMiddleware];

export interface AuthFixture {
  components: Component[];
  calls: string[];
}

export interface TokenSource {
  resolve<T>(name: string): Promise<T>;
}

export async function tokenFor(app: TokenSource, service: string, roles: string[] = []): Promise<string> {
  const auth = await app.resolve<AsenaAuthService>(service);

  return (await auth.createSession({ id: 'u1', roles })).token;
}

function orderedRoutes(calls: string[]): Component[] {
  @Middleware({ validator: true })
  class AuthItemValidator implements AsenaValidationService<ZodType> {
    public json() {
      return z.object({ name: z.string() }).superRefine(() => {
        calls.push('validator');
      });
    }
  }

  @Middleware()
  class AuthItemRecorder extends AsenaMiddlewareService {
    public async handle(_context: Ctx, next: AsenaNextHandler) {
      calls.push('recorder');
      await next();
    }
  }

  @Protected()
  @Controller('/items')
  class AuthItemController {
    @Post({ path: '/', validator: AuthItemValidator, middlewares: [AuthItemRecorder] })
    public create(context: Ctx) {
      calls.push('handler');

      return context.send({ ok: true });
    }
  }

  return [AuthItemValidator, AuthItemRecorder, AuthItemController];
}

/** A primary native provider that records every lookup, its login/logout routes, a guarded route and a socket. */
export function sessionFixture(define: DefineContext): AuthFixture {
  const calls: string[] = [];

  @Auth({ primary: true, sessionTtl: 3600 })
  class AppAuth extends AsenaAuthService {
    public override async getSession(request: Request) {
      calls.push('provider');

      return super.getSession(request);
    }
  }

  @Controller('/auth')
  class AuthLoginController {
    @Inject(AppAuth)
    private readonly auth!: AppAuth;

    @Post('/login')
    public async login(context: Ctx) {
      const { id, roles } = await context.getBody<{ id: string; roles: string[] }>();
      const { token } = await this.auth.createSession({ id, roles });

      await applySessionCookie(context, this.auth, token);

      return context.send({ token });
    }

    @Post('/logout')
    public async logout(context: Ctx) {
      await this.auth.logout(context);

      return context.send({ ok: true });
    }
  }

  @Protected()
  @Controller('/me')
  class AuthMeController {
    @Get('/')
    public me(context: Ctx) {
      return context.send({ user: getAuthSession(context)?.user.id });
    }
  }

  const ItemBody = define({ body: z.object({ name: z.string() }) }) as new (
    ...args: any[]
  ) => Ctx & { readonly input: Record<string, any> };

  class ItemBodyContext extends ItemBody {}

  @Protected()
  @Controller('/contract')
  class AuthContractController {
    @Post('/:id')
    public create(context: ItemBodyContext) {
      return context.send({ name: context.input.body.name, user: getAuthSession(context)?.user.id });
    }
  }

  @WebSocket({ path: '/chat', name: 'AuthChat', middlewares: [AuthWebSocketMiddleware] })
  class AuthChat extends AsenaWebSocketService {
    protected onOpen(ws: any) {
      ws.send(JSON.stringify(ws.data.values));
    }
  }

  return {
    components: [
      ...ALL_AUTH,
      AppAuth,
      AuthLoginController,
      AuthMeController,
      AuthContractController,
      AuthChat,
      ...orderedRoutes(calls),
    ],
    calls,
  };
}

/** Only the guard components: no session middleware, the provider does not record. */
export function guardOrderFixture(): AuthFixture {
  const calls: string[] = [];

  @Auth({ sessionTtl: 3600 })
  class GuardAuth extends AsenaAuthService {}

  return { components: [...GUARD, GuardAuth, ...orderedRoutes(calls)], calls };
}

/** A global AuthSessionMiddleware in front of a socket behind AuthWebSocketMiddleware. */
export function globalSessionSocketFixture(): Component[] {
  @Auth({ sessionTtl: 3600 })
  class SocketAuth extends AsenaAuthService {}

  @Config()
  class SocketSessionConfig {
    public globalMiddlewares() {
      return [AuthSessionMiddleware];
    }
  }

  @WebSocket({ path: '/chat', name: 'SessionChat', middlewares: [AuthWebSocketMiddleware] })
  class SessionChat extends AsenaWebSocketService {
    protected onOpen(ws: any) {
      ws.send(JSON.stringify(ws.data.values));
    }
  }

  return [
    AuthProviderRegistry,
    AuthSessionMiddleware,
    AuthWebSocketMiddleware,
    SocketAuth,
    SocketSessionConfig,
    SessionChat,
  ];
}

/** Sessions slide after half of `sessionTtl` and never outlive `absoluteTtl`; `/slide/admin` needs a role. */
export function slideFixture(globalSession: boolean): Component[] {
  @Auth({ sessionTtl: 100, absoluteTtl: 120 })
  class SlideAuth extends AsenaAuthService {}

  @Protected()
  @Controller('/slide')
  class SlideController {
    @Roles('admin')
    @Post('/admin')
    public admin(context: Ctx) {
      return context.send({ ok: true });
    }
  }

  @Config()
  class SlideSessionConfig {
    public globalMiddlewares() {
      return [AuthSessionMiddleware];
    }
  }

  return [...GUARD, AuthSessionMiddleware, SlideAuth, SlideController, ...(globalSession ? [SlideSessionConfig] : [])];
}

export function proxiedAppFixture(trustedOrigins: string[] | undefined): Component[] {
  @Auth({ primary: true, ...(trustedOrigins && { csrf: { trustedOrigins } }) })
  class ProxyAuth extends AsenaAuthService {}

  @Controller('/')
  class ProxyOriginProbe {
    @Get('/seen-origin')
    public seenOrigin(context: Ctx) {
      return context.send({ origin: new URL(getRawRequest(context).url).origin });
    }
  }

  @Protected()
  @Controller('/items')
  class ProxyItemController {
    @Post('/')
    public create(context: Ctx) {
      return context.send({ user: getAuthSession(context)?.user.id });
    }
  }

  @WebSocket({ path: '/chat', name: 'ProxyChat', middlewares: [AuthWebSocketMiddleware] })
  class ProxyChat extends AsenaWebSocketService {
    protected onOpen(ws: any) {
      ws.send(JSON.stringify({ open: true }));
    }
  }

  return [...ALL_AUTH, ProxyAuth, ProxyOriginProbe, ProxyItemController, ProxyChat];
}

export const FORWARDED_COOKIE_EXPIRES = new Date(Math.floor(Date.now() / 1000) * 1000 + 86_400_000);

/** A Better Auth instance whose session lookup answers with a Set-Cookie carrying every attribute. */
export function forwardedCookieFixture(): Component[] {
  const cookie =
    `ba.attrs=v%2Bx%3D; Domain=example.com; Path=/app; Expires=${FORWARDED_COOKIE_EXPIRES.toUTCString()}; ` +
    'Secure; HttpOnly; SameSite=None; Partitioned';
  const instance: BetterAuthInstance = {
    handler: async () => new Response(null, { status: 404 }),
    api: {
      getSession: async () => ({
        headers: new Headers([['set-cookie', cookie]]),
        response: {
          session: { id: 's1', userId: 'a1', createdAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) },
          user: { id: 'a1' },
        },
      }),
    },
  };

  @BetterAuth({ auth: instance })
  class AttributeAuth extends BetterAuthService {}

  @Protected({ provider: 'AttributeAuth' })
  @Controller('/attrs')
  class AttributeController {
    @Get('/')
    public me(context: Ctx) {
      return context.send({ user: getAuthSession(context)?.user.id });
    }
  }

  return [...GUARD, AttributeAuth, AttributeController];
}

export interface RoutePatternFixture {
  components: Component[];
  seen: string[];
}

function patternProbe(seen: string[]) {
  @Auth({})
  class PatternAuth extends AsenaAuthService {}

  @Middleware()
  class PatternProbe extends AsenaMiddlewareService {
    public async handle(context: Ctx, next: AsenaNextHandler) {
      seen.push(`${getRawRequest(context).method} ${context.routePattern}`);
      await next();
    }
  }

  return { PatternAuth, PatternProbe };
}

/** Guarded controllers whose route middleware records `METHOD routePattern` as the adapter reports it. */
export function routePatternFixture(define: DefineContext): RoutePatternFixture {
  const seen: string[] = [];
  const { PatternAuth, PatternProbe } = patternProbe(seen);

  @Protected()
  @Controller('/api/users')
  class PatternUsers {
    @Get({ path: '/', middlewares: [PatternProbe] })
    public list(context: Ctx) {
      return context.send('list');
    }

    @Get({ path: '/:id', middlewares: [PatternProbe] })
    public one(context: Ctx) {
      return context.send('one');
    }

    @Post({ path: '/', middlewares: [PatternProbe] })
    public create(context: Ctx) {
      return context.send('create');
    }

    @Get({ path: '/x/', middlewares: [PatternProbe] })
    public trailing(context: Ctx) {
      return context.send('trailing');
    }

    @All({ path: '/any', middlewares: [PatternProbe] })
    public any(context: Ctx) {
      return context.send('any');
    }
  }

  @Controller('/api/admins')
  class PatternAdmins extends PatternUsers {}

  @Protected()
  @Controller('/api/slash')
  class PatternNoTrailing {
    @Get({ path: '/x', middlewares: [PatternProbe] })
    public x(context: Ctx) {
      return context.send('x');
    }
  }

  const NameBody = define({ body: z.object({ name: z.string() }) }) as new (
    ...args: any[]
  ) => Ctx & { readonly input: Record<string, any> };

  class NameBodyContext extends NameBody {}

  @Protected()
  @Controller('/contract')
  class PatternContract {
    @Post({ path: '/:id', middlewares: [PatternProbe] })
    public create(context: NameBodyContext) {
      return context.send({ name: context.input.body.name, raw: getRawRequest(context) instanceof Request });
    }
  }

  return {
    components: [...GUARD, PatternAuth, PatternProbe, PatternUsers, PatternAdmins, PatternNoTrailing, PatternContract],
    seen,
  };
}

/** A guarded controller whose prefix and route path both lack the leading slash. */
export function unslashedPatternFixture(): RoutePatternFixture {
  const seen: string[] = [];
  const { PatternAuth, PatternProbe } = patternProbe(seen);

  @Protected()
  @Controller('plain')
  class PatternNoLeadingSlash {
    @Get({ path: 'y', middlewares: [PatternProbe] })
    public y(context: Ctx) {
      return context.send('y');
    }
  }

  return { components: [...GUARD, PatternAuth, PatternProbe, PatternNoLeadingSlash], seen };
}

/** A route middleware that injects a service by name, listed before it; both record their `@OnStart`. */
export function onStartOrderFixture(): AuthFixture {
  const calls: string[] = [];

  @Service('StartOrderDependency')
  class StartOrderDependency {
    @OnStart()
    public start() {
      calls.push('dependency');
    }
  }

  @Middleware()
  class StartOrderMiddleware extends AsenaMiddlewareService {
    @Inject('StartOrderDependency')
    public dependency!: StartOrderDependency;

    @OnStart()
    public start() {
      calls.push('middleware');
    }

    public async handle(_context: Ctx, next: AsenaNextHandler) {
      await next();
    }
  }

  @Controller('/start-order')
  class StartOrderController {
    @Get({ path: '/', middlewares: [StartOrderMiddleware] })
    public get(context: Ctx) {
      return context.send('ok');
    }
  }

  return { components: [StartOrderMiddleware, StartOrderDependency, StartOrderController], calls };
}

/** Two socket middlewares that each write a different value. */
export function socketValueFixture(): Component[] {
  @Middleware()
  class FirstValueWriter extends AsenaMiddlewareService {
    public async handle(context: Ctx, next: AsenaNextHandler) {
      context.setWebSocketValue({ a: 1 });
      await next();
    }
  }

  @Middleware()
  class SecondValueWriter extends AsenaMiddlewareService {
    public async handle(context: Ctx, next: AsenaNextHandler) {
      context.setWebSocketValue({ b: 2 });
      await next();
    }
  }

  @WebSocket({ path: '/values', name: 'ValueSocket', middlewares: [FirstValueWriter, SecondValueWriter] })
  class ValueSocket extends AsenaWebSocketService {
    protected onOpen(ws: any) {
      ws.send(JSON.stringify(ws.data.values));
    }
  }

  return [FirstValueWriter, SecondValueWriter, ValueSocket];
}

export function guardedSocketFixture(): Component[] {
  @Auth({})
  class SocketGuardAuth extends AsenaAuthService {}

  @WebSocket({ path: '/ws', name: 'GuardedSocket', middlewares: [AuthWebSocketMiddleware] })
  class GuardedSocket extends AsenaWebSocketService {}

  return [AuthProviderRegistry, AuthWebSocketMiddleware, SocketGuardAuth, GuardedSocket];
}

export type MarkLevel = 'class' | 'method';

/** A controller carrying a guard mark written straight into metadata, as a newer `@asenajs/asena` could. */
export function forgedMarkFixture(level: MarkLevel, mark: object): Component[] {
  @Auth({})
  class MarkAuth extends AsenaAuthService {}

  @Controller('/forged')
  class Forged {
    @Get('/')
    public get(context: Ctx) {
      return context.send('x');
    }
  }

  if (level === 'class') {
    defineTypedMetadata(AUTH_GUARD_CLASS_KEY, mark, Forged);
  } else {
    defineTypedMetadata(AUTH_GUARD_METHODS_KEY, new Map([['get', mark]]), Forged);
  }

  return [...GUARD, MarkAuth, Forged];
}

export function hostCookieFixture(): Component[] {
  @Auth({ cookie: { name: HOST_COOKIE } })
  class HostAuth extends AsenaAuthService {}

  @Controller('/auth')
  class HostLogoutController {
    @Inject(HostAuth)
    private readonly auth!: HostAuth;

    @Post('/logout')
    public async logout(context: Ctx) {
      await clearSessionCookie(context, this.auth);

      return context.send({ ok: true });
    }
  }

  return [HostAuth, HostLogoutController];
}
