import { expect } from 'bun:test';
import { bootApp } from '../../boot.ts';
import { area, scenario } from '../../scenario.ts';
import {
  crudFixture,
  healthFixture,
  inheritanceFixture,
  metadataOnlyFixture,
  methodsFixture,
  notFoundFixture,
  paramsFixture,
  plainNotFoundFixture,
  rootWildcardFixture,
  routePatternFixture,
  SINGLE_METHODS,
  staticBeforeParamFixture,
  trailingSlashFixture,
} from './fixtures/controllers.ts';
import { rawRequest } from './rawHttp.ts';

const JSON_HEADERS = { 'content-type': 'application/json' };
const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const NOT_FOUND = { error: 'Not Found' };

const create = (name: string): RequestInit => ({ headers: JSON_HEADERS, body: JSON.stringify({ name }) });

export function register(): void {
  area('routing', () => {
    scenario('P1.routing.001', 'CRUD: an empty list answers 200 []', async () => {
      await using app = await bootApp({ components: crudFixture() });
      const response = await app.get('/crud/items');

      expect(response.status).toBe(200);
      expect(response.json()).toEqual([]);
    });

    scenario('P1.routing.002', 'CRUD: create answers 201 with the stored item', async () => {
      await using app = await bootApp({ components: crudFixture() });
      const response = await app.post('/crud/items', create('alpha'));

      expect(response.status).toBe(201);
      expect(response.json()).toEqual({ id: '1', name: 'alpha' });

      const list = await app.get('/crud/items');

      expect(list.status).toBe(200);
      expect(list.json()).toEqual([{ id: '1', name: 'alpha' }]);
    });

    scenario('P1.routing.003', 'CRUD: get by id answers the item', async () => {
      await using app = await bootApp({ components: crudFixture() });

      await app.post('/crud/items', create('alpha'));

      const response = await app.get('/crud/items/1');

      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ id: '1', name: 'alpha' });
    });

    scenario('P1.routing.004', 'CRUD: update answers the changed item and the change is stored', async () => {
      await using app = await bootApp({ components: crudFixture() });

      await app.post('/crud/items', create('alpha'));

      const response = await app.put('/crud/items/1', create('beta'));

      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ id: '1', name: 'beta' });
      expect((await app.get('/crud/items/1')).json()).toEqual({ id: '1', name: 'beta' });
    });

    scenario('P1.routing.005', 'CRUD: delete answers 204 with an empty body', async () => {
      await using app = await bootApp({ components: crudFixture() });

      await app.post('/crud/items', create('alpha'));

      const response = await app.delete('/crud/items/1');

      expect(response.status).toBe(204);
      expect(response.text()).toBe('');
    });

    scenario('P1.routing.006', 'CRUD: get after delete answers 404 with the handler body', async () => {
      await using app = await bootApp({ components: crudFixture() });

      await app.post('/crud/items', create('alpha'));
      await app.delete('/crud/items/1');

      const response = await app.get('/crud/items/1');

      expect(response.status).toBe(404);
      expect(response.json()).toEqual({ error: 'Item not found' });
    });

    scenario('P1.routing.007', 'GET /health answers status ok and a positive uptime', async () => {
      await using app = await bootApp({ components: healthFixture() });
      const response = await app.get('/health');

      expect(response.status).toBe(200);

      const body = response.json<{ status: unknown; uptime: unknown }>();

      expect(body.status).toBe('ok');
      expect(typeof body.uptime).toBe('number');
      expect(body.uptime as number).toBeGreaterThan(0);
    });

    scenario('P1.routing.010', 'a path parameter is echoed', async () => {
      await using app = await bootApp({ components: paramsFixture() });
      const response = await app.get('/params/one/abc');

      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ id: 'abc' });
    });

    scenario('P1.routing.011', 'two path parameters are both read', async () => {
      await using app = await bootApp({ components: paramsFixture() });
      const response = await app.get('/params/two/g1/i2');

      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ group: 'g1', id: 'i2' });
    });

    scenario('P1.routing.012', 'a URL-encoded path parameter is decoded', async () => {
      await using app = await bootApp({ components: paramsFixture() });
      const unicode = await app.get('/params/one/caf%C3%A9%20x');

      expect(unicode.status).toBe(200);
      expect(unicode.json()).toEqual({ id: 'café x' });

      const slash = await app.get('/params/one/a%2Fb');

      expect(slash.status).toBe(200);
      expect(slash.json()).toEqual({ id: 'a/b' });
    });

    scenario('P1.routing.020', 'each method decorator answers only its own method', async () => {
      await using app = await bootApp({ components: methodsFixture() });

      for (const route of SINGLE_METHODS) {
        for (const method of ALL_METHODS) {
          const response = await app.request(`/verbs/${route}`, { method });
          const matches = method === route.toUpperCase();

          expect({ route, method, status: response.status }).toEqual({ route, method, status: matches ? 200 : 404 });
          expect({ route, method, body: response.json() }).toEqual({
            route,
            method,
            body: matches ? { handler: route } : NOT_FOUND,
          });
        }
      }
    });

    scenario('P1.routing.021', '@All answers every method', async () => {
      await using app = await bootApp({ components: methodsFixture() });

      for (const method of ALL_METHODS) {
        const response = await app.request('/verbs/all', { method });

        expect({ method, status: response.status }).toEqual({ method, status: 200 });
        expect({ method, body: response.json() }).toEqual({ method, body: { handler: 'all' } });
      }
    });

    scenario('P1.routing.022', 'HEAD on a GET route answers the headers with an empty body', async () => {
      await using app = await bootApp({ components: methodsFixture() });
      const response = await app.head('/verbs/get');

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(response.text()).toBe('');
    });

    scenario('P1.routing.023', 'OPTIONS without CORS: 404 on a GET-only route, handled by @All', async () => {
      await using app = await bootApp({ components: methodsFixture() });
      const getOnly = await app.options('/verbs/get');

      expect(getOnly.status).toBe(404);
      expect(getOnly.json()).toEqual(NOT_FOUND);

      const all = await app.options('/verbs/all');

      expect(all.status).toBe(200);
      expect(all.json()).toEqual({ handler: 'all' });
    });

    scenario(
      'P1.routing.024',
      'TRACE over a raw socket: @Trace answers 200, a GET path 404, the server keeps serving',
      async () => {
        await using app = await bootApp({ components: methodsFixture() });

        expect((await rawRequest(app.port, 'TRACE /verbs/trace HTTP/1.1')).status).toBe(200);
        expect((await app.get('/verbs/get')).status).toBe(200);
        expect((await rawRequest(app.port, 'TRACE /verbs/get HTTP/1.1')).status).toBe(404);
        expect((await app.get('/verbs/get')).status).toBe(200);
      },
    );

    scenario(
      'P1.routing.025',
      'CONNECT over a raw socket: @Connect answers 200, a GET path 404, the server keeps serving',
      async () => {
        await using app = await bootApp({ components: methodsFixture() });

        expect((await rawRequest(app.port, 'CONNECT /verbs/connect HTTP/1.1')).status).toBe(200);
        expect((await app.get('/verbs/get')).status).toBe(200);
        expect((await rawRequest(app.port, 'CONNECT /verbs/get HTTP/1.1')).status).toBe(404);
        expect((await app.get('/verbs/get')).status).toBe(200);
      },
    );

    scenario('P1.routing.030', 'a static segment beats an inherited param segment registered first', async () => {
      await using app = await bootApp({ components: staticBeforeParamFixture() });
      const me = await app.get('/accounts/me');

      expect(me.status).toBe(200);
      expect(me.json()).toEqual({ handler: 'sub.me' });

      const byId = await app.get('/accounts/7');

      expect(byId.status).toBe(200);
      expect(byId.json()).toEqual({ handler: 'base.byId', id: '7' });
    });

    scenario('P1.routing.040', 'a trailing slash /x/ answers like /x on an API route', async () => {
      await using app = await bootApp({ components: trailingSlashFixture() });
      const plain = await app.get('/slash/x');

      expect(plain.status).toBe(200);

      const slashed = await app.get('/slash/x/');

      expect(slashed.status).toBe(200);
      expect(slashed.json()).toEqual(plain.json());
    });

    scenario(
      'P1.routing.050',
      'onNotFound receives the path without query and the upper-case method',
      async () => {
        await using app = await bootApp({ components: notFoundFixture() });
        const response = await app.post('/nf/missing/x?y=1');

        expect(response.status).toBe(404);
        expect(response.json()).toEqual({ error: 'Not Found', path: '/nf/missing/x', method: 'POST' });
      },
      { requires: ['optional.notFoundHook'] },
    );

    scenario(
      'P1.routing.051',
      'a method miss on an existing path goes through onNotFound with 404, not 405',
      async () => {
        await using app = await bootApp({ components: notFoundFixture() });
        const response = await app.patch('/nf/only-get?q=2');

        expect(response.status).toBe(404);
        expect(response.json()).toEqual({ error: 'Not Found', path: '/nf/only-get', method: 'PATCH' });
      },
      { requires: ['optional.notFoundHook'] },
    );

    scenario('P1.routing.052', 'without any config an unmatched request answers the default 404', async () => {
      await using app = await bootApp({ components: plainNotFoundFixture() });
      const response = await app.get('/plain/missing');

      expect(response.status).toBe(404);
      expect(response.json()).toEqual(NOT_FOUND);
    });

    scenario(
      'P1.routing.053',
      'a user /* route on a root controller answers every path no other route owns',
      async () => {
        await using app = await bootApp({ components: rootWildcardFixture() });

        for (const path of ['/elsewhere/x', '/rw/missing', '/a.txt']) {
          const response = await app.get(path);

          expect({ path, status: response.status, body: response.json() }).toEqual({
            path,
            status: 200,
            body: { wildcard: path },
          });
        }

        const owned = await app.get('/rw/here');

        expect(owned.status).toBe(200);
        expect(owned.json()).toEqual({ handler: 'here' });
      },
    );

    scenario(
      'P1.routing.060',
      'route inheritance: base, own, override by name, decorated override, path-only',
      async () => {
        await using app = await bootApp({ components: inheritanceFixture() });
        const expected: [string, string][] = [
          ['/inherit/base', 'base.base'],
          ['/inherit/own', 'sub.own'],
          ['/inherit/by-name', 'sub.byName'],
          ['/inherit/decorated', 'sub.decorated'],
          ['/path-only/ping', 'pathOnly.ping'],
        ];

        for (const [path, handler] of expected) {
          const response = await app.get(path);

          expect({ path, status: response.status }).toEqual({ path, status: 200 });
          expect({ path, body: response.json() }).toEqual({ path, body: { handler } });
        }
      },
    );

    scenario('P1.routing.061', 'a metadata-only decorator does not change routing', async () => {
      await using app = await bootApp({ components: metadataOnlyFixture() });
      const expected: [string, string][] = [
        ['/tagged/method', 'tagged.method'],
        ['/tagged/plain', 'tagged.plain'],
        ['/tagged-inherited/dump', 'taggedBase.dump'],
      ];

      for (const [path, handler] of expected) {
        const response = await app.get(path);

        expect({ path, status: response.status }).toEqual({ path, status: 200 });
        expect({ path, body: response.json() }).toEqual({ path, body: { handler } });
      }
    });

    scenario(
      'P1.routing.070',
      'ctx.routePattern read after next() in a global middleware is the matched pattern',
      async () => {
        const fixture = routePatternFixture();
        await using app = await bootApp({ components: fixture.components });
        const response = await app.get('/items/42');

        expect(response.status).toBe(200);
        expect(response.json()).toEqual({ id: '42' });
        expect(fixture.after['/items/42']).toBe('/items/:id');
      },
      { requires: ['optional.routePattern'] },
    );

    scenario(
      'P1.routing.071',
      'an unmatched request exposes no route pattern to a global middleware',
      async () => {
        const fixture = routePatternFixture();
        await using app = await bootApp({ components: fixture.components });
        const response = await app.get('/nothing/here');

        expect(response.status).toBe(404);
        expect('/nothing/here' in fixture.before).toBe(true);
        expect(fixture.before['/nothing/here']).toBeUndefined();
      },
      { requires: ['optional.routePattern'] },
    );
  });
}
