import { afterAll, expect, spyOn } from 'bun:test';
import { HttpException, isHttpException } from '@asenajs/asena/adapter';
import type { ServerLogger } from '@asenajs/asena/logger';
import { createCapturingLogger } from '@asenajs/asena/test';
import { bootApp } from '../../boot.ts';
import { getDescriptor } from '../../load.ts';
import { area, scenario } from '../../scenario.ts';
import { BASE_FORBIDDEN_BODY } from './fixtures/base.ts';
import {
  contractFixture,
  errorsFixture,
  foreignExceptionFixture,
  MW_AFTER,
  MW_BEFORE,
  NOT_FOUND_BODY,
  SECRET,
  TEAPOT_BODY,
} from './fixtures/neutral.ts';
import { loadSecondHttpException, type SecondHttpException } from './secondCore.ts';

const JSON_HEADERS = { 'content-type': 'application/json' };
const STACK_FRAME = /\n\s+at\s|\.[cm]?[jt]s:\d+/;

interface LogEntry {
  level: string;
  message: string;
  meta?: any;
}

function recordingLogger(): { logger: ServerLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const push = (level: string) => (message: string, meta?: any) => {
    entries.push({ level, message, meta });
  };

  return {
    entries,
    logger: { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug'), profile: () => {} },
  };
}

function mentions(entry: { message: string; meta?: unknown }, marker: string): boolean {
  return entry.message.includes(marker) || Bun.inspect(entry.meta).includes(marker);
}

export function register(): void {
  area('errors', () => {
    let second: SecondHttpException | undefined;

    afterAll(() => {
      second?.dispose();
      second = undefined;
    });

    scenario('P1.errors.001', 'a core HttpException reaches onError and its status and body are answered', async () => {
      const fixture = errorsFixture('answers');
      await using app = await bootApp({ components: fixture.components });
      const response = await app.get('/errors/not-found-exception');

      expect(response.status).toBe(404);
      expect(response.json()).toEqual(NOT_FOUND_BODY);
      expect(fixture.seen).toEqual([JSON.stringify(NOT_FOUND_BODY)]);
    });

    scenario('P1.errors.002', 'an HttpException thrown from a base-class module keeps its status', async () => {
      const fixture = errorsFixture('none');
      await using app = await bootApp({ components: fixture.components });
      const response = await app.get('/errors/base');

      expect(response.status).toBe(403);
      expect(response.json()).toEqual(BASE_FORBIDDEN_BODY);
    });

    scenario('P1.errors.003', 'HttpException init.headers reach the response', async () => {
      const fixture = errorsFixture('none');
      await using app = await bootApp({ components: fixture.components });
      const response = await app.get('/errors/headers');

      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('60');
      expect(response.headers.get('x-errors-marker')).toBe('set');
      expect(response.text()).toBe('slow down');
    });

    scenario(
      'P1.errors.010',
      'a plain Error without onError answers 500 without leaking message or stack',
      async () => {
        const fixture = errorsFixture('none');
        await using app = await bootApp({ components: fixture.components });
        const response = await app.get('/errors/plain');
        const text = response.text();

        expect(response.status).toBe(500);
        expect(text).not.toContain(SECRET);
        expect(response.raw.statusText).not.toContain(SECRET);
        expect(text).not.toMatch(STACK_FRAME);
      },
    );

    scenario('P1.errors.011', "a plain Error with onError returns the handler's response exactly", async () => {
      const fixture = errorsFixture('answers');
      await using app = await bootApp({ components: fixture.components });
      const response = await app.get('/errors/plain');

      expect(response.status).toBe(503);
      expect(response.json()).toEqual({ handled: SECRET });
      expect(fixture.seen).toEqual([SECRET]);
    });

    scenario('P1.errors.012', 'an async onError is awaited', async () => {
      const fixture = errorsFixture('async');
      await using app = await bootApp({ components: fixture.components });
      const response = await app.get('/errors/plain');

      expect(response.status).toBe(503);
      expect(response.json()).toEqual({ handled: SECRET });
      expect(fixture.seen).toEqual([SECRET]);
    });

    scenario('P1.errors.013', 'an error thrown in a middleware before next() reaches onError', async () => {
      const fixture = errorsFixture('answers');
      await using app = await bootApp({ components: fixture.components });
      const response = await app.get('/errors/mw-before');

      expect(response.status).toBe(503);
      expect(response.json()).toEqual({ handled: MW_BEFORE });
      expect(fixture.seen).toEqual([MW_BEFORE]);
      expect(fixture.handlerCalls).toEqual([]);
    });

    scenario(
      'P1.errors.014',
      'an error thrown in a middleware after next() reaches onError',
      async () => {
        const fixture = errorsFixture('answers');
        await using app = await bootApp({ components: fixture.components });
        const response = await app.get('/errors/mw-after');

        expect(response.status).toBe(503);
        expect(response.json()).toEqual({ handled: MW_AFTER });
        expect(fixture.seen).toEqual([MW_AFTER]);
        expect(fixture.handlerCalls).toEqual(['mw-after']);
      },
      { requires: ['middleware.codeAfterNextRuns'] },
    );

    scenario('P1.errors.015', 'an onError that throws answers 500 and the server keeps serving', async () => {
      const fixture = errorsFixture('throws');
      await using app = await bootApp({ components: fixture.components });
      const failed = await app.get('/errors/plain');

      expect(failed.status).toBe(500);
      expect(failed.text()).not.toContain(SECRET);
      expect(fixture.seen).toEqual([SECRET]);

      const next = await app.get('/errors/ok');

      expect(next.status).toBe(200);
      expect(next.json()).toEqual({ ok: true });
    });

    scenario(
      'P1.errors.020',
      'a handler error is logged once through the ServerLogger, never to console.error',
      async () => {
        const { logger, entries } = createCapturingLogger();
        const fixture = errorsFixture('none');
        await using app = await bootApp({ components: fixture.components, logger });
        const consoleError = spyOn(console, 'error');

        try {
          const response = await app.get('/errors/plain');

          expect(response.status).toBe(500);
          expect(consoleError).not.toHaveBeenCalled();
        } finally {
          consoleError.mockRestore();
        }

        expect(entries.filter((entry) => mentions(entry, SECRET)).length).toBe(1);
      },
    );

    scenario('P1.errors.021', 'an unmatched request is not passed to onError', async () => {
      const fixture = errorsFixture('answers');
      await using app = await bootApp({ components: fixture.components });
      const response = await app.get('/errors-unmatched/nowhere');

      expect(response.status).toBe(404);
      expect(fixture.seen).toEqual([]);
    });

    scenario(
      'P1.errors.022',
      'the status the adapter logs for a failing request equals the response status',
      async () => {
        const cases = [
          { path: '/errors/plain', status: 500 },
          { path: '/errors/conflict', status: 409 },
        ];

        for (const { path, status } of cases) {
          const { logger, entries } = recordingLogger();
          const fixture = errorsFixture('none');
          await using app = await bootApp({ components: fixture.components, logger });
          const response = await app.get(path);

          expect(response.status).toBe(status);
          expect({ path, logged: entries.filter((entry) => entry.meta?.status === response.status).length }).toEqual({
            path,
            logged: 1,
          });
        }
      },
    );

    scenario('P1.errors.030', 'an HttpException from a second copy of core keeps its status', async () => {
      second ??= await loadSecondHttpException();

      const Foreign = second.HttpException;

      expect(Foreign).not.toBe(HttpException);
      expect(new Foreign(451) instanceof HttpException).toBe(false);
      expect(isHttpException(new Foreign(451))).toBe(true);

      await using app = await bootApp({ components: foreignExceptionFixture(Foreign) });
      const response = await app.get('/errors-foreign/throw');

      expect(response.status).toBe(451);
      expect(response.json()).toEqual({ error: 'foreign-copy' });
    });

    scenario('P1.errors.040', 'without onError an HttpException(418) answers 418', async () => {
      const fixture = errorsFixture('none');
      await using app = await bootApp({ components: fixture.components });
      const response = await app.get('/errors/teapot');

      expect(response.status).toBe(418);
      expect(response.json()).toEqual(TEAPOT_BODY);
    });

    scenario('P1.errors.041', 'without onError a route context contract failure answers 400', async () => {
      const fixture = contractFixture((schemas) => getDescriptor().defineContext(schemas));
      await using app = await bootApp({ components: fixture.components });

      const ok = await app.post('/errors-contract/create', {
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: 'asena' }),
      });

      expect(ok.status).toBe(200);
      expect(ok.json()).toEqual({ created: true });

      const bad = await app.post('/errors-contract/create', {
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: 42 }),
      });

      expect(bad.status).toBe(400);
      expect(bad.headers.get('content-type')).toBe('application/json');
      expect(bad.json()).toEqual({
        error: 'Validation failed',
        target: 'body',
        issues: [{ message: 'name must be a non-empty string', path: ['name'] }],
      });
      expect(fixture.calls.handler).toBe(1);
      expect(fixture.calls.validate).toBe(2);
    });

    scenario(
      'P1.errors.042',
      'without onError a legacy (zod) validator failure answers 400',
      async () => {
        const { zodErrorsFixture } = await import('./fixtures/zod.ts');
        const fixture = zodErrorsFixture();
        await using app = await bootApp({ components: fixture.components });

        const ok = await app.post('/errors-zod/create', {
          headers: JSON_HEADERS,
          body: JSON.stringify({ name: 'asena' }),
        });

        expect(ok.status).toBe(200);

        const bad = await app.post('/errors-zod/create', { headers: JSON_HEADERS, body: JSON.stringify({ name: 42 }) });

        expect(bad.status).toBe(400);
        expect(bad.headers.get('content-type')).toBe('application/json');

        const body = bad.json<{
          error: unknown;
          target: unknown;
          details?: { fieldErrors?: Record<string, unknown> };
        }>();

        expect({ error: body.error, target: body.target }).toEqual({ error: 'Validation failed', target: 'json' });
        expect(Object.keys(body.details?.fieldErrors ?? {})).toEqual(['name']);
        expect(fixture.calls.handler).toBe(1);
      },
      { requires: ['optional.zodValidator'] },
    );
  });
}
