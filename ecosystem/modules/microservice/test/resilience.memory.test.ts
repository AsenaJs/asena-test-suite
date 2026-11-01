import { afterAll, expect } from 'bun:test';
import { join } from 'node:path';
import { scenario } from '@asenajs/adapter-conformance';
import { killAllSpawned, SpawnedService, SRC_DIR } from './helpers/spawn.ts';
import { freePort, MEMORY_TIMING } from './helpers/testbed.ts';

afterAll(killAllSpawned);

// The all-in-one process (gateway and every message controller on one in-memory bus) is a child of this test, so
// SIGTERM drives the real lifecycle: the adapter drains the in-flight request before the transport goes down.
scenario(
  'P2.microservice.resilience.memory.R5',
  'a graceful stop lets an in-flight HTTP request finish its RPC',
  async () => {
    const httpPort = await freePort();
    const healthPort = await freePort();
    const app = new SpawnedService('all-in-one', join(SRC_DIR, 'index.ts'), {
      HTTP_PORT: String(httpPort),
      HEALTH_PORT: String(healthPort),
    });

    await app.waitReady(healthPort);

    const inFlight = fetch(`http://127.0.0.1:${httpPort}/bookings/debug/slow?delayMs=1000`);

    await app.waitForLine(/\[e2e\] slow start/);

    const stopping = app.stopGracefully();
    const response = await inFlight;

    expect(response.status).toBe(200);
    expect(((await response.json()) as { pid: number }).pid).toBe(app.pid);
    await stopping;
  },
  { timeout: MEMORY_TIMING.testMs },
);
