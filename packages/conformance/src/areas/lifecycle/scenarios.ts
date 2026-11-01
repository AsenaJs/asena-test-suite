import { expect } from 'bun:test';
import type { AsenaAdapter, AsenaStartOptions } from '@asenajs/asena/adapter';
import { createCapturingLogger, silentLogger } from '@asenajs/asena/test';
import { bootApp } from '../../boot.ts';
import { bootApps } from '../../helpers/multiApp.ts';
import { isPortFree, randomPort } from '../../helpers/ports.ts';
import { type RecordedCall, type RecordedMember, recordCalls } from '../../helpers/recordingAdapter.ts';
import { waitFor, withTimeout } from '../../helpers/wait.ts';
import { getDescriptor } from '../../load.ts';
import { area, scenario } from '../../scenario.ts';
import {
  BODY_LIMIT,
  bodyLimitFixture,
  notFoundFixture,
  pingFixture,
  slowFixture,
  thirdPartyFixture,
} from './fixtures/components.ts';
import { isNonEmptyName } from './fixtures/nameProbe.ts';

const JSON_HEADERS = { 'content-type': 'application/json' };

async function freePort(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const port = randomPort();

    if (await isPortFree(port)) return port;
  }

  return randomPort();
}

function freshAdapter(): AsenaAdapter<any, any> {
  return getDescriptor().createAdapter({ logger: silentLogger });
}

function withStartOptions<A extends AsenaAdapter<any, any>>(adapter: A, extra: Record<string, unknown>): A {
  return new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'start') {
        return (options?: AsenaStartOptions) => target.start({ ...options, ...extra });
      }

      return Reflect.get(target, prop);
    },
  });
}

function indexes(calls: RecordedCall[], member: RecordedMember): number[] {
  return calls.flatMap((call, index) => (call.member === member ? [index] : []));
}

function rawGet(port: number, path: string): Promise<{ socket: Bun.Socket<undefined>; head: string }> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;

    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(socket) {
          socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n`);
        },
        data(socket, chunk) {
          buffer += chunk.toString();

          if (!settled && buffer.includes('\r\n\r\n')) {
            settled = true;
            resolve({ socket, head: buffer.slice(0, buffer.indexOf('\r\n')) });
          }
        },
        error(_socket, error) {
          if (!settled) {
            settled = true;
            reject(error);
          }
        },
      },
    }).catch(reject);
  });
}

export function register(): void {
  area('lifecycle', () => {
    scenario('P1.lifecycle.001', 'an explicit port is the port the app serves on', async () => {
      const port = await freePort();
      await using app = await bootApp({ components: pingFixture(), port });

      expect(app.port).toBe(port);

      const response = await fetch(`http://localhost:${port}/lifecycle/ping`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ pong: '/lifecycle' });
    });

    scenario('P1.lifecycle.002', 'port 0 binds a real port and serves on it', async () => {
      await using app = await bootApp({ components: pingFixture(), port: 0 });

      expect(app.port).toBeGreaterThan(0);

      const response = await fetch(`http://localhost:${app.port}/lifecycle/ping`);

      expect(response.status).toBe(200);
    });

    scenario('P1.lifecycle.003', 'start() returns the Bun server listening on the requested port', async () => {
      const port = await freePort();
      await using app = await bootApp({ components: pingFixture(), port });
      const server = app.server.httpServer;

      expect(server).not.toBeUndefined();
      expect(server!.port).toBe(port);
      expect(typeof server!.stop).toBe('function');
      expect(server!.url.port).toBe(String(port));
    });

    scenario(
      'P1.lifecycle.004',
      'start({ unix }) serves over the socket and binds no TCP port',
      async () => {
        await using app = await bootApp({ components: pingFixture(), dispatch: 'socket' });

        expect(app.socketPath).not.toBeUndefined();
        expect(app.port).toBe(0);
        expect(app.server.httpServer?.port).toBeUndefined();

        const response = await app.get('/lifecycle/ping');

        expect(response.status).toBe(200);
        expect(response.json()).toEqual({ pong: '/lifecycle' });
      },
      { requires: ['optional.unixSocket'] },
    );

    scenario('P1.lifecycle.005', 'an unknown start option is ignored and the app serves normally', async () => {
      const adapter = withStartOptions(recordCalls(freshAdapter()).adapter, { unknownOption: true });
      await using app = await bootApp({ components: pingFixture(), adapter });
      const response = await app.get('/lifecycle/ping');

      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ pong: '/lifecycle' });
    });

    scenario('P1.lifecycle.006', 'AsenaAdapter.name is a non-empty string', () => {
      expect(isNonEmptyName(freshAdapter())).toBe(true);
    });

    for (const [id, mode] of [
      ['P1.lifecycle.010', 'sync'],
      ['P1.lifecycle.011', 'async'],
    ] as const) {
      scenario(
        id,
        `${mode} serveOptions() are applied: a body over maxRequestBodySize is rejected with 413`,
        async () => {
          await using app = await bootApp({ components: bodyLimitFixture(mode) });

          const small = await app.post('/lifecycle/body', {
            headers: JSON_HEADERS,
            body: JSON.stringify('x'.repeat(BODY_LIMIT / 4)),
          });

          expect(small.status).toBe(200);

          const large = await app.post('/lifecycle/body', {
            headers: JSON_HEADERS,
            body: JSON.stringify('x'.repeat(BODY_LIMIT * 2)),
          });

          expect(large.status).toBe(413);
        },
      );
    }

    scenario(
      'P1.lifecycle.020',
      'a route registered from @OnStart answers and gets global middlewares and onError',
      async () => {
        const fixture = thirdPartyFixture();
        await using app = await bootApp({ components: fixture.components });

        expect(fixture.onStartRan()).toBe(true);

        const ok = await app.get('/lifecycle/third-party');

        expect(ok.status).toBe(200);
        expect(ok.json()).toEqual({ thirdParty: true, global: 'ran' });

        const boom = await app.get('/lifecycle/third-party-boom');

        expect(boom.status).toBe(418);
        expect(boom.json()).toEqual({ handled: 'third-party-boom' });
        expect(fixture.errors).toEqual(['third-party-boom']);
      },
    );

    scenario('P1.lifecycle.030', 'serveOptions is called after the @OnStart registerRoute', async () => {
      const recorded = recordCalls(freshAdapter());
      const fixture = thirdPartyFixture();
      await using app = await bootApp({ components: fixture.components, adapter: recorded.adapter });

      const firstRoute = indexes(recorded.calls, 'registerRoute')[0];
      const firstServeOptions = indexes(recorded.calls, 'serveOptions')[0];

      expect(firstRoute).not.toBeUndefined();
      expect(firstServeOptions).not.toBeUndefined();
      expect(firstRoute).toBeLessThan(firstServeOptions);
      expect((await app.get('/lifecycle/third-party')).status).toBe(200);
    });

    scenario('P1.lifecycle.031', 'core drives the adapter in the documented call order', async () => {
      const recorded = recordCalls(freshAdapter());
      const fixture = thirdPartyFixture({ controller: true });
      const app = await bootApp({ components: fixture.components, adapter: recorded.adapter });

      try {
        expect((await app.get('/lifecycle/ping')).status).toBe(200);
      } finally {
        await app.stop();
      }

      const { calls } = recorded;
      const [start] = indexes(calls, 'start');

      expect(start).not.toBeUndefined();
      expect(calls[0].member).toBe('setPort');

      for (const member of ['registerRoute', 'serveOptions', 'onError', 'use'] as const) {
        const seen = indexes(calls, member);

        expect({ member, seen: seen.length > 0 }).toEqual({ member, seen: true });
        expect({ member, afterStart: seen.filter((index) => index > start) }).toEqual({ member, afterStart: [] });
      }

      expect(calls[calls.length - 1].member).toBe('stop');
    });

    scenario('P1.lifecycle.032', 'two apps in one process answer independently', async () => {
      await using booted = await bootApps(2, (index) =>
        bootApp({ components: pingFixture(`/lifecycle-${index}`), port: 0 }),
      );
      const [first, second] = booted.apps;

      expect((await first.get('/lifecycle-0/ping')).json()).toEqual({ pong: '/lifecycle-0' });
      expect((await second.get('/lifecycle-1/ping')).json()).toEqual({ pong: '/lifecycle-1' });
      expect((await second.get('/lifecycle-0/ping')).status).toBe(404);

      await first.stop();

      const after = await second.get('/lifecycle-1/ping');

      expect(after.status).toBe(200);
      expect(after.json()).toEqual({ pong: '/lifecycle-1' });
    });

    scenario('P1.lifecycle.040', 'stop() resolves with an idle keep-alive connection open', async () => {
      const app = await bootApp({ components: pingFixture() });
      let socket: Bun.Socket<undefined> | undefined;

      try {
        const opened = await withTimeout(rawGet(app.port, '/lifecycle/ping'), 2000, 'keep-alive request');

        socket = opened.socket;
        expect(opened.head).toBe('HTTP/1.1 200 OK');

        await withTimeout(app.stop(), 5000, 'stop() with an idle keep-alive connection');
      } finally {
        socket?.end();
        await app.stop();
      }
    });

    scenario('P1.lifecycle.041', 'stop(false) lets an in-flight request finish; stop() closes it', async () => {
      const graceful = slowFixture();
      const app = await bootApp({ components: graceful.components });

      try {
        const pending = fetch(`http://localhost:${app.port}/lifecycle/slow`);

        await waitFor(() => graceful.entered() === 1, { label: 'slow handler entered' });

        const stopping = app.server.stop(false);

        graceful.release();

        const response = await withTimeout(pending, 5000, 'in-flight request under stop(false)');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ slow: 'done' });
        await withTimeout(stopping, 5000, 'stop(false)');
      } finally {
        graceful.release();
        await app.stop();
      }

      const forced = slowFixture();
      const second = await bootApp({ components: forced.components });

      try {
        const pending = fetch(`http://localhost:${second.port}/lifecycle/slow`).then(
          (response) => ({ status: response.status }),
          () => ({ status: 'connection-closed' as const }),
        );

        await waitFor(() => forced.entered() === 1, { label: 'slow handler entered' });
        await withTimeout(second.stop(), 5000, 'stop() with an in-flight request');
        forced.release();

        expect(await withTimeout(pending, 5000, 'in-flight request under stop()')).toEqual({
          status: 'connection-closed',
        });
      } finally {
        forced.release();
        await second.stop();
      }
    });

    scenario('P1.lifecycle.042', 'stopping twice, sequentially and concurrently, is safe', async () => {
      const app = await bootApp({ components: pingFixture() });

      await Promise.all([app.server.stop(), app.server.stop()]);
      await app.server.stop();
      await app.stop();
      await app.stop();

      expect(await isPortFree(app.port)).toBe(true);
    });

    scenario('P1.lifecycle.043', 'after stop() the port is free again', async () => {
      const app = await bootApp({ components: pingFixture() });
      const { port } = app;

      expect(await isPortFree(port)).toBe(false);

      await app.stop();

      expect(await isPortFree(port)).toBe(true);
    });

    scenario(
      'P1.lifecycle.050',
      'an adapter without onNotFound: core warns and the adapter fallback still answers 404',
      async () => {
        const { logger, entries } = createCapturingLogger();
        const recorded = recordCalls(getDescriptor().createAdapter({ logger }), { hide: ['onNotFound'] });
        const fixture = notFoundFixture();
        await using app = await bootApp({ components: fixture.components, adapter: recorded.adapter, logger });

        const warnings = entries.filter((entry) => entry.level === 'warn' && entry.message.includes('onNotFound'));

        expect(warnings.length).toBe(1);

        const response = await app.get('/lifecycle/missing');

        expect(response.status).toBe(404);
        expect(fixture.hookCalls()).toBe(0);
        expect(indexes(recorded.calls, 'onNotFound')).toEqual([]);
        expect((await app.get('/lifecycle/ping')).status).toBe(200);
      },
    );
  });
}
