import { expect } from 'bun:test';
import { bootApp } from '../../boot.ts';
import { collectSse } from '../../helpers/sse.ts';
import { waitFor } from '../../helpers/wait.ts';
import { getDescriptor } from '../../load.ts';
import { area, scenario } from '../../scenario.ts';
import {
  corsGlobalFixture,
  corsRouteFixture,
  EXCLUDED_PREFIX,
  rateLimitedExcludeFixture,
  rateLimitedRouteFixture,
} from './fixtures/neutral.ts';

const CLIENT = 'http://client.test';
const OTHER = 'http://other.test';

function preflight(method: string, extra: Record<string, string> = {}): RequestInit {
  return { headers: { origin: CLIENT, 'access-control-request-method': method, ...extra } };
}

export function register(): void {
  area('builtins', () => {
    scenario(
      'P1.builtins.001',
      'a CORS preflight answers 204 with the allowed origin and methods',
      async () => {
        await using app = await bootApp({
          components: corsRouteFixture(getDescriptor().builtins!.cors!({ origin: '*' })),
        });
        const response = await app.options('/builtins-cors/hello', preflight('PUT'));

        expect(response.status).toBe(204);
        expect(response.headers.get('access-control-allow-origin')).toBe('*');

        const methods = response.headers.get('access-control-allow-methods');

        expect(methods).not.toBeNull();
        expect(methods!.split(',').map((method) => method.trim())).toContain('PUT');
      },
      { requires: ['optional.builtinCors'], members: ['builtins.cors'] },
    );

    scenario(
      'P1.builtins.002',
      'a simple CORS GET carries access-control-allow-origin',
      async () => {
        await using app = await bootApp({
          components: corsRouteFixture(getDescriptor().builtins!.cors!({ origin: '*' })),
        });
        const response = await app.get('/builtins-cors/hello', { headers: { origin: CLIENT } });

        expect(response.status).toBe(200);
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(response.json()).toEqual({ hello: true });
      },
      { requires: ['optional.builtinCors'], members: ['builtins.cors'] },
    );

    scenario(
      'P1.builtins.003',
      'an SSE response behind CORS carries access-control-allow-origin',
      async () => {
        await using app = await bootApp({
          components: corsRouteFixture(getDescriptor().builtins!.cors!({ origin: '*' })),
        });
        const response = await fetch(`${app.baseUrl}/builtins-cors/events`, { headers: { origin: CLIENT } });

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).not.toBeNull();
        expect(response.headers.get('content-type')!).toContain('text/event-stream');
        expect(response.headers.get('access-control-allow-origin')).toBe('*');

        const events = await collectSse(response, { max: 1, timeout: 2000 });

        expect(events).toEqual([{ event: 'tick', data: 'one' }]);
      },
      { requires: ['optional.builtinCors'], members: ['builtins.cors'] },
    );

    scenario(
      'P1.builtins.004',
      'a global CORS middleware answers a preflight for a path with no OPTIONS route',
      async () => {
        await using app = await bootApp({
          components: corsGlobalFixture(getDescriptor().builtins!.cors!({ origin: '*' })),
        });
        const response = await app.options('/builtins-global-cors/items', preflight('GET'));

        expect(response.status).toBe(204);
        expect(response.headers.get('access-control-allow-origin')).toBe('*');

        const methods = response.headers.get('access-control-allow-methods');

        expect(methods).not.toBeNull();
        expect(methods!.split(',').map((method) => method.trim())).toContain('GET');
      },
      { requires: ['optional.builtinCors'], members: ['builtins.cors'] },
    );

    scenario(
      'P1.builtins.005',
      'an origin outside the allow-list gets no access-control-allow-origin',
      async () => {
        await using app = await bootApp({
          components: corsRouteFixture(getDescriptor().builtins!.cors!({ origin: [CLIENT] })),
        });
        const response = await app.get('/builtins-cors/hello', { headers: { origin: OTHER } });

        expect(response.status).toBe(200);
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
        expect(response.json()).toEqual({ hello: true });

        const allowed = await app.get('/builtins-cors/hello', { headers: { origin: CLIENT } });

        expect(allowed.headers.get('access-control-allow-origin')).toBe(CLIENT);
      },
      { requires: ['optional.builtinCors'], members: ['builtins.cors'] },
    );

    scenario(
      'P1.builtins.006',
      'credentials with an allow-list echo the origin and allow credentials',
      async () => {
        await using app = await bootApp({
          components: corsRouteFixture(getDescriptor().builtins!.cors!({ origin: [CLIENT], credentials: true })),
        });
        const response = await app.get('/builtins-cors/hello', { headers: { origin: CLIENT } });

        expect(response.status).toBe(200);
        expect(response.headers.get('access-control-allow-credentials')).toBe('true');
        expect(response.headers.get('access-control-allow-origin')).toBe(CLIENT);
      },
      { requires: ['optional.builtinCors'], members: ['builtins.cors'] },
    );

    scenario(
      'P1.builtins.007',
      'configured allowedHeaders are returned on the preflight',
      async () => {
        await using app = await bootApp({
          components: corsRouteFixture(getDescriptor().builtins!.cors!({ origin: '*', allowedHeaders: ['x-custom'] })),
        });
        const response = await app.options(
          '/builtins-cors/hello',
          preflight('GET', { 'access-control-request-headers': 'x-custom' }),
        );

        expect(response.status).toBe(204);
        expect(response.headers.get('access-control-allow-headers')).toBe('x-custom');
      },
      { requires: ['optional.builtinCors'], members: ['builtins.cors'] },
    );

    scenario(
      'P1.builtins.010',
      'capacity 3 without refill admits three requests and rejects the fourth with 429',
      async () => {
        const prefix = '/builtins-rl-010';
        await using app = await bootApp({
          components: rateLimitedRouteFixture(
            getDescriptor().builtins!.rateLimiter!({
              capacity: 3,
              refillRate: 0,
              keyGenerator: () => 'P1.builtins.010',
            }),
            prefix,
          ),
        });
        const statuses: number[] = [];

        for (let i = 0; i < 4; i++) statuses.push((await app.get(`${prefix}/hit`)).status);

        expect(statuses).toEqual([200, 200, 200, 429]);
      },
      { requires: ['optional.builtinRateLimiter'], members: ['builtins.rateLimiter'] },
    );

    scenario(
      'P1.builtins.011',
      'x-ratelimit-limit and a decreasing x-ratelimit-remaining are exact',
      async () => {
        const prefix = '/builtins-rl-011';
        await using app = await bootApp({
          components: rateLimitedRouteFixture(
            getDescriptor().builtins!.rateLimiter!({
              capacity: 3,
              refillRate: 3 / 60,
              keyGenerator: () => 'P1.builtins.011',
            }),
            prefix,
          ),
        });
        const limits: string[] = [];
        const remaining: string[] = [];

        for (let i = 0; i < 3; i++) {
          const response = await app.get(`${prefix}/hit`);

          expect(response.status).toBe(200);
          expect(response.headers.get('x-ratelimit-limit')).not.toBeNull();
          expect(response.headers.get('x-ratelimit-remaining')).not.toBeNull();
          limits.push(response.headers.get('x-ratelimit-limit')!);
          remaining.push(response.headers.get('x-ratelimit-remaining')!);
        }

        expect(limits).toEqual(['3', '3', '3']);
        expect(remaining).toEqual(['2', '1', '0']);
      },
      { requires: ['optional.builtinRateLimiter'], members: ['builtins.rateLimiter'] },
    );

    scenario(
      'P1.builtins.012',
      'a route excluded from a global rate limiter carries no x-ratelimit headers',
      async () => {
        await using app = await bootApp({
          components: rateLimitedExcludeFixture(
            getDescriptor().builtins!.rateLimiter!({
              capacity: 5,
              refillRate: 5 / 60,
              keyGenerator: () => 'P1.builtins.012',
            }),
          ),
        });
        const limited = await app.get(`${EXCLUDED_PREFIX}/limited`);

        expect(limited.status).toBe(200);
        expect(limited.headers.get('x-ratelimit-limit')).toBe('5');

        const excluded = await app.get(`${EXCLUDED_PREFIX}/health`);

        expect(excluded.status).toBe(200);
        expect(excluded.json()).toEqual({ healthy: true });
        expect(excluded.headers.get('x-ratelimit-limit')).toBeNull();
        expect(excluded.headers.get('x-ratelimit-remaining')).toBeNull();
      },
      { requires: ['optional.builtinRateLimiter'], members: ['builtins.rateLimiter'] },
    );

    scenario(
      'P1.builtins.013',
      'a drained bucket admits a request again once a token refills',
      async () => {
        const prefix = '/builtins-rl-013';
        const refillRate = 2;
        const refillIntervalMs = 1000 / refillRate;
        await using app = await bootApp({
          components: rateLimitedRouteFixture(
            getDescriptor().builtins!.rateLimiter!({ capacity: 1, refillRate, keyGenerator: () => 'P1.builtins.013' }),
            prefix,
          ),
        });

        expect((await app.get(`${prefix}/hit`)).status).toBe(200);
        expect((await app.get(`${prefix}/hit`)).status).toBe(429);

        const refilled = await waitFor(async () => (await app.get(`${prefix}/hit`)).status === 200, {
          timeout: 3 * refillIntervalMs,
          interval: 25,
          label: 'a 200 after the refill interval',
        });

        expect(refilled).toBe(true);
      },
      { requires: ['optional.builtinRateLimiter'], members: ['builtins.rateLimiter'] },
    );
  });
}
