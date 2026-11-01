import { afterAll, beforeAll } from 'bun:test';
import type { SpawnedService } from './spawn.ts';
import type { TransportTiming } from './testbed.ts';

// One bed per scenario: boots only when its services are reachable, stops (and sweeps its namespace) afterwards.
export function bedScope<B extends { readonly timing: TransportTiming; stop(): Promise<void> }>(
  bed: B,
  active: boolean,
  setup: (bed: B) => Promise<void>,
): void {
  beforeAll(async () => {
    if (active) await setup(bed);
  }, bed.timing.bootMs);

  afterAll(async () => {
    if (active) await bed.stop();
  }, bed.timing.testMs);
}

// Resolves with whichever replica printed the in-flight marker first; the other replica's watch is dropped.
export async function replicaRunningSlowHandler(replicas: SpawnedService[]): Promise<SpawnedService> {
  return Promise.any(replicas.map((proc) => proc.waitForLine(/\[e2e\] slow start/).then(() => proc)));
}

export async function healthStatus(port: number): Promise<number> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) })).status;
  } catch {
    return 0;
  }
}

export function postBooking(baseUrl: string, dto: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/bookings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(dto),
  });
}
