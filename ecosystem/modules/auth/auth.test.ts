import { expect, setSystemTime } from 'bun:test';
import type { TestApp } from '@asenajs/asena/test';
import { bootApp, getDescriptor, scenario } from '@asenajs/adapter-conformance';
import type { AsenaAuthService } from '@asenajs/asena-auth';
import {
  FORWARDED_COOKIE_EXPIRES,
  forgedMarkFixture,
  forwardedCookieFixture,
  globalSessionSocketFixture,
  guardedSocketFixture,
  guardOrderFixture,
  HOST_COOKIE,
  hostCookieFixture,
  type MarkLevel,
  onStartOrderFixture,
  proxiedAppFixture,
  routePatternFixture,
  SESSION_COOKIE,
  sessionFixture,
  slideFixture,
  socketValueFixture,
  tokenFor,
} from './fixtures/auth.ts';
import { PUBLIC_HOST, PUBLIC_ORIGIN, startTlsTerminatingProxy } from './fixtures/proxy.ts';
import { connect } from './fixtures/socket.ts';

const zod = { requires: ['optional.zodValidator' as const] };
const routePattern = { requires: ['optional.routePattern' as const] };

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

async function bootSession(): Promise<TestApp & { calls: string[] }> {
  const { components, calls } = sessionFixture((schemas) => getDescriptor().defineContext(schemas));

  return Object.assign(await bootApp({ components }), { calls });
}

async function login(app: TestApp, roles: string[] = []) {
  const res = await fetch(`${app.baseUrl}/auth/login`, json({ id: 'u1', roles }));

  return { res, token: ((await res.json()) as { token: string }).token };
}

async function bootFailure(components: (new (...args: any[]) => unknown)[]): Promise<string> {
  const error = await bootApp({ components }).then(
    async (app) => {
      await app.stop();

      return null;
    },
    (e: unknown) => e,
  );
  const messages: string[] = [];

  for (let e = error as { message?: unknown; cause?: unknown } | null; e; e = e.cause as typeof e) {
    messages.push(String(e.message));
  }

  return messages.join(' <- ');
}

scenario(
  'P2.auth.001',
  'login sets an HttpOnly, SameSite=Lax session cookie on / as the client receives it',
  async () => {
    await using app = await bootSession();
    const { res, token } = await login(app);
    const cookie = res.headers.get('set-cookie') ?? '';

    expect(res.status).toBe(200);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie).toContain(`${SESSION_COOKIE}=${token}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toContain('Path=/');
  },
);

scenario('P2.auth.002', 'logout ends the session at once and clears the cookie with its attributes', async () => {
  await using app = await bootSession();
  const { token } = await login(app);
  const other = (await login(app)).token;
  const res = await fetch(`${app.baseUrl}/auth/logout`, { method: 'POST', headers: bearer(token) });
  const cleared = Bun.Cookie.parse(res.headers.getSetCookie()[0] ?? '');

  expect(res.status).toBe(200);
  expect(cleared.name).toBe(SESSION_COOKIE);
  expect(cleared.value).toBe('');
  expect(cleared.maxAge === 0 || (cleared.expires?.getTime() ?? Infinity) <= Date.now()).toBe(true);
  expect(cleared.path).toBe('/');
  expect(cleared.sameSite).toBe('lax');
  expect(cleared.secure).toBe(true);
  expect((await fetch(`${app.baseUrl}/me`, { headers: bearer(token) })).status).toBe(401);
  expect((await fetch(`${app.baseUrl}/me`, { headers: bearer(other) })).status).toBe(200);
});

scenario(
  'P2.auth.003',
  'the guard answers before the route middleware and the validator; then middleware, validator, handler',
  async () => {
    await using app = await bootSession();
    const { calls } = app;
    const { token } = await login(app);

    calls.length = 0;
    expect((await fetch(`${app.baseUrl}/items`, json({ name: 'x' }))).status).toBe(401);
    expect(calls).toEqual(['provider']);

    calls.length = 0;
    expect((await fetch(`${app.baseUrl}/items`, json({ name: 1 }, bearer(token)))).status).toBe(400);
    expect(calls).toEqual(['provider', 'recorder']);

    calls.length = 0;
    expect((await fetch(`${app.baseUrl}/items`, json({ name: 'x' }, bearer(token)))).status).toBe(200);
    expect(calls).toEqual(['provider', 'recorder', 'validator', 'handler']);
  },
  zod,
);

scenario(
  'P2.auth.004',
  'a @Protected Context.define route answers 401 before its contract validates the body',
  async () => {
    await using app = await bootSession();
    const { token } = await login(app);

    expect((await fetch(`${app.baseUrl}/contract/1`, json({ name: 1 }))).status).toBe(401);
    expect((await fetch(`${app.baseUrl}/contract/1`, json({ name: 1 }, bearer(token)))).status).toBe(400);

    const ok = await fetch(`${app.baseUrl}/contract/1`, json({ name: 'x' }, bearer(token)));

    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ name: 'x', user: 'u1' });
  },
);

scenario(
  'P2.auth.005',
  'WebSocket: a subprotocol token opens and the answer is `bearer`; an Authorization header opens; no token never opens',
  async () => {
    await using app = await bootSession();
    const { token } = await login(app);
    const viaProtocol = await connect(app.wsUrl('/chat'), { protocols: ['bearer', token] });

    expect(viaProtocol).toMatchObject({ opened: true, protocol: 'bearer' });
    expect(viaProtocol.opened && viaProtocol.message.authSession.user.id).toBe('u1');

    const viaHeader = await connect(app.wsUrl('/chat'), { headers: bearer(token) });

    expect(viaHeader.opened && viaHeader.message.authSession.user.id).toBe('u1');
    expect(await connect(app.wsUrl('/chat'))).toEqual({ opened: false });
  },
);

scenario(
  'P2.auth.006',
  'guard only: an anonymous request never reaches the route middleware, the validator or the handler',
  async () => {
    const { components, calls } = guardOrderFixture();

    await using app = await bootApp({ components });

    expect((await fetch(`${app.baseUrl}/items`, json({ name: 'x' }))).status).toBe(401);
    expect(calls).toEqual([]);
  },
  zod,
);

scenario(
  'P2.auth.007',
  'guard only: an authenticated request runs the route middleware, then the validator, then the handler',
  async () => {
    const { components, calls } = guardOrderFixture();

    await using app = await bootApp({ components });
    const token = await tokenFor(app, 'GuardAuth');

    expect((await fetch(`${app.baseUrl}/items`, json({ name: 'x' }, bearer(token)))).status).toBe(200);
    expect(calls).toEqual(['recorder', 'validator', 'handler']);
  },
  zod,
);

async function slidForbidden(globalSession: boolean): Promise<void> {
  await using app = await bootApp({ components: slideFixture(globalSession) });
  const auth = await app.resolve<AsenaAuthService>('SlideAuth');
  const t0 = Date.now();

  try {
    setSystemTime(new Date(t0));

    const { token } = await auth.createSession({ id: 'u1', roles: ['user'] });

    setSystemTime(new Date(t0 + 60_000));

    const res = await fetch(`${app.baseUrl}/slide/admin`, {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    const cookies = res.headers.getSetCookie().map((cookie) => Bun.Cookie.parse(cookie));

    expect(res.status).toBe(403);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]?.value).toBe(token);
    expect(cookies[0]?.maxAge).toBe(60);
  } finally {
    setSystemTime();
  }
}

scenario('P2.auth.008', 'guard only: a slid request the guard answers 403 still carries the re-issued cookie', () =>
  slidForbidden(false),
);

scenario(
  'P2.auth.009',
  'global AuthSessionMiddleware: a slid request the guard answers 403 still carries the re-issued cookie',
  () => slidForbidden(true),
);

interface Proxied {
  get: (path: string) => Promise<Response>;
  post: (headers: Record<string, string>) => Promise<Response>;
  upgrade: (headers: Record<string, string>) => Promise<boolean>;
}

async function behindProxy(trustedOrigins: string[] | undefined, fn: (proxied: Proxied) => Promise<void>) {
  await using app = await bootApp({ components: proxiedAppFixture(trustedOrigins) });
  await using proxy = startTlsTerminatingProxy(app.baseUrl);
  const { token } = await (await app.resolve<AsenaAuthService>('ProxyAuth')).createSession({ id: 'u1' });
  const cookie = `${SESSION_COOKIE}=${token}`;
  const base = `127.0.0.1:${proxy.port}`;

  await fn({
    get: (path) => fetch(`http://${base}${path}`, { headers: { host: PUBLIC_HOST } }),
    post: (headers) =>
      fetch(`http://${base}/items`, { method: 'POST', headers: { host: PUBLIC_HOST, cookie, ...headers } }),
    upgrade: async (headers) =>
      (await connect(`ws://${base}/chat`, { headers: { host: PUBLIC_HOST, cookie, ...headers } })).opened,
  });
}

const modernSameOrigin = { origin: PUBLIC_ORIGIN, 'sec-fetch-site': 'same-origin' };
const legacySameOrigin = { origin: PUBLIC_ORIGIN };
const modernCrossSite = { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };
const legacyCrossSite = { origin: 'https://evil.example' };
const modernSameSite = { origin: `https://admin.${PUBLIC_HOST}`, 'sec-fetch-site': 'same-site' };

const proxySetups = [
  {
    label: 'without trustedOrigins',
    trustedOrigins: undefined,
    legacyStatus: 401,
    ids: ['P2.auth.010', 'P2.auth.012', 'P2.auth.014', 'P2.auth.016', 'P2.auth.018', 'P2.auth.020'],
  },
  {
    label: 'with the public origin in trustedOrigins',
    trustedOrigins: [PUBLIC_ORIGIN],
    legacyStatus: 200,
    ids: ['P2.auth.011', 'P2.auth.013', 'P2.auth.015', 'P2.auth.017', 'P2.auth.019', 'P2.auth.021'],
  },
];

for (const { label, trustedOrigins, legacyStatus, ids } of proxySetups) {
  const [precondition, modern, legacy, crossSite, nonBrowser, upgrade] = ids;
  const title = (text: string) => `behind a TLS-terminating proxy, ${label}: ${text}`;

  scenario(precondition, title("the app sees the public host over plain http, not the browser's origin"), () =>
    behindProxy(trustedOrigins, async ({ get }) => {
      const seen = (await (await get('/seen-origin')).json()) as { origin: string };

      expect(seen.origin).toBe(`http://${PUBLIC_HOST}`);
    }),
  );

  scenario(modern, title('a modern browser same-origin cookie POST is authenticated'), () =>
    behindProxy(trustedOrigins, async ({ post }) => {
      const res = await post(modernSameOrigin);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ user: 'u1' });
    }),
  );

  scenario(
    legacy,
    title(`a legacy browser same-origin cookie POST is ${legacyStatus}; X-Forwarded-Proto is not trusted`),
    () =>
      behindProxy(trustedOrigins, async ({ post }) => {
        expect((await post(legacySameOrigin)).status).toBe(legacyStatus);
      }),
  );

  scenario(
    crossSite,
    title('cross-site cookie POSTs are 401 with and without Sec-Fetch-Site, and so is a same-site one'),
    () =>
      behindProxy(trustedOrigins, async ({ post }) => {
        expect((await post(modernCrossSite)).status).toBe(401);
        expect((await post(legacyCrossSite)).status).toBe(401);
        expect((await post(modernSameSite)).status).toBe(401);
      }),
  );

  scenario(nonBrowser, title('a cookie POST without Origin or Sec-Fetch-Site is authenticated'), () =>
    behindProxy(trustedOrigins, async ({ post }) => {
      expect((await post({})).status).toBe(200);
    }),
  );

  scenario(
    upgrade,
    title('a cookie upgrade opens same-origin, never cross-site, and legacy same-origin follows trustedOrigins'),
    () =>
      behindProxy(trustedOrigins, async ({ upgrade: open }) => {
        expect(await open(modernSameOrigin)).toBe(true);
        expect(await open(legacySameOrigin)).toBe(legacyStatus === 200);
        expect(await open(modernCrossSite)).toBe(false);
        expect(await open(legacyCrossSite)).toBe(false);
      }),
  );
}

scenario(
  'P2.auth.022',
  'a Set-Cookie forwarded from Better Auth keeps Domain, Path, Expires, Secure, HttpOnly, SameSite and Partitioned',
  async () => {
    await using app = await bootApp({ components: forwardedCookieFixture() });
    const res = await fetch(`${app.baseUrl}/attrs`);
    const cookie = Bun.Cookie.parse(res.headers.getSetCookie()[0] ?? '');

    expect(res.status).toBe(200);
    expect(cookie.name).toBe('ba.attrs');
    expect(cookie.value).toBe('v%2Bx%3D');
    expect(cookie.domain).toBe('example.com');
    expect(cookie.path).toBe('/app');
    expect(cookie.expires?.getTime()).toBe(FORWARDED_COOKIE_EXPIRES.getTime());
    expect(cookie.secure).toBe(true);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('none');
    expect(cookie.partitioned).toBe(true);
  },
);

const patterns = () => routePatternFixture((schemas) => getDescriptor().defineContext(schemas));

type PatternCase = [id: string, label: string, method: string, url: string, pattern: string];

const patternCases: PatternCase[] = [
  ['P2.auth.023', 'root route', 'GET', '/api/users', '/api/users'],
  ['P2.auth.024', 'param route', 'GET', '/api/users/7', '/api/users/:id'],
  ['P2.auth.025', 'POST with route middlewares', 'POST', '/api/users', '/api/users'],
  ['P2.auth.026', 'trailing-slash route', 'GET', '/api/users/x', '/api/users/x'],
  ['P2.auth.027', 'inherited root route', 'GET', '/api/admins', '/api/admins'],
  ['P2.auth.028', 'inherited param route', 'GET', '/api/admins/7', '/api/admins/:id'],
  ['P2.auth.029', 'no trailing slash (separate controller)', 'GET', '/api/slash/x', '/api/slash/x'],
  ['P2.auth.030', 'HEAD on a GET route', 'HEAD', '/api/users/7', '/api/users/:id'],
  ['P2.auth.031', '@All route, GET', 'GET', '/api/users/any', '/api/users/any'],
  ['P2.auth.032', '@All route, DELETE', 'DELETE', '/api/users/any', '/api/users/any'],
];

for (const [id, label, method, url, pattern] of patternCases) {
  scenario(
    id,
    `routePattern meets the guard's route key: ${label}`,
    async () => {
      const { components, seen } = patterns();

      await using app = await bootApp({ components });
      const token = await tokenFor(app, 'PatternAuth');
      const anonymous = await fetch(`${app.baseUrl}${url}`, { method });

      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get('www-authenticate')).toBe('Bearer');
      expect((await fetch(`${app.baseUrl}${url}`, { method, headers: bearer(token) })).status).toBe(200);
      expect(seen).toHaveLength(1);
      expect([`${method} ${pattern}`, `${method} ${pattern}/`]).toContain(seen[0]);
    },
    routePattern,
  );
}

scenario(
  'P2.auth.033',
  "routePattern meets the guard's route key: a Context.define route carries routePattern and the raw request",
  async () => {
    const { components, seen } = patterns();

    await using app = await bootApp({ components });
    const token = await tokenFor(app, 'PatternAuth');

    expect((await fetch(`${app.baseUrl}/contract/1`, json({ name: 'a' }))).status).toBe(401);

    const res = await fetch(`${app.baseUrl}/contract/1`, json({ name: 'a' }, bearer(token)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'a', raw: true });
    expect(seen).toEqual(['POST /contract/:id']);
  },
  routePattern,
);

scenario('P2.auth.035', '@OnStart runs on a dependency before its dependent, whatever the listing order', async () => {
  const { components, calls } = onStartOrderFixture();

  await using _app = await bootApp({ components });

  expect(calls).toEqual(['dependency', 'middleware']);
});

scenario('P2.auth.036', 'setWebSocketValue: a second write replaces the first, values do not merge', async () => {
  await using app = await bootApp({ components: socketValueFixture() });
  const outcome = await connect(app.wsUrl('/values'));

  expect(outcome.opened && outcome.message).toEqual({ b: 2 });
});

scenario(
  'P2.auth.037',
  'AuthWebSocketMiddleware: an upgrade without a session is answered 401 with WWW-Authenticate: Bearer',
  async () => {
    await using app = await bootApp({ components: guardedSocketFixture() });
    const res = await fetch(`${app.baseUrl}/ws`, {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  },
);

const forgedMarks: [id: string, level: MarkLevel, mark: object, what: string][] = [
  ['P2.auth.038', 'class', { access: 'restricted' }, "access 'restricted'"],
  ['P2.auth.039', 'method', { access: 'restricted' }, "access 'restricted'"],
  ['P2.auth.040', 'class', { access: 'protected', permissions: ['read'] }, "key 'permissions'"],
  ['P2.auth.041', 'method', { access: 'protected', permissions: ['read'] }, "key 'permissions'"],
];

for (const [id, level, mark, what] of forgedMarks) {
  scenario(id, `a ${level} guard mark ${JSON.stringify(mark)} this version cannot enforce fails the boot`, async () => {
    const message = await bootFailure(forgedMarkFixture(level, mark));

    expect(message).toContain(level === 'class' ? 'Forged' : 'Forged.get');
    expect(message).toContain(what);
    expect(message).toContain('upgrade @asenajs/asena-auth');
  });
}

scenario(
  'P2.auth.042',
  'a __Host- session cookie is deleted with Secure, so a browser accepts the deletion',
  async () => {
    await using app = await bootApp({ components: hostCookieFixture() });
    const res = await fetch(`${app.baseUrl}/auth/logout`, { method: 'POST' });
    const cleared = Bun.Cookie.parse(res.headers.getSetCookie()[0] ?? '');

    expect(res.status).toBe(200);
    expect(cleared.name).toBe(HOST_COOKIE);
    expect(cleared.value).toBe('');
    expect(cleared.maxAge === 0 || (cleared.expires?.getTime() ?? Infinity) <= Date.now()).toBe(true);
    expect(cleared.path).toBe('/');
    expect(cleared.secure).toBe(true);
  },
);

scenario(
  'P2.auth.043',
  'global AuthSessionMiddleware: a subprotocol token opens the socket, the answer is `bearer`, the session is carried',
  async () => {
    await using app = await bootApp({ components: globalSessionSocketFixture() });
    const token = await tokenFor(app, 'SocketAuth');
    const outcome = await connect(app.wsUrl('/chat'), { protocols: ['bearer', token] });

    expect(outcome).toMatchObject({ opened: true, protocol: 'bearer' });
    expect(outcome.opened && outcome.message.authSession.user.id).toBe('u1');
  },
);
