import { describe, expect, it } from 'bun:test';
import {
  bootApps,
  isPortFree,
  randomPort,
  recordCalls,
  waitFor,
  withTimeout,
} from '@asenajs/adapter-conformance/helpers';
import { errorOf } from './errorOf.ts';

describe('waitFor', () => {
  it('resolves with the first truthy value', async () => {
    let n = 0;

    expect(await waitFor(() => (++n >= 3 ? n : 0), { interval: 1 })).toBe(3);
  });

  it('rejects after the timeout and keeps the last predicate error as cause', async () => {
    const failure = waitFor(
      () => {
        throw new Error('not yet');
      },
      { timeout: 30, interval: 5, label: 'probe' },
    );

    const error = await errorOf(failure);

    expect(error.message).toBe('waitFor: probe not met within 30ms');
    expect((error.cause as Error).message).toBe('not yet');
  });
});

describe('withTimeout', () => {
  it('passes the value through', async () => {
    expect(await withTimeout(Promise.resolve(5), 50, 'fast')).toBe(5);
  });

  it('rejects with the label', async () => {
    const error = await errorOf(withTimeout(new Promise(() => undefined), 20, 'slow op'));

    expect(error.message).toBe('slow op timed out after 20ms');
  });
});

describe('ports', () => {
  it('randomPort stays in 10000-31999', () => {
    for (let i = 0; i < 1000; i++) {
      const port = randomPort();

      expect(port).toBeGreaterThanOrEqual(10000);
      expect(port).toBeLessThanOrEqual(31999);
    }
  });

  it('isPortFree sees a bound port and its release', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('ok') });
    const port = server.port!;

    expect(await isPortFree(port)).toBe(false);
    await server.stop(true);
    expect(await waitFor(() => isPortFree(port))).toBe(true);
  });
});

describe('bootApps', () => {
  const fakeApp = (log: string[], index: number, failStop = false) => ({
    index,
    stop: async () => {
      log.push(`stop:${index}`);
      if (failStop) throw new Error(`stop ${index}`);
    },
  });

  it('boots n apps with their index and stops all once', async () => {
    const log: string[] = [];
    const booted = await bootApps(3, async (index) => fakeApp(log, index));

    expect(booted.apps.map((app) => app.index)).toEqual([0, 1, 2]);
    await booted.stopAll();
    await booted.stopAll();
    expect(log.sort()).toEqual(['stop:0', 'stop:1', 'stop:2']);
  });

  it('supports await using', async () => {
    const log: string[] = [];

    {
      await using booted = await bootApps(2, async (index) => fakeApp(log, index));

      expect(booted.apps.length).toBe(2);
    }

    expect(log.sort()).toEqual(['stop:0', 'stop:1']);
  });

  it('stops the booted apps when one boot fails', async () => {
    const log: string[] = [];
    const attempt = bootApps(3, async (index) => {
      if (index === 1) throw new Error('boot 1 failed');

      return fakeApp(log, index);
    });

    expect((await errorOf(attempt)).message).toBe('boot 1 failed');
    expect(log.sort()).toEqual(['stop:0', 'stop:2']);
  });

  it('stopAll reports every stop failure', async () => {
    const log: string[] = [];
    const booted = await bootApps(2, async (index) => fakeApp(log, index, true));

    expect(await errorOf(booted.stopAll())).toBeInstanceOf(AggregateError);
    expect(log.sort()).toEqual(['stop:0', 'stop:1']);
  });
});

class PlainAdapter {
  #port = 0;
  routes: string[] = [];
  notFound: unknown;

  setPort(port: number) {
    this.#port = port;
  }

  get port() {
    return this.#port;
  }

  registerRoute(path: string) {
    this.routes.push(path);
  }

  onNotFound(handler: unknown) {
    this.notFound = handler;
  }

  async start() {
    this.registerRoute('/internal');

    return this.#port;
  }

  stop() {}

  helper() {
    return 'not recorded';
  }
}

describe('recordCalls', () => {
  it('records contract-member calls in order without changing behaviour', async () => {
    const { adapter, calls } = recordCalls(new PlainAdapter());

    adapter.setPort(1234);
    adapter.registerRoute('/a');
    adapter.helper();
    expect(await adapter.start()).toBe(1234);
    adapter.stop();

    expect(calls.map((call) => call.member)).toEqual(['setPort', 'registerRoute', 'start', 'stop']);
    expect(calls.map((call) => call.at)).toEqual([0, 1, 2, 3]);
    expect(adapter.port).toBe(1234);
    expect(adapter.routes).toEqual(['/a', '/internal']);
    expect(adapter).toBeInstanceOf(PlainAdapter);
  });

  it('returns a stable wrapper per member', () => {
    const { adapter } = recordCalls(new PlainAdapter());

    expect(Reflect.get(adapter, 'registerRoute')).toBe(Reflect.get(adapter, 'registerRoute'));
  });

  it('hide makes members read as undefined and absent', () => {
    const { adapter, calls } = recordCalls(new PlainAdapter(), { hide: ['onNotFound'] });

    expect(typeof adapter.onNotFound).toBe('undefined');
    expect('onNotFound' in adapter).toBe(false);
    expect('registerRoute' in adapter).toBe(true);
    expect(calls).toEqual([]);
  });
});
