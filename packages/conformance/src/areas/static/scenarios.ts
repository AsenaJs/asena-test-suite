import { join } from 'node:path';
import { expect } from 'bun:test';
import { bootApp } from '../../boot.ts';
import { area, scenario } from '../../scenario.ts';
import {
  collidingPageFixture,
  guardedPageFixture,
  OUTSIDE_SECRET,
  PAGE_MARKER,
  pageFixture,
  SIBLING_SECRET,
  spaStaticFixture,
  STATIC_ROOT,
  staticFixture,
  staticMissFixture,
} from './fixtures/components.ts';
import { rawGet } from './raw.ts';

const NOT_FOUND = { error: 'Not Found' };

const NOT_FOUND_TRAVERSAL = [
  '/static/../secret/secret.txt',
  '/static/%2e%2e/secret/secret.txt',
  '/static/%252e%252e%252fsecret%252fsecret.txt',
  '/static/..\\secret\\secret.txt',
  '/static/..%5csecret%5csecret.txt',
  '/static/../../../../../../../../etc/passwd',
];

const ESCAPING_TRAVERSAL = [
  '/static/..%2fsecret%2fsecret.txt',
  '/static/%2e%2e%2fsecret%2fsecret.txt',
  '/static/..%2fpublic-private%2fcredentials.txt',
];

const MALFORMED = ['/static/%zz.txt', '/static/100%.txt', '/static/%e0%a4%a.txt'];

const IN_ROOT_ENCODED_SLASH = ['/static/sub%2Ffile.txt', '/static/sub%2ffile.txt'];

const NUL_PATHS = ['/static/a%00.txt', '/static/hello.txt%00'];

function fileText(name: string): Promise<string> {
  return Bun.file(join(STATIC_ROOT, name)).text();
}

export function register(): void {
  area('static', () => {
    scenario('P1.static.001', 'a static file is served with its exact body and a matching content-type', async () => {
      await using app = await bootApp({ components: staticFixture().components });

      const text = await app.get('/static/hello.txt');

      expect(text.status).toBe(200);
      expect(text.text()).toBe(await fileText('hello.txt'));
      expect(text.headers.get('content-type')).toContain('text/plain');

      const json = await app.get('/static/data.json');

      expect(json.status).toBe(200);
      expect(json.text()).toBe(await fileText('data.json'));
      expect(json.headers.get('content-type')).toContain('application/json');
    });

    scenario('P1.static.002', 'a missing static file answers 404 without reaching the route handler', async () => {
      const fixture = staticFixture();
      await using app = await bootApp({ components: fixture.components });
      const response = await app.get('/static/missing.txt');

      expect(response.status).toBe(404);
      expect(response.json()).toEqual(NOT_FOUND);
      expect(fixture.probe.handler).toBe(0);
    });

    scenario(
      'P1.static.003',
      'rewriteRequestPath receives the request path and its result picks the file',
      async () => {
        const fixture = staticFixture();
        await using app = await bootApp({ components: fixture.components });
        const response = await app.get('/static/renamed.txt');

        expect(response.status).toBe(200);
        expect(response.text()).toBe(await fileText('hello.txt'));
        expect(fixture.probe.rewrites).toEqual(['/static/renamed.txt']);
      },
    );

    scenario('P1.static.004', 'onFound is called once with the path of the served file', async () => {
      const fixture = staticFixture();
      await using app = await bootApp({ components: fixture.components });
      const response = await app.get('/static/hello.txt');

      expect(response.status).toBe(200);
      expect(fixture.probe.found).toHaveLength(1);
      expect(fixture.probe.found[0].endsWith('/hello.txt')).toBe(true);
      expect(fixture.probe.notFound).toEqual([]);
    });

    scenario('P1.static.005', 'onNotFound is called once with the path of the missing file', async () => {
      const fixture = staticFixture();
      await using app = await bootApp({ components: fixture.components });
      const response = await app.get('/static/missing.txt');

      expect(response.status).toBe(404);
      expect(fixture.probe.notFound).toHaveLength(1);
      expect(fixture.probe.notFound[0].endsWith('/missing.txt')).toBe(true);
      expect(fixture.probe.found).toEqual([]);
    });

    scenario(
      'P1.static.006',
      'an @Override onNotFound marks the miss handled and the route handler answers',
      async () => {
        const fixture = staticFixture({ overrideNotFound: true });
        await using app = await bootApp({ components: fixture.components });

        const missing = await app.get('/static/missing.txt');

        expect(fixture.probe.notFound).toHaveLength(1);
        expect(missing.status).toBe(200);
        expect(missing.json()).toEqual({ fellThrough: true });
        expect(fixture.probe.handler).toBe(1);

        const present = await app.get('/static/hello.txt');

        expect(present.status).toBe(200);
        expect(present.text()).toBe(await fileText('hello.txt'));
        expect(fixture.probe.handler).toBe(1);
      },
      { requires: ['static.overrideNotFoundContinuesToHandler'] },
    );

    scenario('P1.static.007', 'an inherited static route serves under the subclass prefix', async () => {
      await using app = await bootApp({ components: staticFixture().components });

      const found = await app.get('/inherited-static/hello.txt');

      expect(found.status).toBe(200);
      expect(found.text()).toBe(await fileText('hello.txt'));

      const missing = await app.get('/inherited-static/missing.txt');

      expect(missing.status).toBe(404);
    });

    scenario(
      'P1.static.008',
      'a missing static file is answered by the config onNotFound after the file hook ran',
      async () => {
        const fixture = staticFixture({ configNotFound: true });
        await using app = await bootApp({ components: fixture.components });
        const response = await app.get('/static/missing.txt');

        expect(response.status).toBe(404);
        expect(response.json()).toEqual({ shaped: true });
        expect(fixture.probe.notFound).toHaveLength(1);
        expect(fixture.probe.configNotFound).toEqual(['/static/missing.txt']);
        expect(fixture.probe.handler).toBe(0);
      },
      { requires: ['optional.notFoundHook'] },
    );

    scenario('P1.static.010', 'path traversal never serves a file outside the static root', async () => {
      const fixture = staticFixture();
      await using app = await bootApp({ components: fixture.components });
      const seen: [string, number][] = [];

      for (const target of [...NOT_FOUND_TRAVERSAL, ...ESCAPING_TRAVERSAL]) {
        const response = await rawGet(app.port, target);

        expect(response.body).not.toContain(OUTSIDE_SECRET);
        expect(response.body).not.toContain(SIBLING_SECRET);
        expect(response.body).not.toContain('root:');
        seen.push([target, response.status]);
      }

      expect(seen.slice(0, NOT_FOUND_TRAVERSAL.length)).toEqual(NOT_FOUND_TRAVERSAL.map((target) => [target, 404]));
      expect(fixture.probe.found).toEqual([]);
      expect(fixture.probe.handler).toBe(0);
    });

    scenario(
      'P1.static.011',
      'a static path is decoded once: a malformed escape answers 400, a path escaping the root 403',
      async () => {
        await using app = await bootApp({ components: staticFixture().components });
        const seen: [string, number][] = [];

        for (const target of [...MALFORMED, ...ESCAPING_TRAVERSAL]) {
          seen.push([target, (await rawGet(app.port, target)).status]);
        }

        expect(seen).toEqual([
          ...MALFORMED.map((target): [string, number] => [target, 400]),
          ...ESCAPING_TRAVERSAL.map((target): [string, number] => [target, 403]),
        ]);
      },
      { requires: ['static.encodedPathIsDecodedAndChecked'] },
    );

    scenario(
      'P1.static.012',
      'an encoded slash inside the root is decoded once and the file it names is served',
      async () => {
        const fixture = staticFixture();
        await using app = await bootApp({ components: fixture.components });
        const subFile = await fileText('sub/file.txt');
        const seen: [string, number, string][] = [];

        for (const target of IN_ROOT_ENCODED_SLASH) {
          const response = await rawGet(app.port, target);

          seen.push([target, response.status, response.body]);
        }

        expect(seen).toEqual(IN_ROOT_ENCODED_SLASH.map((target): [string, number, string] => [target, 200, subFile]));

        const missing = await rawGet(app.port, '/static/sub%2Fmissing.txt');

        expect(missing.status).toBe(404);
        expect(JSON.parse(missing.body)).toEqual(NOT_FOUND);
        expect(fixture.probe.rewrites).toEqual([
          '/static/sub/file.txt',
          '/static/sub/file.txt',
          '/static/sub/missing.txt',
        ]);
        expect(fixture.probe.found.map((path) => path.endsWith('/sub/file.txt'))).toEqual([true, true]);
        expect(fixture.probe.notFound.map((path) => path.endsWith('/sub/missing.txt'))).toEqual([true]);
        expect(fixture.probe.handler).toBe(0);
      },
      { requires: ['static.encodedSlashInRootIsServed'] },
    );

    scenario(
      'P1.static.013',
      'on a static miss a global middleware and the config onNotFound read the static route pattern',
      async () => {
        const fixture = staticMissFixture();
        await using app = await bootApp({ components: fixture.components });

        const missing = await app.get('/site/assets/missing.txt');

        expect(missing.status).toBe(404);
        expect(missing.json()).toEqual({ notFound: true });
        expect(fixture.probe.before).toEqual({ '/site/assets/missing.txt': '/site/assets/:file' });
        expect(fixture.probe.notFound).toEqual({ '/site/assets/missing.txt': '/site/assets/:file' });

        const present = await app.get('/site/assets/hello.txt');

        expect(present.status).toBe(200);
        expect(present.text()).toBe(await fileText('hello.txt'));
        expect(fixture.probe.before['/site/assets/hello.txt']).toBe('/site/assets/:file');
        expect(fixture.probe.handler).toBe(0);
      },
      { requires: ['optional.routePattern', 'optional.notFoundHook', 'static.missKeepsRoutePattern'] },
    );

    scenario(
      'P1.static.014',
      'a static miss ends in the config onNotFound and never falls through to a matching wildcard route',
      async () => {
        const fixture = staticMissFixture({ fallback: 'site' });
        await using app = await bootApp({ components: fixture.components });

        const missing = await app.get('/site/assets/missing.txt');

        expect(missing.status).toBe(404);
        expect(missing.json()).toEqual({ notFound: true });
        expect(Object.keys(fixture.probe.notFound)).toEqual(['/site/assets/missing.txt']);
        expect(fixture.probe.fallback).toEqual([]);

        const present = await app.get('/site/assets/hello.txt');

        expect(present.status).toBe(200);
        expect(present.text()).toBe(await fileText('hello.txt'));

        const outside = await app.get('/site/other');

        expect(outside.status).toBe(200);
        expect(outside.json()).toEqual({ fallback: true });
        expect(fixture.probe.fallback).toEqual(['/site/other']);
        expect(fixture.probe.handler).toBe(0);
      },
      { requires: ['optional.notFoundHook', 'static.missDoesNotFallThrough'] },
    );

    scenario(
      'P1.static.015',
      'a static path that decodes to a NUL byte ends as not found',
      async () => {
        const fixture = staticFixture();
        await using app = await bootApp({ components: fixture.components });
        const seen: [string, number, string][] = [];

        for (const target of NUL_PATHS) {
          const response = await rawGet(app.port, target);

          seen.push([target, response.status, response.body]);
        }

        expect(seen).toEqual(
          NUL_PATHS.map((target): [string, number, string] => [target, 404, JSON.stringify(NOT_FOUND)]),
        );
        expect(fixture.probe.notFound).toHaveLength(NUL_PATHS.length);
        expect(fixture.probe.found).toEqual([]);
        expect(fixture.probe.handler).toBe(0);
      },
      { requires: ['static.nulPathIsNotFound'] },
    );

    scenario(
      'P1.static.016',
      'a static /* route on a root controller serves existing files and runs its miss path',
      async () => {
        const fixture = spaStaticFixture();
        await using app = await bootApp({ components: fixture.components });

        const hello = await app.get('/hello.txt');

        expect(hello.status).toBe(200);
        expect(hello.text()).toBe(await fileText('hello.txt'));

        const nested = await app.get('/sub/file.txt');

        expect(nested.status).toBe(200);
        expect(nested.text()).toBe(await fileText('sub/file.txt'));

        const missing = await app.get('/missing.txt');

        expect(missing.status).toBe(404);
        expect(missing.json()).toEqual({ shaped: true });
        expect(fixture.probe.rewrites).toEqual(['/hello.txt', '/sub/file.txt', '/missing.txt']);
        expect(
          fixture.probe.found.map((path) => path.endsWith('/hello.txt') || path.endsWith('/sub/file.txt')),
        ).toEqual([true, true]);
        expect(fixture.probe.notFound.map((path) => path.endsWith('/missing.txt'))).toEqual([true]);
        expect(fixture.probe.configNotFound).toEqual(['/missing.txt']);
        expect(fixture.probe.handler).toBe(0);
      },
      { requires: ['optional.notFoundHook', 'routing.userRootWildcardAnswers'] },
    );

    scenario(
      'P1.static.017',
      'a static miss never falls through to a top-level /* route, which still answers other paths',
      async () => {
        const fixture = staticMissFixture({ fallback: 'root' });
        await using app = await bootApp({ components: fixture.components });

        const missing = await app.get('/site/assets/missing.txt');

        expect(missing.status).toBe(404);
        expect(missing.json()).toEqual({ notFound: true });
        expect(Object.keys(fixture.probe.notFound)).toEqual(['/site/assets/missing.txt']);
        expect(fixture.probe.fallback).toEqual([]);

        const present = await app.get('/site/assets/hello.txt');

        expect(present.status).toBe(200);
        expect(present.text()).toBe(await fileText('hello.txt'));

        const outside = await app.get('/other');

        expect(outside.status).toBe(200);
        expect(outside.json()).toEqual({ fallback: true });
        expect(fixture.probe.fallback).toEqual(['/other']);
        expect(fixture.probe.handler).toBe(0);
      },
      {
        requires: ['optional.notFoundHook', 'static.missDoesNotFallThrough', 'routing.userRootWildcardAnswers'],
      },
    );

    scenario('P1.static.020', 'a @Page route serves the HTML page', async () => {
      await using app = await bootApp({ components: pageFixture() });
      const response = await app.get('/ui');

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.text()).toContain(PAGE_MARKER);
    });

    scenario('P1.static.021', 'a @Page route answers its trailing-slash spelling too', async () => {
      await using app = await bootApp({ components: pageFixture() });
      const response = await app.get('/ui/');

      expect(response.status).toBe(200);
      expect(response.text()).toContain(PAGE_MARKER);
    });

    scenario('P1.static.022', 'a @Page declared on a base class is served under the subclass prefix', async () => {
      await using app = await bootApp({ components: pageFixture() });

      for (const path of ['/ui-inherited/home', '/ui-inherited/home/']) {
        const response = await app.get(path);

        expect([path, response.status]).toEqual([path, 200]);
        expect(response.text()).toContain(PAGE_MARKER);
      }
    });

    scenario('P1.static.023', 'an HTML route bypasses a global guard that blocks API routes', async () => {
      await using app = await bootApp({ components: guardedPageFixture() });

      const api = await app.get('/guarded/api');

      expect(api.status).toBe(401);
      expect(api.json()).toEqual({ denied: true });

      const page = await app.get('/ui');

      expect(page.status).toBe(200);
      expect(page.text()).toContain(PAGE_MARKER);
    });

    scenario('P1.static.024', 'a @Page on the path of an API route is rejected at boot', async () => {
      let bootError: unknown;

      try {
        const app = await bootApp({ components: collidingPageFixture() });

        await app.stop();
      } catch (error) {
        bootError = error;
      }

      expect(bootError).toBeInstanceOf(Error);
      expect((bootError as Error).message).toMatch(/HTML route collision/);
      expect((bootError as Error).message).toContain('/collide');
    });
  });
}
