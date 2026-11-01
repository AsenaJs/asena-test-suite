import { afterAll, expect } from 'bun:test';
import { type UlakError, UlakErrorCode } from '@asenajs/asena/messaging';
import { area, scenario } from '@asenajs/adapter-conformance';
import { waitFor } from '@asenajs/adapter-conformance/helpers';
import { assertReachable } from '../../../src/services.ts';
import { bedScope, healthStatus, postBooking, replicaRunningSlowHandler } from './helpers/bedScope.ts';
import { KAFKA_TIMING, KafkaTestBed } from './helpers/brokerBeds.ts';
import { killAllSpawned, type SpawnedService } from './helpers/spawn.ts';

// Kafka port of the resilience suite. Semantic differences from the Redis file: R1b/R7b assert on committed offsets
// (Kafka's delivery bookkeeping); R7b drops a stale backlog instead of executing it (staleness is judged on every
// dispatch); R8 stops the service before deleting its group (Kafka refuses to delete a non-empty group) and the
// pre-loss event is a gap, not a deduped replay; R9 restarts the broker and is gated by `slow` (see KafkaAdmin).
const active = await assertReachable('kafka');
const opts = { services: ['kafka' as const], timeout: KAFKA_TIMING.testMs };
const id = (n: string) => `P2.microservice.resilience.kafka.${n}`;

const REQUEST_PACING_MS = 100;
const PRE_BIRTH_GRACE_MS = 3000;

afterAll(killAllSpawned);

interface Listed {
  attempt: number;
  data?: { ref?: string };
}

const list = (bed: KafkaTestBed) => bed.clientSend<Listed[]>('notification.list', {}, { timeout: 5000 });
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error as UlakError,
  );

async function committedPast(bed: KafkaTestBed, service: string, topic: string): Promise<boolean> {
  const fetched = await bed.admin.fetchGroupOffsets(service, [topic]);

  return fetched.some((entry) => entry.partitions.some((partition) => partition.offset === '1' && !partition.metadata));
}

area('R1: replica SIGKILL mid-RPC -> rebalance takeover on the survivor', () => {
  const bed = new KafkaTestBed({ REQUEST_TIMEOUT: '2000' });

  bedScope(bed, active, async () => {
    await bed.start(['booking']);
    await bed.spawnReplica('booking');
  });

  scenario(
    id('R1'),
    'a caller with a long timeout gets the reply from the second replica',
    async () => {
      const pending = bed.clientSend<{ pid: number; attempt: number }>(
        'booking.slow',
        { delayMs: 10_000, onlyFirstAttempt: true },
        { timeout: 20_000 },
      );
      const victim = await replicaRunningSlowHandler(bed.replicasOf('booking'));

      victim.kill('SIGKILL');

      const reply = await pending;

      expect(reply.attempt).toBeGreaterThanOrEqual(2);
      expect(reply.pid).not.toBe(victim.pid);
    },
    { ...opts, timeout: 60_000 },
  );
});

area('R1b: a stale request past its caller timeout is dropped on takeover, not re-executed', () => {
  const bed = new KafkaTestBed();

  bedScope(bed, active, async () => {
    await bed.start(['booking']);
    await bed.spawnReplica('booking');
  });

  scenario(
    id('R1b'),
    'the survivor commits the stale record without re-running the handler and without DLQ',
    async () => {
      const replicas = bed.replicasOf('booking');
      const pending = failure(bed.clientSend('booking.slow', { delayMs: 10_000 }, { timeout: 800 }));
      const victim = await replicaRunningSlowHandler(replicas);
      const survivor = replicas.find((proc) => proc !== victim)!;

      victim.kill('SIGKILL');
      expect((await pending)?.message).toMatch(/timed out/);

      await waitFor(() => committedPast(bed, 'booking-service', `${bed.topicPrefix}.req.booking.slow`), {
        timeout: 30_000,
        interval: 100,
        label: 'stale record committed away on takeover',
      });

      expect(survivor.output()).not.toContain('[e2e] slow start');
      expect(await bed.admin.dlqCount()).toBe(0);
    },
    { ...opts, timeout: 60_000 },
  );
});

area('R2: graceful shutdown keeps an uncommitted failed event for the next instance', () => {
  // RETRY_BACKOFF far above the scenario: the redelivery must come from broker state, not the local retry.
  const bed = new KafkaTestBed({ RETRY_BACKOFF: '30000' });

  bedScope(bed, active, () => bed.start(['notification']));

  scenario(
    id('R2'),
    'the replacement instance receives the event with attempt >= 2',
    async () => {
      const first = bed.get('notification');

      await bed.clientEmit('booking.created', { failAttempts: 1, ref: 'r2' });
      await waitFor(
        async () =>
          (await bed.clientSend<{ rawDeliveries: number }>('notification.stats', {}, { timeout: 5000 }))
            .rawDeliveries >= 1,
        { timeout: 15_000, interval: 50, label: 'first delivery attempt happened' },
      );
      await first.stopGracefully();
      await bed.spawnReplica('notification');
      await waitFor(async () => (await list(bed)).some((record) => record.data?.ref === 'r2' && record.attempt >= 2), {
        timeout: 30_000,
        interval: 100,
        label: 'uncommitted event redelivered to the replacement with attempt >= 2',
      });
    },
    opts,
  );
});

area('R3: a poison event lands in the DLQ topic with provenance', () => {
  const bed = new KafkaTestBed({ MAX_RETRIES: '2', RETRY_BACKOFF: '300' });

  bedScope(bed, active, () => bed.start(['notification']));

  scenario(
    id('R3'),
    'after maxRetries seek-based redeliveries the record moves to the DLQ',
    async () => {
      await bed.clientEmit('booking.poison', { poison: true, ref: 'r3' });
      await waitFor(async () => (await bed.admin.dlqCount()) === 1, {
        timeout: 30_000,
        interval: 200,
        label: 'poison record reaches the DLQ',
      });

      const [fields] = await bed.admin.dlqEntries();

      expect(fields.origin_group).toBe('notification-service');
      expect(fields.origin_stream).toBe(`${bed.topicPrefix}.evt`);
      expect(fields.p).toBe('booking.poison');
      expect(Number(fields.delivery_count)).toBeGreaterThan(2);
      expect((await list(bed)).some((record) => record.data?.ref === 'r3')).toBe(false);
    },
    opts,
  );
});

area('R4: rolling deploy with zero failed requests', () => {
  const bed = new KafkaTestBed();

  bedScope(bed, active, async () => {
    await bed.start(['gateway', 'booking']);
    await bed.spawnReplica('booking');
  });

  scenario(
    id('R4'),
    '30 requests across a graceful replica swap all succeed exactly once',
    async () => {
      const [a, b] = bed.replicasOf('booking');
      const results: { id: string; clientRef: string }[] = [];
      let swap: Promise<void> | undefined;
      let respawn: Promise<SpawnedService> | undefined;

      for (let i = 0; i < 30; i++) {
        if (i === 10) swap = a.stopGracefully();
        if (i === 20) respawn = bed.spawnReplica('booking');

        const response = await postBooking(bed.baseUrl, { roomId: `R${i}`, guest: `G${i}`, clientRef: `r4-${i}` });

        expect(response.status).toBe(201);
        results.push((await response.json()) as { id: string; clientRef: string });
        await Bun.sleep(REQUEST_PACING_MS);
      }

      await swap;

      const a2 = await respawn;

      if (!a2) throw new Error('the booking replica was not respawned');

      expect(new Set(results.map((result) => result.id)).size).toBe(30);
      expect(results.map((result) => result.clientRef)).toEqual(Array.from({ length: 30 }, (_, i) => `r4-${i}`));

      await b.stopGracefully();

      for (let i = 30; i < 33; i++) {
        const response = await postBooking(bed.baseUrl, { roomId: `R${i}`, guest: `G${i}`, clientRef: `r4-${i}` });

        expect(response.status).toBe(201);
        expect(((await response.json()) as { pid: number }).pid).toBe(a2.pid);
      }
    },
    opts,
  );
});

area('R5: gateway graceful stop lets in-flight HTTP finish its RPC', () => {
  const bed = new KafkaTestBed();

  bedScope(bed, active, () => bed.start(['gateway', 'booking']));

  scenario(
    id('R5'),
    'a request in flight during SIGTERM still gets its reply',
    async () => {
      const inFlight = fetch(`${bed.baseUrl}/bookings/debug/slow?delayMs=1000`);

      await bed.get('booking').waitForLine(/\[e2e\] slow start/, 30_000);

      const stopping = bed.get('gateway').stopGracefully();
      const response = await inFlight;

      expect(response.status).toBe(200);
      expect(((await response.json()) as { pid: number }).pid).toBe(bed.get('booking').pid);
      await stopping;
    },
    { ...opts, timeout: 60_000 },
  );
});

area('R6: events emitted while the consumer is down are not lost', () => {
  const bed = new KafkaTestBed();

  bedScope(bed, active, () => bed.start(['notification']));

  scenario(
    id('R6'),
    'a replacement instance drains the backlog exactly once',
    async () => {
      await bed.get('notification').stopGracefully();

      for (let i = 0; i < 3; i++) await bed.clientEmit('booking.created', { ref: `r6-${i}` });

      await bed.spawnReplica('notification');
      await waitFor(
        async () => {
          const records = await list(bed);

          return [0, 1, 2].every((i) => records.filter((record) => record.data?.ref === `r6-${i}`).length === 1);
        },
        { timeout: 30_000, interval: 100, label: 'all 3 backlog events delivered exactly once' },
      );
    },
    opts,
  );
});

area("R7a: requests sent before a service's first boot are invisible (latest reset)", () => {
  const bed = new KafkaTestBed();

  bedScope(bed, active, () => bed.start([]));

  scenario(
    id('R7a'),
    'a pre-birth request neither answers nor executes after boot',
    async () => {
      const error = await failure(
        bed.clientSend('booking.create', { roomId: 'R', guest: 'Ghost', clientRef: 'ghost' }, { timeout: 800 }),
      );

      expect(error?.code).toBe(UlakErrorCode.TIMEOUT);

      await bed.spawnReplica('booking');
      // Proving a negative: give the booted service time to (wrongly) pick the request up.
      await Bun.sleep(PRE_BIRTH_GRACE_MS);

      const dump = await bed.clientSend<{ clientRef: string }[]>('booking.dump', {}, { timeout: 15_000 });

      expect(dump.some((booking) => booking.clientRef === 'ghost')).toBe(false);
    },
    opts,
  );
});

area('R7b: a stale request in the restart backlog is dropped, never executed', () => {
  const bed = new KafkaTestBed();

  bedScope(bed, active, () => bed.start(['booking']));

  scenario(
    id('R7b'),
    'the zombie is dropped and the retrying caller converges on one booking',
    async () => {
      await bed.get('booking').stopGracefully();

      const dto = { roomId: 'R', guest: 'Zombie', clientRef: 'r7b-x' };
      const error = await failure(bed.clientSend('booking.create', dto, { timeout: 800 }));

      expect(error?.code).toBe(UlakErrorCode.TIMEOUT);

      const replacement = await bed.spawnReplica('booking');

      await waitFor(() => committedPast(bed, 'booking-service', `${bed.topicPrefix}.req.booking.create`), {
        timeout: 30_000,
        interval: 100,
        label: 'stale backlog record committed away without execution',
      });

      const mine = async () =>
        (await bed.clientSend<{ id: string; clientRef: string }[]>('booking.dump', {}, { timeout: 15_000 })).filter(
          (booking) => booking.clientRef === 'r7b-x',
        );

      expect(await mine()).toEqual([]);
      expect(replacement.alive).toBe(true);

      const retry = await bed.clientSend<{ id: string }>('booking.create', dto, { timeout: 15_000 });
      const after = await mine();

      expect(after.length).toBe(1);
      expect(after[0].id).toBe(retry.id);
    },
    opts,
  );
});

area('R8: consumer group deleted between instances -> delivery resumes with a gap', () => {
  const bed = new KafkaTestBed();

  bedScope(bed, active, () => bed.start(['notification']));

  scenario(
    id('R8'),
    'delivery resumes after the group vanishes; the pre-loss event is not replayed',
    async () => {
      const seen = async (ref: string) => (await list(bed)).filter((record) => record.data?.ref === ref).length;

      await bed.clientEmit('booking.created', { ref: 'r8-before' });
      await waitFor(async () => (await seen('r8-before')) > 0, {
        timeout: 15_000,
        interval: 100,
        label: 'baseline delivery before group destruction',
      });

      await bed.get('notification').stopGracefully();
      await bed.admin.destroyDeliveryState('notification-service');

      const replacement = await bed.spawnReplica('notification');

      await bed.clientEmit('booking.created', { ref: 'r8-after' });
      await waitFor(async () => (await seen('r8-after')) > 0, {
        timeout: 30_000,
        interval: 100,
        label: 'delivery after group re-creation',
      });

      expect(replacement.alive).toBe(true);
      expect(await seen('r8-before')).toBe(0);
    },
    opts,
  );
});

area('R9: broker connection loss -> health degrades, then full recovery', () => {
  const bed = new KafkaTestBed();

  bedScope(bed, active && process.env.ASENA_SUITE_SLOW === '1', () => bed.start());

  scenario(
    id('R9'),
    'healthz reports the outage and a full round-trip works after a broker restart',
    async () => {
      const ports = (['gateway', 'booking', 'notification', 'inventory'] as const).map((name) =>
        bed.healthPortOf(bed.get(name)),
      );

      for (const port of ports) expect(await healthStatus(port)).toBe(200);

      // The restart call returns only once the broker serves again, so the 503 watch runs concurrently with it.
      const saw503 = waitFor(async () => (await Promise.all(ports.map(healthStatus))).includes(503), {
        timeout: 60_000,
        interval: 20,
        label: 'at least one service reports degraded (503)',
      });

      await bed.admin.severConnections();
      await saw503;
      await waitFor(async () => (await Promise.all(ports.map(healthStatus))).every((status) => status === 200), {
        timeout: 60_000,
        interval: 100,
        label: 'all services recovered (200)',
      });

      const response = await postBooking(bed.baseUrl, { roomId: 'R9', guest: 'Reconnect', clientRef: 'r9-final' });

      expect(response.status).toBe(201);
    },
    { services: ['kafka', 'slow'], timeout: 180_000 },
  );
});
