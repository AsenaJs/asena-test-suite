import { expect } from 'bun:test';
import { bootApp } from '../../boot.ts';
import { getDescriptor } from '../../load.ts';
import { area, scenario } from '../../scenario.ts';
import { corsFixture, onErrorFixture, pingFixture } from './fixtures/neutral.ts';

const JSON_HEADERS = { 'content-type': 'application/json' };

export function register(): void {
  area('smoke', () => {
    scenario('P1.smoke.001', 'a neutral controller answers 200', async () => {
      await using app = await bootApp({ components: pingFixture() });
      const response = await app.get('/smoke/ping');

      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ pong: true });
    });

    scenario(
      'P1.smoke.002',
      'a route middleware runs and a zod legacy validator rejects a bad body with 400',
      async () => {
        const { zodSmokeFixture } = await import('./fixtures/zod.ts');
        await using app = await bootApp({ components: zodSmokeFixture() });

        const ok = await app.post('/smoke/echo', { headers: JSON_HEADERS, body: JSON.stringify({ name: 'asena' }) });

        expect(ok.status).toBe(200);
        expect(ok.json()).toEqual({ name: 'asena', middleware: 'ran' });

        const bad = await app.post('/smoke/echo', { headers: JSON_HEADERS, body: JSON.stringify({ name: 42 }) });

        expect(bad.status).toBe(400);
      },
      { requires: ['optional.zodValidator'] },
    );

    scenario('P1.smoke.003', 'a @Config onError receives the thrown error and answers', async () => {
      const fixture = onErrorFixture();
      await using app = await bootApp({ components: fixture.components });
      const response = await app.get('/smoke/boom');

      expect(response.status).toBe(418);
      expect(response.json()).toEqual({ handled: 'smoke-boom' });
      expect(fixture.seen).toEqual(['smoke-boom']);
    });

    scenario(
      'P1.smoke.004',
      'the built-in CORS middleware from the descriptor registers and answers',
      async () => {
        const Cors = getDescriptor().builtins!.cors!({ origin: '*' });
        await using app = await bootApp({ components: corsFixture(Cors) });
        const response = await app.get('/smoke-cors/hello', { headers: { origin: 'http://client.test' } });

        expect(response.status).toBe(200);
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(response.json()).toEqual({ hello: true });
      },
      { members: ['builtins.cors'], requires: ['optional.builtinCors'] },
    );
  });
}
