import { afterAll, expect } from 'bun:test';
import { type UlakError, UlakErrorCode } from '@asenajs/asena/messaging';
import { area, scenario } from '@asenajs/adapter-conformance';
import { waitFor } from '@asenajs/adapter-conformance/helpers';
import { assertReachable } from '../../../src/services.ts';
import { bedScope, healthStatus, postBooking, replicaRunningSlowHandler } from './helpers/bedScope.ts';
import { REDIS_TIMING, RedisTestBed } from './helpers/brokerBeds.ts';
import { killAllSpawned, type SpawnedService } from './helpers/spawn.ts';

const active = await assertReachable('redis');
const opts = { services: ['redis' as const], timeout: REDIS_TIMING.testMs };
const id = (n: string) => `P2.microservice.resilience.redis.${n}`;

// Intentional delays that belong to the scenarios, not delivery waits.
const REQUEST_PACING_MS = 100;
const PRE_BIRTH_GRACE_MS = 2000;

afterAll(killAllSpawned);

interface Listed {
  attempt: number;
  data?: { ref?: string };
}

const list = (bed: RedisTestBed) => bed.clientSend<Listed[]>('notification.list', {}, { timeout: 3000 });
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error as UlakError,
  );

area('R1: replica SIGKILL mid-RPC -> sweep rescue on the survivor', () => {
  // requestTimeout (2 s) is below the rescue moment (CLAIM_IDLE_MS) and the caller timeout (20 s): staleness must be
  // judged against the caller's own timeout in the envelope, not the service-side default.
  const bed = new RedisTestBed({ CLAIM_IDLE_MS: '3000', REQUEST_TIMEOUT: '2000' });

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
    opts,
  );
});

area('R1b: a stale request past its caller timeout is dropped by the sweep, not re-executed', () => {
  const bed = new RedisTestBed({ CLAIM_IDLE_MS: '3000' });

  bedScope(bed, active, async () => {
    await bed.start(['booking']);
    await bed.spawnReplica('booking');
  });

  scenario(
    id('R1b'),
    'the sweep acks the stale entry without re-running the handler and without DLQ',
    async () => {
      const replicas = bed.replicasOf('booking');
      const pending = failure(bed.clientSend('booking.slow', { delayMs: 10_000 }, { timeout: 800 }));
      const victim = await replicaRunningSlowHandler(replicas);
      const survivor = replicas.find((proc) => proc !== victim)!;

      victim.kill('SIGKILL');
      expect((await pending)?.message).toMatch(/timed out/);

      await waitFor(
        async () => (await bed.admin.xpendingCount(`${bed.streamPrefix}:req:booking.slow`, 'booking-service')) === 0,
        { timeout: 15_000, interval: 25, label: 'stale entry acked by the sweep' },
      );

      expect(survivor.output()).not.toContain('[e2e] slow start');
      expect(await bed.admin.dlqCount()).toBe(0);
    },
    opts,
  );
});

area('R2: graceful shutdown keeps a pending failed event for the next instance', () => {
  const bed = new RedisTestBed({ CLAIM_IDLE_MS: '1500' });

  bedScope(bed, active, () => bed.start(['notification']));

  scenario(
    id('R2'),
    'the replacement instance receives the event with attempt >= 2',
    async () => {
      const first = bed.get('notification');

      await bed.clientEmit('booking.created', { failAttempts: 1, ref: 'r2' });
      await waitFor(
        async () =>
          (await bed.clientSend<{ rawDeliveries: number }>('notification.stats', {}, { timeout: 3000 }))
            .rawDeliveries >= 1,
        { timeout: 5000, interval: 25, label: 'first delivery attempt happened' },
      );
      await first.stopGracefully();
      await bed.spawnReplica('notification');
      await waitFor(async () => (await list(bed)).some((record) => record.data?.ref === 'r2' && record.attempt >= 2), {
        timeout: 10_000,
        interval: 25,
        label: 'pending event redelivered to the replacement with attempt >= 2',
      });
    },
    opts,
  );
});

area('R3: a poison event lands in the DLQ with provenance', () => {
  const bed = new RedisTestBed({ CLAIM_IDLE_MS: '1500', MAX_RETRIES: '2' });

  bedScope(bed, active, () => bed.start(['notification']));

  scenario(
    id('R3'),
    'after maxRetries sweep redeliveries the entry moves to the DLQ',
    async () => {
      await bed.clientEmit('booking.poison', { poison: true, ref: 'r3' });
      await waitFor(async () => (await bed.admin.dlqCount()) === 1, {
        timeout: 20_000,
        interval: 200,
        label: 'poison entry reaches the DLQ',
      });

      const [fields] = await bed.admin.dlqEntries();

      expect(fields.origin_group).toBe('notification-service');
      expect(fields.origin_stream).toBe(`${bed.streamPrefix}:evt`);
      expect(fields.p).toBe('booking.poison');
      expect(Number(fields.delivery_count)).toBeGreaterThan(2);
      expect((await list(bed)).some((record) => record.data?.ref === 'r3')).toBe(false);
    },
    opts,
  );
});

area('R4: rolling deploy with zero failed requests', () => {
  const bed = new RedisTestBed();

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

      // Retire B so only the fresh replica can answer.
      await b.stopGracefully();

      for (let i = 30; i < 33; i++) {
        const response = await postBooking(bed.baseUrl, { roomId: `R${i}`, guest: `G${i}`, clientRef: `r4-${i}` });

        expect(response.status).toBe(201);
        expect(((await response.json()) as { pid: number }).pid).toBe(a2.pid);
      }
    },
    { ...opts, timeout: 40_000 },
  );
});

area('R5: gateway graceful stop lets in-flight HTTP finish its RPC', () => {
  const bed = new RedisTestBed();

  bedScope(bed, active, () => bed.start(['gateway', 'booking']));

  scenario(
    id('R5'),
    'a request in flight during SIGTERM still gets its reply',
    async () => {
      const inFlight = fetch(`${bed.baseUrl}/bookings/debug/slow?delayMs=1000`);

      await bed.get('booking').waitForLine(/\[e2e\] slow start/);

      const stopping = bed.get('gateway').stopGracefully();
      const response = await inFlight;

      expect(response.status).toBe(200);
      expect(((await response.json()) as { pid: number }).pid).toBe(bed.get('booking').pid);
      await stopping;
    },
    opts,
  );
});

area('R6: events emitted while the consumer is down are not lost', () => {
  const bed = new RedisTestBed();

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
        { timeout: 10_000, interval: 25, label: 'all 3 backlog events delivered exactly once' },
      );
    },
    opts,
  );
});

area("R7a: requests sent before a service's first boot are invisible ('$' group start)", () => {
  const bed = new RedisTestBed();

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

      const dump = await bed.clientSend<{ clientRef: string }[]>('booking.dump', {}, { timeout: 5000 });

      expect(dump.some((booking) => booking.clientRef === 'ghost')).toBe(false);
    },
    opts,
  );
});

area('R7b: a stale request in the restart backlog executes once (documented at-least-once)', () => {
  const bed = new RedisTestBed();

  bedScope(bed, active, () => bed.start(['booking']));

  scenario(
    id('R7b'),
    'the zombie executes exactly once and domain idempotency absorbs the retry',
    async () => {
      await bed.get('booking').stopGracefully();

      const dto = { roomId: 'R', guest: 'Zombie', clientRef: 'r7b-x' };
      const error = await failure(bed.clientSend('booking.create', dto, { timeout: 800 }));

      expect(error?.code).toBe(UlakErrorCode.TIMEOUT);

      const replacement = await bed.spawnReplica('booking');
      const mine = async () =>
        (await bed.clientSend<{ id: string; clientRef: string }[]>('booking.dump', {}, { timeout: 3000 })).filter(
          (booking) => booking.clientRef === 'r7b-x',
        );

      await waitFor(async () => (await mine()).length === 1, {
        timeout: 10_000,
        interval: 25,
        label: 'backlogged create executed exactly once',
      });
      expect(replacement.alive).toBe(true);

      const retry = await bed.clientSend<{ id: string }>('booking.create', dto, { timeout: 5000 });
      const after = await mine();

      expect(after.length).toBe(1);
      expect(after[0].id).toBe(retry.id);
    },
    opts,
  );
});

area('R8: consumer group destroyed mid-run -> automatic NOGROUP recovery', () => {
  const bed = new RedisTestBed({ CLAIM_IDLE_MS: '1500' });

  bedScope(bed, active, () => bed.start(['notification']));

  scenario(
    id('R8'),
    'delivery resumes after the group vanishes; replayed entries are deduped',
    async () => {
      const seen = async (ref: string) => (await list(bed)).filter((record) => record.data?.ref === ref).length;

      await bed.clientEmit('booking.created', { ref: 'r8-before' });
      await waitFor(async () => (await seen('r8-before')) > 0, {
        timeout: 5000,
        interval: 25,
        label: 'baseline delivery before group destruction',
      });

      await bed.admin.destroyDeliveryState('notification-service');
      await bed.clientEmit('booking.created', { ref: 'r8-after' });
      await waitFor(async () => (await seen('r8-after')) > 0, {
        timeout: 10_000,
        interval: 25,
        label: 'delivery after NOGROUP recovery',
      });

      expect(bed.get('notification').alive).toBe(true);
      // The group is recreated at '0': r8-before is replayed with the same entry id and the dedup absorbs it.
      expect(await seen('r8-before')).toBe(1);
    },
    opts,
  );
});

area('R9: broker connection loss -> health degrades, then full recovery', () => {
  const bed = new RedisTestBed({}, { proxy: true });

  bedScope(bed, active, () => bed.start());

  scenario(
    id('R9'),
    'healthz reports the outage and a full round-trip works after reconnect',
    async () => {
      const ports = (['gateway', 'booking', 'notification', 'inventory'] as const).map((name) =>
        bed.healthPortOf(bed.get(name)),
      );

      for (const port of ports) expect(await healthStatus(port)).toBe(200);

      await bed.admin.severConnections();

      // Observability first (either the wedge watchdog or a reconnect window reports 503), then the real proof: a full
      // HTTP -> RPC round-trip after reconnect.
      await waitFor(async () => (await Promise.all(ports.map(healthStatus))).includes(503), {
        timeout: 12_000,
        interval: 20,
        label: 'at least one service reports degraded (503)',
      });
      await waitFor(async () => (await Promise.all(ports.map(healthStatus))).every((status) => status === 200), {
        timeout: 20_000,
        interval: 100,
        label: 'all services recovered (200)',
      });

      const response = await postBooking(bed.baseUrl, { roomId: 'R9', guest: 'Reconnect', clientRef: 'r9-final' });

      expect(response.status).toBe(201);
    },
    { ...opts, timeout: 45_000 },
  );
});
