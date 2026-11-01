import { expect } from 'bun:test';
import type { TestApp } from '@asenajs/asena/test';
import { bootApp } from '../../boot.ts';
import { getDescriptor } from '../../load.ts';
import { area, scenario } from '../../scenario.ts';
import {
  asyncContextFixture,
  contractOrderFixture,
  flowFixture,
  globalPatternFixture,
  inheritedClassMiddlewareFixture,
  siblingGuardFixture,
  TOKEN,
  undecoratedGuardFixture,
} from './fixtures/neutral.ts';

const JSON_HEADERS = { 'content-type': 'application/json' };
const AUTH = { authorization: TOKEN };
const UNAUTHORIZED = { error: 'unauthorized' };

const json = (body: unknown): RequestInit => ({ headers: JSON_HEADERS, body: JSON.stringify(body) });

export function register(): void {
  area('middleware', () => {
    scenario('P1.middleware.001', 'a global include pattern guards only the matching routes', async () => {
      const fixture = globalPatternFixture();
      await using app = await bootApp({ components: fixture.components });
      const denied = await app.get('/api/protected/data');

      expect(denied.status).toBe(401);
      expect(denied.json()).toEqual(UNAUTHORIZED);

      const allowed = await app.get('/api/protected/data', { headers: AUTH });

      expect(allowed.status).toBe(200);
      expect(allowed.json()).toEqual({ data: 'protected' });

      const open = await app.get('/api/public/data');

      expect(open.status).toBe(200);
      expect(open.json()).toEqual({ data: 'public' });
    });

    scenario('P1.middleware.002', 'a global exclude pattern skips the excluded route', async () => {
      const fixture = globalPatternFixture();
      await using app = await bootApp({ components: fixture.components });

      expect((await app.get('/health')).status).toBe(200);
      expect((await app.get('/api/public/data')).status).toBe(200);
      expect(fixture.stamped).toEqual(['/api/public/data']);
    });

    scenario('P1.middleware.003', 'global patterns apply to unmatched paths exactly as they match', async () => {
      const fixture = globalPatternFixture();
      await using app = await bootApp({ components: fixture.components });
      const guarded = await app.get('/api/protected/missing');

      expect(guarded.status).toBe(401);
      expect(guarded.json()).toEqual(UNAUTHORIZED);

      const passed = await app.get('/api/protected/missing', { headers: AUTH });

      expect(passed.status).toBe(404);
      expect(passed.json()).toEqual({ error: 'Not Found' });
      expect((await app.get('/elsewhere/missing')).status).toBe(404);
      expect((await app.get('/health/missing')).status).toBe(404);
      expect(fixture.stamped).toEqual(['/api/protected/missing', '/elsewhere/missing', '/health/missing']);
    });

    scenario(
      'P1.middleware.010',
      'order: global -> controller -> route -> legacy validator -> handler',
      async () => {
        const { legacyOrderFixture } = await import('./fixtures/zod.ts');
        const fixture = legacyOrderFixture();
        await using app = await bootApp({ components: fixture.components });

        expect((await app.post('/mw-order-legacy/run', json({ name: 'ada' }))).status).toBe(200);
        expect(fixture.order).toEqual(['global', 'controller', 'route', 'handler']);

        fixture.order.length = 0;

        expect((await app.post('/mw-order-legacy/run', json({ name: '' }))).status).toBe(400);
        expect(fixture.order).toEqual(['global', 'controller', 'route']);
      },
      { requires: ['optional.zodValidator'] },
    );

    scenario(
      'P1.middleware.011',
      'a class-level middleware is inherited by a subclass under another prefix',
      async () => {
        await using app = await bootApp({ components: inheritedClassMiddlewareFixture().components });
        const routes: [string, string, string][] = [
          ['/mw-reports/v1/summary', 'summary', 'MiddlewareReportsV1Controller'],
          ['/mw-reports/v2/summary', 'summary', 'MiddlewareReportsV2Controller'],
          ['/mw-reports/v2/extra', 'extra', 'MiddlewareReportsV2Controller'],
        ];

        for (const [path, route, servedBy] of routes) {
          expect({ path, status: (await app.get(path)).status }).toEqual({ path, status: 401 });

          const response = await app.get(path, { headers: AUTH });

          expect({ path, status: response.status }).toEqual({ path, status: 200 });
          expect({ path, body: response.json() }).toEqual({ path, body: { route, servedBy } });
        }
      },
    );

    scenario('P1.middleware.012', 'route middlewares of sibling routes on one path do not leak', async () => {
      await using app = await bootApp({ components: siblingGuardFixture().components });
      const read = { 'x-read-token': 'read-ok' };
      const admin = { 'x-admin-token': 'admin-ok' };

      const readWithRead = await app.get('/mw-items/1', { headers: read });

      expect(readWithRead.status).toBe(200);
      expect(readWithRead.json()).toEqual({ action: 'read', id: '1' });

      const readWithAdmin = await app.get('/mw-items/1', { headers: admin });

      expect(readWithAdmin.status).toBe(401);
      expect(readWithAdmin.json()).toEqual({ error: 'read token required' });

      const deleteWithRead = await app.delete('/mw-items/1', { headers: read });

      expect(deleteWithRead.status).toBe(401);
      expect(deleteWithRead.json()).toEqual({ error: 'admin token required' });

      const deleteWithAdmin = await app.delete('/mw-items/1', { headers: admin });

      expect(deleteWithAdmin.status).toBe(200);
      expect(deleteWithAdmin.json()).toEqual({ action: 'delete', id: '1' });
    });

    scenario('P1.middleware.013', 'an undecorated subclass of a decorated guard fails the boot', async () => {
      const fixture = undecoratedGuardFixture();
      let app: TestApp | undefined;
      let failure: unknown;

      try {
        app = await bootApp({ components: fixture.components });
      } catch (error) {
        failure = error;
      }

      await app?.stop();

      expect(app).toBeUndefined();
      expect(failure).toBeInstanceOf(Error);
      expect(fixture.ran).toEqual([]);
    });

    scenario('P1.middleware.014', 'order: global -> controller -> route -> context contract -> handler', async () => {
      const fixture = contractOrderFixture((schemas) => getDescriptor().defineContext(schemas));
      await using app = await bootApp({ components: fixture.components });

      expect((await app.post('/mw-order-contract/run', json({ name: 'ada' }))).status).toBe(200);
      expect(fixture.order).toEqual(['global', 'controller', 'route', 'handler']);

      fixture.order.length = 0;

      expect((await app.post('/mw-order-contract/run', json({ name: '' }))).status).toBe(400);
      expect(fixture.order).toEqual(['global', 'controller', 'route']);
    });

    scenario('P1.middleware.020', 'a middleware returning false answers 403 and the handler does not run', async () => {
      const fixture = flowFixture();
      await using app = await bootApp({ components: fixture.components });

      expect((await app.get('/mw-flow/deny')).status).toBe(403);
      expect(fixture.handlerRuns).toEqual([]);
    });

    scenario('P1.middleware.021', 'a middleware returning a Response short-circuits with it', async () => {
      const fixture = flowFixture();
      await using app = await bootApp({ components: fixture.components });
      const response = await app.get('/mw-flow/short');

      expect(response.status).toBe(299);
      expect(response.headers.get('x-short-circuit')).toBe('yes');
      expect(response.json()).toEqual({ shortCircuit: true });
      expect(fixture.handlerRuns).toEqual([]);
    });

    scenario(
      'P1.middleware.022',
      'a header a middleware adds after next() is on the response',
      async () => {
        const fixture = flowFixture();
        await using app = await bootApp({ components: fixture.components });
        const response = await app.get('/mw-flow/after');

        expect(response.status).toBe(200);
        expect(response.json()).toEqual({ reached: true });
        expect(fixture.handlerRuns).toEqual(['after']);
        expect(response.headers.get('x-after-next')).toBe('added');
      },
      { requires: ['middleware.codeAfterNextRuns'] },
    );

    scenario(
      'P1.middleware.030',
      'next() inside AsyncLocalStorage.run: the handler and an injected service see the store',
      async () => {
        await using app = await bootApp({ components: asyncContextFixture() });
        const responses = await Promise.all(
          Array.from({ length: 10 }, (_, i) => app.get('/mw-als/read', { headers: { 'x-request-id': `r${i}` } })),
        );

        expect(responses.map((response) => response.status)).toEqual(Array.from({ length: 10 }, () => 200));
        expect(responses.map((response) => response.json())).toEqual(
          Array.from({ length: 10 }, (_, i) => ({ handler: `r${i}`, service: `r${i}` })),
        );
      },
    );
  });
}
