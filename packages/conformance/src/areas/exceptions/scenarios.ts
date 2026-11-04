import { expect } from 'bun:test';
import type { ServerLogger } from '@asenajs/asena/logger';
import type { TestApp } from '@asenajs/asena/test';
import { bootApp } from '../../boot.ts';
import { withTimeout } from '../../helpers/wait.ts';
import { getDescriptor } from '../../load.ts';
import { area, scenario } from '../../scenario.ts';
import {
  CONFLICT_BODY,
  catchAllHandler,
  domainHandler,
  errorHandler,
  HANDLER_EXPLODED,
  IN_VALIDATOR,
  JSON_HEADERS,
  layeredHandler,
  legacyOnErrorConfig,
  legacyOnNotFoundConfig,
  MISSING_BODY,
  MW_AFTER,
  MW_BEFORE,
  newSeen,
  notFoundHandler,
  ordersFixture,
  REJECTED,
  SECRET,
  type Seen,
} from './fixtures/neutral.ts';

type Component = new (...args: any[]) => unknown;

const STACK_FRAME = /\n\s+at\s|\.[cm]?[jt]s:\d+/;
const INVALID_BODY = JSON.stringify({ name: 42 });

interface LogEntry {
  level: string;
  message: string;
  meta?: any;
}

interface Snapshot {
  status: number;
  type: string | null;
  body: string;
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

function bootOrders(seen: Seen, extra: Component[], logger?: ServerLogger): Promise<TestApp> {
  const components = [...ordersFixture(seen, (schemas) => getDescriptor().defineContext(schemas)), ...extra];

  return bootApp({ components, logger });
}

function postInvalid(app: TestApp) {
  return app.post('/exceptions/validated', { headers: JSON_HEADERS, body: INVALID_BODY });
}

async function snapshot(
  response: PromiseLike<{ status: number; headers: Headers; text(): string }>,
): Promise<Snapshot> {
  const answered = await response;

  return { status: answered.status, type: answered.headers.get('content-type'), body: answered.text() };
}

/** What the adapter answers for each failing route when no `@ExceptionHandler` exists at all. */
async function adapterDefaults(paths: string[]): Promise<Map<string, Snapshot>> {
  const defaults = new Map<string, Snapshot>();
  await using app = await bootOrders(newSeen(), []);

  for (const path of paths) defaults.set(path, await snapshot(app.get(path)));
  defaults.set('POST /exceptions/validated', await snapshot(postInvalid(app)));

  return defaults;
}

function failureLines(entries: LogEntry[], status: number): LogEntry[] {
  return entries.filter((entry) => entry.meta?.status === status);
}

function mentions(entry: LogEntry, marker: string): boolean {
  return entry.message.includes(marker) || Bun.inspect(entry.meta).includes(marker);
}

export function register(): void {
  area('exceptions', () => {
    scenario(
      'P1.exceptions.001',
      '@Catch answers an error thrown in a controller, with scope http and the request context',
      async () => {
        const seen = newSeen();
        await using app = await bootOrders(seen, [domainHandler(seen, 'answers')]);
        const response = await app.get('/exceptions/domain');

        expect(response.status).toBe(422);
        expect(response.json()).toEqual({ rejected: REJECTED, path: '/exceptions/domain' });
        expect(seen.calls).toEqual([`domain:${REJECTED}`]);
        expect(seen.scopes).toEqual(['http']);
      },
    );

    scenario('P1.exceptions.002', 'an async @Catch is awaited', async () => {
      const seen = newSeen();
      await using app = await bootOrders(seen, [domainHandler(seen, 'async')]);
      const response = await app.get('/exceptions/domain');

      expect(response.status).toBe(422);
      expect(response.json()).toEqual({ rejected: REJECTED });
    });

    scenario('P1.exceptions.003', '@Catch answers an error thrown in a middleware before next()', async () => {
      const seen = newSeen();
      await using app = await bootOrders(seen, [domainHandler(seen, 'answers')]);
      const response = await app.get('/exceptions/mw-before');

      expect(response.status).toBe(422);
      expect(response.json()).toEqual({ rejected: MW_BEFORE, path: '/exceptions/mw-before' });
      expect(seen.handlerCalls).toEqual([]);
    });

    scenario('P1.exceptions.004', '@Catch answers an error thrown in a middleware after next()', async () => {
      const seen = newSeen();
      await using app = await bootOrders(seen, [domainHandler(seen, 'answers')]);
      const response = await app.get('/exceptions/mw-after');

      expect(response.status).toBe(422);
      expect(response.json()).toEqual({ rejected: MW_AFTER, path: '/exceptions/mw-after' });
      expect(seen.handlerCalls).toEqual(['mw-after']);
    });

    scenario(
      'P1.exceptions.005',
      '@Catch answers an error thrown inside a route context contract validator',
      async () => {
        const seen = newSeen();
        await using app = await bootOrders(seen, [domainHandler(seen, 'answers')]);
        const response = await app.post('/exceptions/validated', {
          headers: JSON_HEADERS,
          body: JSON.stringify({ name: 'reject' }),
        });

        expect(response.status).toBe(422);
        expect(response.json()).toEqual({ rejected: IN_VALIDATOR, path: '/exceptions/validated' });
        expect(seen.handlerCalls).toEqual([]);
      },
    );

    scenario(
      'P1.exceptions.010',
      'a contract validation failure reaches @Catch(ContractValidationError), not @Catch(HttpException) or @Catch(Error)',
      async () => {
        const seen = newSeen();
        await using app = await bootOrders(seen, [layeredHandler(seen)]);
        const response = await postInvalid(app);

        expect(response.status).toBe(520);
        expect(response.json()).toEqual({ by: 'validation', name: 'ContractValidationError' });
        expect(seen.calls).toEqual(['validation:ContractValidationError']);
        expect(seen.handlerCalls).toEqual([]);
      },
    );

    scenario('P1.exceptions.011', 'an HttpException reaches @Catch(HttpException), not @Catch(Error)', async () => {
      const seen = newSeen();
      await using app = await bootOrders(seen, [layeredHandler(seen)]);
      const response = await app.get('/exceptions/http');

      expect(response.status).toBe(520);
      expect(response.json()).toEqual({ by: 'http', name: 'HttpException' });
      expect(seen.calls).toEqual(['http:HttpException']);
    });

    scenario(
      'P1.exceptions.012',
      'a ready-made NotFoundException reaches @Catch(NotFoundException), not @Catch(HttpException)',
      async () => {
        const seen = newSeen();
        await using app = await bootOrders(seen, [layeredHandler(seen)]);
        const response = await app.get('/exceptions/not-found-exception');

        expect(response.status).toBe(520);
        expect(response.json()).toEqual({ by: 'not-found', name: 'NotFoundException' });
        expect(seen.calls).toEqual(['not-found:NotFoundException']);
      },
    );

    scenario('P1.exceptions.013', 'a TypeError reaches @Catch(Error) through its prototype chain', async () => {
      const seen = newSeen();
      await using app = await bootOrders(seen, [layeredHandler(seen)]);
      const response = await app.get('/exceptions/type-error');

      expect(response.status).toBe(520);
      expect(response.json()).toEqual({ by: 'error', name: 'TypeError' });
      expect(seen.calls).toEqual(['error:TypeError']);
    });

    scenario(
      'P1.exceptions.014',
      'a legacy (zod) validator failure reaches @Catch(HttpException), not @Catch(Error)',
      async () => {
        const { zodExceptionsFixture } = await import('./fixtures/zod.ts');
        const fixture = zodExceptionsFixture();
        await using app = await bootApp({ components: fixture.components });
        const response = await app.post('/exceptions-zod/create', {
          headers: JSON_HEADERS,
          body: INVALID_BODY,
        });

        expect(response.status).toBe(520);
        expect(response.json()).toEqual({ by: 'http', status: 400, validation: true, target: 'json' });
        expect(fixture.calls).toEqual(['http']);
      },
      { requires: ['optional.zodValidator'] },
    );

    scenario(
      'P1.exceptions.020',
      'a @Catch that declines a plain Error gets the adapter default 500, logged once',
      async () => {
        const defaults = await adapterDefaults(['/exceptions/plain']);
        const seen = newSeen();
        const { logger, entries } = recordingLogger();
        await using app = await bootOrders(seen, [errorHandler(seen, 'declines')], logger);
        const declined = await snapshot(app.get('/exceptions/plain'));

        expect(declined).toEqual(defaults.get('/exceptions/plain')!);
        expect(declined.status).toBe(500);
        expect(declined.body).not.toContain(SECRET);
        expect(declined.body).not.toMatch(STACK_FRAME);
        expect(seen.calls).toEqual(['error:Error']);
        expect(failureLines(entries, 500).filter((entry) => mentions(entry, SECRET)).length).toBe(1);
      },
    );

    scenario(
      'P1.exceptions.021',
      'a @Catch that declines an HttpException gets the exception’s own status and body',
      async () => {
        const defaults = await adapterDefaults(['/exceptions/http', '/exceptions/not-found-exception']);
        const seen = newSeen();
        await using app = await bootOrders(seen, [catchAllHandler(seen, 'declines')]);
        const conflict = await snapshot(app.get('/exceptions/http'));
        const missing = await snapshot(app.get('/exceptions/not-found-exception'));

        expect(conflict).toEqual(defaults.get('/exceptions/http')!);
        expect(conflict.status).toBe(409);
        expect(JSON.parse(conflict.body)).toEqual(CONFLICT_BODY);
        expect(missing).toEqual(defaults.get('/exceptions/not-found-exception')!);
        expect(missing.status).toBe(404);
        expect(JSON.parse(missing.body)).toEqual(MISSING_BODY);
        expect(seen.calls.length).toBe(2);
      },
    );

    scenario(
      'P1.exceptions.022',
      'a @Catch that declines a contract validation failure gets the adapter default 400',
      async () => {
        const defaults = await adapterDefaults([]);
        const seen = newSeen();
        await using app = await bootOrders(seen, [catchAllHandler(seen, 'declines')]);
        const declined = await snapshot(postInvalid(app));

        expect(declined).toEqual(defaults.get('POST /exceptions/validated')!);
        expect(declined.status).toBe(400);
        expect(seen.calls).toEqual([expect.stringMatching(/^all:ContractValidationError:/)]);
      },
    );

    scenario(
      'P1.exceptions.023',
      'a @Catch that throws gets the adapter default, the original error is logged and the server keeps serving',
      async () => {
        const defaults = await adapterDefaults(['/exceptions/plain']);
        const seen = newSeen();
        const { logger, entries } = recordingLogger();
        await using app = await bootOrders(seen, [errorHandler(seen, 'throws')], logger);
        const failed = await snapshot(withTimeout(app.get('/exceptions/plain'), 3000, 'request whose @Catch threw'));

        expect(failed).toEqual(defaults.get('/exceptions/plain')!);
        expect(failed.body).not.toContain(SECRET);
        expect(failed.body).not.toContain(HANDLER_EXPLODED);
        expect(failureLines(entries, 500).filter((entry) => mentions(entry, SECRET)).length).toBe(1);

        const next = await app.get('/exceptions/ok');

        expect(next.status).toBe(200);
        expect(next.json()).toEqual({ ok: true });
      },
    );

    scenario('P1.exceptions.024', 'a @Catch that returns a non-Response value is treated as a decline', async () => {
      const defaults = await adapterDefaults(['/exceptions/plain']);
      const seen = newSeen();
      await using app = await bootOrders(seen, [errorHandler(seen, 'non-response')]);
      const declined = await snapshot(app.get('/exceptions/plain'));

      expect(declined).toEqual(defaults.get('/exceptions/plain')!);
      expect(declined.body).not.toContain('handled');
      expect(seen.calls).toEqual(['error:Error']);
    });

    scenario(
      'P1.exceptions.025',
      'when a @Catch answers, the adapter writes no failure log line of its own',
      async () => {
        const seen = newSeen();
        const { logger, entries } = recordingLogger();
        await using app = await bootOrders(seen, [errorHandler(seen, 'answers')], logger);
        const response = await app.get('/exceptions/plain');

        expect(response.status).toBe(520);
        expect(failureLines(entries, 500)).toEqual([]);
        expect(failureLines(entries, 520)).toEqual([]);
      },
    );

    scenario(
      'P1.exceptions.030',
      'the catch-all @Catch() receives HttpException, contract validation failures and plain errors',
      async () => {
        const seen = newSeen();
        await using app = await bootOrders(seen, [catchAllHandler(seen, 'answers')]);
        const cases: [string, PromiseLike<{ status: number; json<T = unknown>(): T }>][] = [
          ['HttpException', app.get('/exceptions/http')],
          ['NotFoundException', app.get('/exceptions/not-found-exception')],
          ['ContractValidationError', postInvalid(app)],
          ['Error', app.get('/exceptions/plain')],
        ];

        for (const [name, pending] of cases) {
          const response = await pending;

          expect({ name, status: response.status, body: response.json() }).toEqual({
            name,
            status: 520,
            body: { by: 'all', name },
          });
        }
      },
    );

    scenario(
      'P1.exceptions.032',
      'an unmatched route never reaches the catch-all @Catch() and answers the adapter default 404',
      async () => {
        await using plain = await bootOrders(newSeen(), []);
        const expected = await snapshot(plain.get('/exceptions-unmatched/nowhere'));
        const seen = newSeen();
        await using app = await bootOrders(seen, [catchAllHandler(seen, 'answers')]);
        const response = await snapshot(app.get('/exceptions-unmatched/nowhere'));

        expect(response).toEqual(expected);
        expect(response.status).toBe(404);
        expect(seen.calls).toEqual([]);
      },
    );

    scenario(
      'P1.exceptions.040',
      '@NotFound() answers an unmatched route with the path without query and the upper-case method',
      async () => {
        const seen = newSeen();
        await using app = await bootOrders(seen, [notFoundHandler(seen, 'answers')]);
        const response = await app.post('/exceptions-unmatched/x?y=1');

        expect(response.status).toBe(404);
        expect(response.json()).toEqual({ by: 'not-found', path: '/exceptions-unmatched/x', method: 'POST' });
        expect(seen.calls).toEqual(['not-found:POST /exceptions-unmatched/x']);
      },
      { requires: ['optional.notFoundHook'] },
    );

    scenario(
      'P1.exceptions.041',
      'a @NotFound() that declines gets the adapter default 404',
      async () => {
        await using plain = await bootOrders(newSeen(), []);
        const expected = await snapshot(plain.get('/exceptions-unmatched/nowhere'));
        const seen = newSeen();
        await using app = await bootOrders(seen, [notFoundHandler(seen, 'declines')]);
        const response = await snapshot(app.get('/exceptions-unmatched/nowhere'));

        expect(response).toEqual(expected);
        expect(seen.calls).toEqual(['not-found:GET /exceptions-unmatched/nowhere']);
      },
      { requires: ['optional.notFoundHook'] },
    );

    scenario(
      'P1.exceptions.042',
      'a @NotFound() that throws gets the adapter default 404 and the server keeps serving',
      async () => {
        await using plain = await bootOrders(newSeen(), []);
        const expected = await snapshot(plain.get('/exceptions-unmatched/nowhere'));
        const seen = newSeen();
        await using app = await bootOrders(seen, [notFoundHandler(seen, 'throws')]);
        const response = await snapshot(
          withTimeout(app.get('/exceptions-unmatched/nowhere'), 3000, 'unmatched request whose @NotFound threw'),
        );

        expect(response).toEqual(expected);
        expect(response.body).not.toContain(HANDLER_EXPLODED);
        expect((await app.get('/exceptions/ok')).status).toBe(200);
      },
      { requires: ['optional.notFoundHook'] },
    );

    scenario(
      'P1.exceptions.050',
      'a deprecated @Config.onError answers after the @Catch declined, and is skipped when it answers',
      async () => {
        const seen = newSeen();
        await using app = await bootOrders(seen, [errorHandler(seen, 'declines'), legacyOnErrorConfig(seen)]);
        const declined = await app.get('/exceptions/plain');

        expect(declined.status).toBe(503);
        expect(declined.json()).toEqual({ by: 'config.onError', message: SECRET });
        expect(seen.calls).toEqual(['error:Error', `config.onError:${SECRET}`]);

        const answering = newSeen();
        await using answered = await bootOrders(answering, [
          domainHandler(answering, 'answers'),
          legacyOnErrorConfig(answering),
        ]);
        const response = await answered.get('/exceptions/domain');

        expect(response.status).toBe(422);
        expect(answering.calls).toEqual([`domain:${REJECTED}`]);
      },
    );

    scenario('P1.exceptions.051', 'a deprecated @Config.onError answers an error no @Catch matches', async () => {
      const seen = newSeen();
      await using app = await bootOrders(seen, [domainHandler(seen, 'answers'), legacyOnErrorConfig(seen)]);
      const response = await app.get('/exceptions/plain');

      expect(response.status).toBe(503);
      expect(response.json()).toEqual({ by: 'config.onError', message: SECRET });
      expect(seen.calls).toEqual([`config.onError:${SECRET}`]);
    });

    scenario(
      'P1.exceptions.052',
      'a deprecated @Config.onNotFound answers after @NotFound() declined, and is skipped when it answers',
      async () => {
        const seen = newSeen();
        await using app = await bootOrders(seen, [notFoundHandler(seen, 'declines'), legacyOnNotFoundConfig(seen)]);
        const declined = await app.get('/exceptions-unmatched/nowhere');

        expect(declined.status).toBe(404);
        expect(declined.json()).toEqual({ by: 'config.onNotFound', path: '/exceptions-unmatched/nowhere' });
        expect(seen.calls).toEqual([
          'not-found:GET /exceptions-unmatched/nowhere',
          'config.onNotFound:/exceptions-unmatched/nowhere',
        ]);

        const answering = newSeen();
        await using answered = await bootOrders(answering, [
          notFoundHandler(answering, 'answers'),
          legacyOnNotFoundConfig(answering),
        ]);
        const response = await answered.get('/exceptions-unmatched/nowhere');

        expect(response.json()).toEqual({ by: 'not-found', path: '/exceptions-unmatched/nowhere', method: 'GET' });
        expect(answering.calls).toEqual(['not-found:GET /exceptions-unmatched/nowhere']);
      },
      { requires: ['optional.notFoundHook'] },
    );

    scenario(
      'P1.exceptions.060',
      'an @ExceptionHandler whose @Catch matches nothing answers exactly like an app without one',
      async () => {
        const paths = ['/exceptions/plain', '/exceptions/http', '/exceptions/not-found-exception'];
        const defaults = await adapterDefaults(paths);
        const seen = newSeen();
        const { logger, entries } = recordingLogger();
        await using app = await bootOrders(seen, [domainHandler(seen, 'answers')], logger);

        for (const path of paths) {
          expect({ path, ...(await snapshot(app.get(path))) }).toEqual({ path, ...defaults.get(path)! });
        }

        expect(await snapshot(postInvalid(app))).toEqual(defaults.get('POST /exceptions/validated')!);
        expect(failureLines(entries, 500).filter((entry) => mentions(entry, SECRET)).length).toBe(1);
        expect(seen.calls).toEqual([]);
      },
    );
  });
}
