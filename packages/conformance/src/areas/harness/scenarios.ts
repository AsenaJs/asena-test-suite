import { expect, mock } from 'bun:test';
import { createWebTest, silentLogger, type WebTestResult } from '@asenajs/asena/test';
import { bootApp } from '../../boot.ts';
import { isPortFree, openWs, randomPort } from '../../helpers/index.ts';
import { getDescriptor } from '../../load.ts';
import { area, scenario } from '../../scenario.ts';
import {
  contractFixture,
  echoSocketFixture,
  HARNESS_SERVICE,
  HARNESS_USER_ID,
  type HarnessUser,
  userFixture,
} from './fixtures/neutral.ts';

type Component = new (...args: any[]) => unknown;

interface WebTestBoot {
  controllers: Component[];
  components?: Component[];
}

function addressInUse(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return (error as { code?: unknown })?.code === 'EADDRINUSE' || /EADDRINUSE|address already in use/i.test(message);
}

async function freePort(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const port = randomPort();

    if (await isPortFree(port)) return port;
  }

  return randomPort();
}

async function bootWebTest(options: WebTestBoot): Promise<WebTestResult> {
  const boot = async (port: number) =>
    createWebTest({
      adapter: getDescriptor().createAdapter({ logger: silentLogger }),
      controllers: options.controllers,
      components: options.components,
      logger: silentLogger,
      port,
    });

  let lastError: unknown;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await boot(await freePort());
    } catch (error) {
      if (!addressInUse(error)) throw error;
      lastError = error;
    }
  }

  throw lastError;
}

export function register(): void {
  area('harness', () => {
    scenario('P1.harness.001', 'createTestApp serves real routes through the fluent client', async () => {
      const { Controller, Service } = userFixture();
      await using app = await bootApp({ components: [Controller, Service] });

      const response = await app
        .get('/harness/users')
        .expectStatus(200)
        .expectJson([{ id: HARNESS_USER_ID, name: 'Real' }]);

      expect(response.status).toBe(200);
    });

    scenario('P1.harness.002', 'createTestApp reports a consistent port and baseUrl', async () => {
      const { Controller, Service } = userFixture();
      await using app = await bootApp({ components: [Controller, Service] });

      expect(app.port).toBeGreaterThanOrEqual(10000);
      expect(app.port).toBeLessThan(32000);
      expect(app.baseUrl).toBe(`http://localhost:${app.port}`);
      expect(app.socketPath).toBeUndefined();

      const raw = await fetch(`${app.baseUrl}/harness/users`);

      expect(raw.status).toBe(200);
      expect(await raw.json()).toEqual([{ id: HARNESS_USER_ID, name: 'Real' }]);
    });

    scenario('P1.harness.003', 'createTestApp overrides replace a service', async () => {
      const { Controller, Service } = userFixture();
      const double = {
        marker: 'double',
        getAll: mock(async (): Promise<HarnessUser[]> => [{ id: 'mock-1', name: 'Overridden' }]),
        getById: mock(async (): Promise<HarnessUser | null> => null),
      };
      await using app = await bootApp({ components: [Controller, Service], overrides: { [HARNESS_SERVICE]: double } });

      await app
        .get('/harness/users')
        .expectStatus(200)
        .expectJson([{ id: 'mock-1', name: 'Overridden' }]);

      expect(double.getAll).toHaveBeenCalledTimes(1);
      expect(double.getById).toHaveBeenCalledTimes(0);
    });

    scenario('P1.harness.004', 'resolve(name) returns the instance the container wired', async () => {
      const { Controller, Service } = userFixture();
      await using app = await bootApp({ components: [Controller, Service] });

      const resolved = await app.resolve<{ marker: string }>(HARNESS_SERVICE);

      expect(resolved).toBeInstanceOf(Service);
      expect(resolved).toBe((await app.container.resolve<{ marker: string }>(HARNESS_SERVICE)) as { marker: string });

      resolved.marker = 'mutated-through-resolve';

      await app.get('/harness/users/marker').expectStatus(200).expectJson({ marker: 'mutated-through-resolve' });
    });

    scenario('P1.harness.010', 'createWebTest auto-mocks injected dependencies', async () => {
      const { Controller } = userFixture();
      const { app, mocks } = await bootWebTest({ controllers: [Controller] });

      await using _app = app;

      expect(mocks[HARNESS_SERVICE]).not.toBeUndefined();
      mocks[HARNESS_SERVICE].getById.mockResolvedValue({ id: HARNESS_USER_ID, name: 'Ada' });

      await app
        .get(`/harness/users/${HARNESS_USER_ID}`)
        .expectStatus(200)
        .expectJson({ id: HARNESS_USER_ID, name: 'Ada' });

      expect(mocks[HARNESS_SERVICE].getById).toHaveBeenCalledTimes(1);
      expect(mocks[HARNESS_SERVICE].getById).toHaveBeenCalledWith(HARNESS_USER_ID);
    });

    scenario(
      'P1.harness.011',
      'createWebTest registers the route validators for real',
      async () => {
        const { HARNESS_PARAM_VALIDATOR, HARNESS_QUERY_VALIDATOR, validatedControllerFixture } =
          await import('./fixtures/zod.ts');
        const { app } = await bootWebTest({ controllers: [validatedControllerFixture()] });

        await using _app = app;

        expect(app.container.has(HARNESS_PARAM_VALIDATOR)).toBe(true);
        expect(app.container.has(HARNESS_QUERY_VALIDATOR)).toBe(true);

        await app.get(`/harness/validated/${HARNESS_USER_ID}`).expectStatus(200).expectJson({ id: HARNESS_USER_ID });
        await app.get('/harness/validated/not-a-uuid').expectStatus(400);
      },
      { requires: ['optional.zodValidator'] },
    );

    scenario('P1.harness.012', 'a real component passed to createWebTest beats the auto-mock', async () => {
      const { Controller, Service } = userFixture();
      const { app, mocks } = await bootWebTest({ controllers: [Controller], components: [Service] });

      await using _app = app;

      expect(mocks[HARNESS_SERVICE]).toBeUndefined();

      await app
        .get('/harness/users')
        .expectStatus(200)
        .expectJson([{ id: HARNESS_USER_ID, name: 'Real' }]);
    });

    scenario('P1.harness.013', 'createWebTest with no config loaded answers an unknown route with 404', async () => {
      const { Controller } = userFixture();
      const { app } = await bootWebTest({ controllers: [Controller] });

      await using _app = app;

      await app.get('/harness/definitely-not-a-route').expectStatus(404);
    });

    scenario(
      'P1.harness.020',
      "dispatch 'socket' serves routes, params, 404, validators and WebSocket upgrades over a unix socket",
      async () => {
        const users = userFixture();
        const contract = contractFixture();
        await using app = await bootApp({
          components: [users.Controller, users.Service, ...contract.components, ...echoSocketFixture()],
          dispatch: 'socket',
        });

        expect(app.port).toBe(0);
        expect(app.socketPath).not.toBeUndefined();
        expect(app.socketPath!).toContain('.sock');

        await app
          .get('/harness/users')
          .expectStatus(200)
          .expectJson([{ id: HARNESS_USER_ID, name: 'Real' }]);
        await app
          .get(`/harness/users/${HARNESS_USER_ID}`)
          .expectStatus(200)
          .expectJson({ id: HARNESS_USER_ID, name: 'Real' });
        await app.get('/harness/definitely-not-a-route').expectStatus(404);

        await app.get(`/harness/checked/${HARNESS_USER_ID}`).expectStatus(200).expectJson({ id: HARNESS_USER_ID });
        expect(contract.calls.handler).toBe(1);
        await app.get('/harness/checked/not-a-uuid').expectStatus(400);
        expect(contract.calls.handler).toBe(1);

        await using socket = await openWs(app.wsUrl('/harness/ws'));

        socket.send('over-unix');
        expect(await socket.nextText()).toBe('echo:over-unix');
      },
      { requires: ['optional.unixSocket'] },
    );

    scenario('P1.harness.030', '`await using` disposes the app and frees its port', async () => {
      const { Controller, Service } = userFixture();
      let port = 0;

      {
        await using app = await bootApp({ components: [Controller, Service] });

        port = app.port;
        await app.get('/harness/users').expectStatus(200);
        expect(await isPortFree(port)).toBe(false);
      }

      expect(await isPortFree(port)).toBe(true);
    });
  });
}
