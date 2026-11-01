import { expect } from 'bun:test';
import { ASENA_CONTEXT_CONTRACT, isHttpException, isValidationError } from '@asenajs/asena/adapter';
import type { TestApp } from '@asenajs/asena/test';
import { bootApp } from '../../boot.ts';
import { getDescriptor } from '../../load.ts';
import { area, scenario } from '../../scenario.ts';
import {
  bodyFixture,
  type ContractContextClass,
  conflictFixture,
  type DefineContext,
  foreignFixture,
  inputFixture,
  orderFixture,
  transformFixture,
} from './fixtures/contract.ts';
import { registrarFixture } from './fixtures/neutral.ts';
import { object, string } from './fixtures/standardSchema.ts';

type Components = Parameters<typeof bootApp>[0]['components'];

const JSON_HEADERS = { 'content-type': 'application/json' };
const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' };
const VALID_UUID = '3f2b8c4e-6a1d-4f7e-9b2a-5c8d1e0f4a6b';

const define: DefineContext = (schemas) => getDescriptor().defineContext(schemas) as ContractContextClass;

async function expectBootRejects(components: Components): Promise<void> {
  let app: TestApp | undefined;
  let failure: unknown;

  try {
    app = await bootApp({ components });
  } catch (error) {
    failure = error;
  }

  await app?.stop();

  expect(app).toBeUndefined();
  expect(failure).toBeInstanceOf(Error);
}

const json = (body: unknown): RequestInit => ({ headers: JSON_HEADERS, body: JSON.stringify(body) });

export function register(): void {
  area('validation', () => {
    scenario(
      'P1.validation.001',
      'legacy json validator: invalid bodies answer 400, a valid body reaches the handler',
      async () => {
        const { legacyTargetsFixture } = await import('./fixtures/zod.ts');
        const fixture = legacyTargetsFixture();
        await using app = await bootApp({ components: fixture.components });

        expect((await app.post('/legacy/users', json({ name: '', email: 'a@b.test' }))).status).toBe(400);
        expect((await app.post('/legacy/users', json({ email: 'a@b.test' }))).status).toBe(400);
        expect((await app.post('/legacy/users', json({ name: 'ada', email: 'not-an-email' }))).status).toBe(400);
        expect(fixture.calls.handler).toBe(0);

        const withAge = await app.post('/legacy/users', json({ name: 'ada', email: 'ada@b.test', age: 36 }));

        expect(withAge.status).toBe(201);
        expect(withAge.json()).toEqual({ name: 'ada', email: 'ada@b.test', age: 36 });

        const withoutAge = await app.post('/legacy/users', json({ name: 'ada', email: 'ada@b.test' }));

        expect(withoutAge.status).toBe(201);
        expect(withoutAge.json()).toEqual({ name: 'ada', email: 'ada@b.test' });
      },
      { requires: ['optional.zodValidator'] },
    );

    scenario(
      'P1.validation.002',
      'legacy param validator: a non-UUID id answers 400',
      async () => {
        const { legacyTargetsFixture } = await import('./fixtures/zod.ts');
        const fixture = legacyTargetsFixture();
        await using app = await bootApp({ components: fixture.components });

        expect((await app.get('/legacy/users/not-a-uuid')).status).toBe(400);
        expect(fixture.calls.handler).toBe(0);

        const ok = await app.get(`/legacy/users/${VALID_UUID}`);

        expect(ok.status).toBe(200);
        expect(ok.json()).toEqual({ id: VALID_UUID });
      },
      { requires: ['optional.zodValidator'] },
    );

    scenario(
      'P1.validation.003',
      'legacy query validator with a coercing schema: 400 on garbage, 200 on a number',
      async () => {
        const { legacyTargetsFixture } = await import('./fixtures/zod.ts');
        const fixture = legacyTargetsFixture();
        await using app = await bootApp({ components: fixture.components });

        expect((await app.get('/legacy/users?page=abc')).status).toBe(400);
        expect(fixture.calls.handler).toBe(0);

        const ok = await app.get('/legacy/users?page=2');

        expect(ok.status).toBe(200);
        expect(ok.json()).toEqual({ page: '2' });
      },
      { requires: ['optional.zodValidator'] },
    );

    scenario(
      'P1.validation.004',
      'legacy form validator: a missing field answers 400',
      async () => {
        const { legacyTargetsFixture } = await import('./fixtures/zod.ts');
        const fixture = legacyTargetsFixture();
        await using app = await bootApp({ components: fixture.components });

        expect((await app.post('/legacy/form', { headers: FORM_HEADERS, body: 'other=1' })).status).toBe(400);
        expect(fixture.calls.handler).toBe(0);

        const ok = await app.post('/legacy/form', { headers: FORM_HEADERS, body: 'title=hello' });

        expect(ok.status).toBe(200);
        expect(ok.json()).toEqual({ ok: true });
      },
      { requires: ['optional.zodValidator'] },
    );

    scenario(
      'P1.validation.005',
      'legacy header validator: a missing or short header answers 400',
      async () => {
        const { legacyTargetsFixture } = await import('./fixtures/zod.ts');
        const fixture = legacyTargetsFixture();
        await using app = await bootApp({ components: fixture.components });

        expect((await app.get('/legacy/header')).status).toBe(400);
        expect((await app.get('/legacy/header', { headers: { 'x-api-key': 'ab' } })).status).toBe(400);
        expect(fixture.calls.handler).toBe(0);

        const ok = await app.get('/legacy/header', { headers: { 'x-api-key': 'abc' } });

        expect(ok.status).toBe(200);
        expect(ok.json()).toEqual({ ok: true });
      },
      { requires: ['optional.zodValidator'] },
    );

    scenario(
      'P1.validation.006',
      'onError receives a validation error that is an HttpException with status 400, target, issues and cause',
      async () => {
        const { isZodError, legacyOnErrorFixture } = await import('./fixtures/zod.ts');
        const fixture = legacyOnErrorFixture();
        await using app = await bootApp({ components: fixture.components });

        const failing: [string, () => PromiseLike<{ status: number }>][] = [
          ['json', () => app.post('/legacy/users', json({ name: '', email: 'x' }))],
          ['query', () => app.get('/legacy/users?page=abc')],
          ['param', () => app.get('/legacy/users/not-a-uuid')],
          ['form', () => app.post('/legacy/form', { headers: FORM_HEADERS, body: 'other=1' })],
          ['header', () => app.get('/legacy/header')],
        ];

        for (const [target, send] of failing) {
          const before = fixture.errors.length;
          const response = await send();

          expect({ target, status: response.status }).toEqual({ target, status: 499 });
          expect(fixture.errors.length).toBe(before + 1);

          const error = fixture.errors[before] as Error & {
            status?: unknown;
            target?: unknown;
            issues?: unknown;
            cause?: unknown;
          };

          expect({ target, validation: isValidationError(error) }).toEqual({ target, validation: true });
          expect({ target, http: isHttpException(error) }).toEqual({ target, http: true });
          expect({ target, status: error.status }).toEqual({ target, status: 400 });
          expect(error.target).toBe(target);
          expect(Array.isArray(error.issues)).toBe(true);
          expect((error.issues as unknown[]).length).toBeGreaterThan(0);
          expect({ target, zodCause: isZodError(error.cause) }).toEqual({ target, zodCause: true });
        }

        expect(fixture.calls.handler).toBe(0);
      },
      { requires: ['optional.zodValidator'] },
    );

    scenario(
      'P1.validation.007',
      'a route inherited from an undecorated base class keeps its legacy validator',
      async () => {
        const { legacyInheritedFixture } = await import('./fixtures/zod.ts');
        const fixture = legacyInheritedFixture();
        await using app = await bootApp({ components: fixture.components });

        expect((await app.post('/legacy-child/inherited', json({ name: '' }))).status).toBe(400);
        expect(fixture.calls.handler).toBe(0);

        const ok = await app.post('/legacy-child/inherited', json({ name: 'ada' }));

        expect(ok.status).toBe(200);
        expect(ok.json()).toEqual({ name: 'ada' });
        expect(fixture.calls.factory).toBeGreaterThanOrEqual(1);
      },
      { requires: ['optional.zodValidator'] },
    );

    scenario(
      'P1.validation.008',
      'a schema-with-hook whose hook returns a Response sends that Response',
      async () => {
        const { legacyHookFixture } = await import('./fixtures/zod.ts');
        const fixture = legacyHookFixture();
        await using app = await bootApp({ components: fixture.components });

        const hooked = await app.post('/legacy/hook', json({ name: '' }));

        expect(hooked.status).toBe(422);
        expect(hooked.json()).toEqual({ hooked: true });
        expect(fixture.calls.handler).toBe(0);
        expect(fixture.hookResults).toContain(false);

        const ok = await app.post('/legacy/hook', json({ name: 'ada' }));

        expect(ok.status).toBe(200);
        expect(ok.json()).toEqual({ name: 'ada' });
      },
      { requires: ['optional.zodValidator'] },
    );

    scenario(
      'P1.validation.009',
      'validatorCache: true answers repeated requests the same way and builds the schema once',
      async () => {
        const { legacyCacheFixture } = await import('./fixtures/zod.ts');
        const fixture = legacyCacheFixture();
        await using app = await bootApp({ components: fixture.components });

        for (let i = 0; i < 3; i++) {
          const ok = await app.post('/legacy/cached', json({ count: '7' }));

          expect(ok.status).toBe(200);
          expect(ok.json()).toEqual({ count: 7 });
          expect((await app.post('/legacy/cached', json({ count: 'x' }))).status).toBe(400);
        }

        expect(fixture.calls.handler).toBe(3);
        expect(fixture.calls.factory).toBe(1);
      },
      { requires: ['optional.zodValidator'] },
    );

    scenario(
      'P1.validation.010',
      'the parsed body reaches the handler through getBody (transforms and defaults applied)',
      async () => {
        const { legacyParsedFixture } = await import('./fixtures/zod.ts');
        const fixture = legacyParsedFixture();
        await using app = await bootApp({ components: fixture.components });

        const response = await app.post('/legacy/parsed', json({ name: '  ada  ', extra: 'dropped' }));

        expect(response.status).toBe(200);
        expect(response.json()).toEqual({ body: { name: 'ada', role: 'member' } });
      },
      { requires: ['optional.zodValidator'] },
    );

    scenario(
      'P1.validation.030',
      'a directly registered route with a non-boolean validatorCache fails the boot',
      async () => {
        const control = registrarFixture({});

        {
          await using app = await bootApp({ components: control.components });

          expect((await app.get('/direct/route')).status).toBe(200);
        }

        await expectBootRejects(registrarFixture({ validatorCache: 'yes' }).components);
      },
    );

    scenario(
      'P1.validation.020',
      'route context contract: ctx.input carries body, query, params and headers',
      async () => {
        const fixture = inputFixture(define);
        await using app = await bootApp({ components: fixture.components });

        const response = await app.post('/contract/input/42?tag=blue', {
          headers: { ...JSON_HEADERS, 'x-suite': 'yes' },
          body: JSON.stringify({ name: 'ada', ignored: true }),
        });

        expect(response.status).toBe(200);
        expect(response.json()).toEqual({
          subclass: true,
          body: { name: 'ada' },
          query: { tag: 'blue' },
          params: { id: '42' },
          headers: { 'x-suite': 'yes' },
        });
        expect(fixture.calls.handler).toBe(1);
      },
    );

    scenario(
      'P1.validation.021',
      'route context contract: an invalid body answers the exact 400 envelope',
      async () => {
        const fixture = bodyFixture(define);
        await using app = await bootApp({ components: fixture.components });

        const response = await app.post('/contract/body', json({ name: 42 }));

        expect(response.status).toBe(400);
        expect(response.json()).toEqual({
          error: 'Validation failed',
          target: 'body',
          issues: [{ message: 'Expected a string', path: ['name'] }],
        });
        expect(fixture.calls.handler).toBe(0);
      },
    );

    scenario(
      'P1.validation.022',
      'route context contract: a non-JSON content type for a body schema answers 415',
      async () => {
        const fixture = bodyFixture(define);
        await using app = await bootApp({ components: fixture.components });

        const response = await app.post('/contract/body', {
          headers: { 'content-type': 'text/plain' },
          body: 'name=ada',
        });

        expect(response.status).toBe(415);
        expect(fixture.calls.handler).toBe(0);
      },
    );

    scenario('P1.validation.023', 'route context contract: invalid JSON answers 400', async () => {
      const fixture = bodyFixture(define);
      await using app = await bootApp({ components: fixture.components });

      const response = await app.post('/contract/body', { headers: JSON_HEADERS, body: '{"name":' });

      expect(response.status).toBe(400);
      expect(fixture.calls.handler).toBe(0);
    });

    scenario(
      'P1.validation.024',
      'route context contract: an empty body is undefined input and the schema decides',
      async () => {
        const fixture = bodyFixture(define);
        await using app = await bootApp({ components: fixture.components });

        const accepted = await app.post('/contract/optional-body', { headers: JSON_HEADERS });

        expect(accepted.status).toBe(200);
        expect(accepted.json()).toEqual({ hasBody: true, bodyIsUndefined: true });

        const rejected = await app.post('/contract/body', { headers: JSON_HEADERS });

        expect(rejected.status).toBe(400);
        expect(rejected.json()).toEqual({
          error: 'Validation failed',
          target: 'body',
          issues: [{ message: 'Expected an object', path: [] }],
        });
        expect(fixture.calls.handler).toBe(1);
      },
    );

    scenario(
      'P1.validation.025',
      'route context contract: body/form, query, params, headers validate in that order',
      async () => {
        const fixture = orderFixture(define);
        await using app = await bootApp({ components: fixture.components });

        const cases: { path: string; init: RequestInit; target: string | null; order: string[] }[] = [
          { path: '/contract/order/x', init: json({}), target: 'body', order: ['body'] },
          { path: '/contract/order/x', init: json({ b: 'ok' }), target: 'query', order: ['body', 'query'] },
          {
            path: '/contract/order/x?q=ok',
            init: json({ b: 'ok' }),
            target: 'params',
            order: ['body', 'query', 'params'],
          },
          {
            path: '/contract/order/7?q=ok',
            init: json({ b: 'ok' }),
            target: 'headers',
            order: ['body', 'query', 'params', 'headers'],
          },
          {
            path: '/contract/order/7?q=ok',
            init: { headers: { ...JSON_HEADERS, 'x-suite': 'ok' }, body: JSON.stringify({ b: 'ok' }) },
            target: null,
            order: ['body', 'query', 'params', 'headers'],
          },
          {
            path: '/contract/form-order/x',
            init: { headers: FORM_HEADERS, body: 'g=1' },
            target: 'form',
            order: ['form'],
          },
          {
            path: '/contract/form-order/x',
            init: { headers: FORM_HEADERS, body: 'f=ok' },
            target: 'query',
            order: ['form', 'query'],
          },
        ];

        for (const { path, init, target, order } of cases) {
          fixture.order.length = 0;

          const response = await app.post(path, init);

          if (target === null) {
            expect({ path, status: response.status }).toEqual({ path, status: 200 });
          } else {
            expect({ path, status: response.status }).toEqual({ path, status: 400 });
            expect({ path, target: response.json<{ target?: unknown }>().target }).toEqual({ path, target });
          }

          expect({ path, order: [...fixture.order] }).toEqual({ path, order });
        }

        expect(fixture.calls.handler).toBe(1);
      },
    );

    scenario('P1.validation.026', 'a context class branded for another adapter fails the boot', async () => {
      const fixture = foreignFixture(define);

      await expectBootRejects(fixture.components);
      expect(fixture.calls.handler).toBe(0);
    });

    scenario(
      'P1.validation.027',
      'a route declaring both a context contract and a legacy validator fails the boot',
      async () => {
        const fixture = conflictFixture(define);

        await expectBootRejects(fixture.components);
        expect(fixture.calls.handler).toBe(0);
      },
    );

    scenario(
      'P1.validation.028',
      'a directly registered route with contextContract but no contextClass fails the boot',
      async () => {
        const Orphan = define({ query: object({ q: string() }) });
        const fixture = registrarFixture({ contextContract: Orphan[ASENA_CONTEXT_CONTRACT] });

        await expectBootRejects(fixture.components);
      },
    );

    scenario(
      'P1.validation.029',
      'a directly registered route whose contextContract does not match its contextClass fails the boot',
      async () => {
        const First = define({ query: object({ q: string() }) });
        const Second = define({ query: object({ q: string() }) });
        const matching = registrarFixture({ contextClass: First, contextContract: First[ASENA_CONTEXT_CONTRACT] });

        {
          await using app = await bootApp({ components: matching.components });

          expect((await app.get('/direct/route?q=x')).status).toBe(200);
        }

        const fixture = registrarFixture({ contextClass: First, contextContract: Second[ASENA_CONTEXT_CONTRACT] });

        await expectBootRejects(fixture.components);
      },
    );

    scenario(
      'P1.validation.031',
      'route context contract: transformed input reaches the handler; a global middleware runs before validation',
      async () => {
        const fixture = transformFixture(define);
        await using app = await bootApp({ components: fixture.components });

        const response = await app.post('/contract/transform?count=5', json({ name: '  ada  ' }));

        expect(response.status).toBe(200);
        expect(response.json()).toEqual({ body: { name: 'ada' }, query: { count: 5 }, countType: 'number' });
        expect(fixture.order).toEqual(['middleware', 'body', 'query', 'handler']);
        expect(fixture.middlewareSaw).toEqual(['throws']);
      },
    );
  });
}
