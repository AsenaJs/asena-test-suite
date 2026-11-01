import { afterAll, expect } from 'bun:test';
import { area, scenario } from '@asenajs/adapter-conformance';
import { waitFor } from '@asenajs/adapter-conformance/helpers';
import { assertReachable } from '../../../src/services.ts';
import { bedScope } from './helpers/bedScope.ts';
import { KAFKA_TIMING, MixedTestBed } from './helpers/brokerBeds.ts';
import { killAllSpawned } from './helpers/spawn.ts';

// Redis as `default` plus kafka by name in the same processes. bridge: the only transport-aware controller, consumes
// kafka events and re-emits them onto redis. notification: prefix-only, bound to redis; its kafka side is client-only.
const redis = await assertReachable('redis');
const kafka = await assertReachable('kafka');
const active = redis && kafka;
const opts = { services: ['redis' as const, 'kafka' as const], timeout: KAFKA_TIMING.testMs };
const id = (n: string) => `P2.microservice.mixed.${n}`;
const rpc = { timeout: KAFKA_TIMING.rpcTimeoutMs };

afterAll(killAllSpawned);

interface Listed {
  pattern: string;
  headers: Record<string, string>;
  data?: { ref?: string; orderId?: string };
}

interface Bridged {
  bridged: number;
  events: { pattern: string; headers: Record<string, string> }[];
}

const list = (bed: MixedTestBed) => bed.redisSend<Listed[]>('notification.list', {}, { timeout: 5000 });
const delivered = async (bed: MixedTestBed, ref: string) =>
  (await list(bed)).some((record) => record.data?.ref === ref);

interface Health {
  status: number;
  body?: { status?: string; transports?: Record<string, string> };
}

async function health(port: number): Promise<Health> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });

    return { status: response.status, body: (await response.json()) as Health['body'] };
  } catch {
    return { status: 0 };
  }
}

area('MX1: dual boot + health', () => {
  const bed = new MixedTestBed();

  bedScope(bed, active, () => bed.start());

  scenario(
    id('MX1'),
    'both transports run in one process: healthz reports both connected and both flows reach the same pids',
    async () => {
      for (const name of ['bridge', 'notification'] as const) {
        const { status, body } = await health(bed.healthPortOf(bed.get(name)));

        expect(status).toBe(200);
        expect(body?.status).toBe('up');
        expect(body?.transports).toEqual({ default: 'connected', kafka: 'connected' });
      }

      const pong = await bed.kafkaSend<{ transport: string; pid: number }>('bridge.ping', {}, rpc);

      expect(pong.transport).toBe('kafka');
      expect(pong.pid).toBe(bed.get('bridge').pid);

      await bed.redisEmit('booking.created', { ref: 'mx1-redis' });
      await waitFor(() => delivered(bed, 'mx1-redis'), {
        timeout: KAFKA_TIMING.waitForMs,
        interval: 50,
        label: 'redis-side delivery',
      });
    },
    opts,
  );
});

area('MX2: broker isolation', () => {
  const bed = new MixedTestBed();

  bedScope(bed, active, () => bed.start());

  scenario(
    id('MX2'),
    'events published on the wrong broker reach nobody',
    async () => {
      await bed.kafkaEmit('booking.created', { ref: 'mx2-kafka' });
      await bed.redisEmit('upstream.order-created', { ref: 'mx2-redis' });
      // Give both misrouted events time to arrive and be ignored before asserting the negatives.
      await Bun.sleep(KAFKA_TIMING.settleMs);

      expect(await delivered(bed, 'mx2-kafka')).toBe(false);
      expect((await bed.kafkaSend<Bridged>('bridge.dump', {}, rpc)).bridged).toBe(0);

      const pong = await bed.kafkaSend<{ transport: string }>('bridge.ping', {}, rpc);

      expect(pong.transport).toBe('kafka');
    },
    opts,
  );
});

area('MX3: cross-broker bridge', () => {
  const bed = new MixedTestBed();

  bedScope(bed, active, () => bed.start());

  scenario(
    id('MX3'),
    'a kafka event is bridged onto redis with its headers carried across',
    async () => {
      await bed.kafkaEmit('upstream.order-created', { orderId: 'o-77' }, { headers: { 'x-trace': 't1' } });

      const bridged = await waitFor(async () => (await list(bed)).find((record) => record.data?.orderId === 'o-77'), {
        timeout: KAFKA_TIMING.chainMs,
        interval: 50,
        label: 'cross-broker bridged delivery',
      });

      expect(bridged.pattern).toBe('booking.created');
      expect(bridged.headers['x-trace']).toBe('t1');

      const dump = await bed.kafkaSend<Bridged>('bridge.dump', {}, rpc);

      expect(dump.bridged).toBe(1);
      expect(dump.events[0].pattern).toBe('upstream.order-created');
      expect(dump.events[0].headers['x-trace']).toBe('t1');
    },
    opts,
  );
});

area('MX4: partial outage - kafka down, redis flows on', () => {
  const bed = new MixedTestBed();

  bedScope(bed, active && process.env.ASENA_SUITE_SLOW === '1', () => bed.start());

  scenario(
    id('MX4'),
    'healthz degrades with kafka disconnected and default connected, redis keeps flowing, then everything recovers',
    async () => {
      const ports = (['bridge', 'notification'] as const).map((name) => bed.healthPortOf(bed.get(name)));

      for (const port of ports) expect((await health(port)).status).toBe(200);

      const degraded = waitFor(
        async () => {
          for (const port of ports) {
            const { status, body } = await health(port);

            if (
              status === 503 &&
              body?.transports?.kafka === 'disconnected' &&
              body.transports.default === 'connected'
            ) {
              return body;
            }
          }

          return undefined;
        },
        { timeout: 60_000, interval: 20, label: 'degraded healthz during the kafka outage' },
      );
      const severed = bed.kafkaAdmin.severConnections();

      await bed.redisEmit('booking.created', { ref: 'mx4-during' });
      await waitFor(() => delivered(bed, 'mx4-during'), {
        timeout: KAFKA_TIMING.waitForMs,
        interval: 50,
        label: 'redis delivery during the kafka outage',
      });
      expect((await degraded).status).toBe('degraded');
      await severed;
      await waitFor(async () => (await Promise.all(ports.map(health))).every((entry) => entry.status === 200), {
        timeout: 60_000,
        interval: 100,
        label: 'all healthz back to 200',
      });
      await waitFor(
        async () =>
          (await bed.kafkaSend<{ transport: string }>('bridge.ping', {}, { timeout: 5000 })).transport === 'kafka',
        { timeout: KAFKA_TIMING.waitForMs, interval: 200, label: 'kafka RPC after recovery' },
      );
    },
    { services: ['redis', 'kafka', 'slow'], timeout: 180_000 },
  );
});

area('MX5: graceful shutdown + lifecycle durability', () => {
  const bed = new MixedTestBed();

  bedScope(bed, active, () => bed.start());

  scenario(
    id('MX5'),
    'stops cleanly with both transports active and resumes the durable kafka group after respawn',
    async () => {
      await bed.kafkaEmit('upstream.order-created', { ref: 'mx5-pre' });
      await bed.redisEmit('booking.created', { ref: 'mx5-redis' });
      await waitFor(async () => (await delivered(bed, 'mx5-pre')) && (await delivered(bed, 'mx5-redis')), {
        timeout: KAFKA_TIMING.chainMs,
        interval: 50,
        label: 'both flows delivered before shutdown',
      });

      await bed.get('bridge').stopGracefully(3000);
      await bed.kafkaEmit('upstream.order-created', { ref: 'mx5-missed' });
      await bed.spawnReplica('bridge');
      await waitFor(() => delivered(bed, 'mx5-missed'), {
        timeout: KAFKA_TIMING.chainMs,
        interval: 50,
        label: 'missed event bridged after respawn',
      });
    },
    opts,
  );
});
