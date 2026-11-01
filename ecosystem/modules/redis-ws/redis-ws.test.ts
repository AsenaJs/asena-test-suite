import { expect } from 'bun:test';
import { silentLogger, type TestApp } from '@asenajs/asena/test';
import type { AsenaWebSocketService } from '@asenajs/asena/web-socket';
import {
  type AdapterDescriptor,
  bootApp,
  getDescriptor,
  mixedDescriptors,
  scenario,
} from '@asenajs/adapter-conformance';
import {
  type BootedApps,
  bootApps,
  openWs,
  type TestSocket,
  waitFor,
  withTimeout,
} from '@asenajs/adapter-conformance/helpers';
import { runNamespace } from '../../src/namespace.ts';
import { assertReachable } from '../../src/services.ts';
import { POD_PATH, POD_SOCKET, podComponents, ProbedRedisTransport } from './fixtures/pods.ts';

await assertReachable('redis');

const UNREACHABLE_REDIS = 'redis://localhost:1';
const redis = { services: ['redis' as const] };
const startAwaits = { ...redis, requires: ['ws.startAwaitsTransportInit' as const] };

function redisUrl(): string {
  return process.env.ASENA_SUITE_REDIS_URL ?? '';
}

function channelFor(id: string): string {
  return `${runNamespace()}:ws:${id}`;
}

async function subscribers(channel: string): Promise<number> {
  const client = new Bun.RedisClient(redisUrl());

  try {
    const [, count] = (await client.send('PUBSUB', ['NUMSUB', channel])) as [string, number];

    return Number(count);
  } finally {
    client.close();
  }
}

async function bootPods(channel: string, descriptors?: readonly AdapterDescriptor[]): Promise<BootedApps> {
  const pods = await bootApps(2, (index) =>
    bootApp({
      components: podComponents(new ProbedRedisTransport({ url: redisUrl(), channel })),
      ...(descriptors && { adapter: descriptors[index].createAdapter({ logger: silentLogger }) }),
    }),
  );

  try {
    await waitFor(async () => (await subscribers(channel)) === 2, { timeout: 3000, label: 'both pods subscribed' });
  } catch (error) {
    await pods.stopAll();
    throw error;
  }

  return pods;
}

interface Client {
  socket: TestSocket;
  id: string;
}

async function connect(app: TestApp): Promise<Client> {
  const socket = await openWs(app.wsUrl(POD_PATH));
  const hello = await socket.nextJson<{ type: string; socketId: string }>();

  expect(hello.type).toBe('connected');

  return { socket, id: hello.socketId };
}

async function join(client: Client, room: string): Promise<void> {
  client.socket.json({ type: 'join', room });
  expect(await client.socket.nextJson()).toEqual({ type: 'joined', room });
}

function post(app: TestApp, path: string, body: object) {
  return app.post(path, { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

async function closeAll(clients: Client[]): Promise<void> {
  await Promise.all(clients.map((client) => client.socket.close()));
}

async function broadcastBothWays([podA, podB]: TestApp[]): Promise<void> {
  const clients = [await connect(podA), await connect(podB)];

  try {
    for (const [from, message] of [
      [podA, 'from A'],
      [podB, 'from B'],
    ] as const) {
      expect((await post(from, '/pods/broadcast', { message })).status).toBe(200);

      for (const client of clients) expect(await client.socket.nextJson()).toEqual({ message });
    }
  } finally {
    await closeAll(clients);
  }
}

async function roomAcrossPods([podA, podB]: TestApp[]): Promise<void> {
  const memberA = await connect(podA);
  const memberB = await connect(podB);
  const outsider = await connect(podB);

  try {
    await join(memberA, 'vip');
    await join(memberB, 'vip');

    expect((await post(podA, '/pods/room/vip', { message: 'vip only' })).status).toBe(200);
    expect(await memberA.socket.nextJson()).toEqual({ message: 'vip only' });
    expect(await memberB.socket.nextJson()).toEqual({ message: 'vip only' });
    await outsider.socket.expectNoMessage(200);
  } finally {
    await closeAll([memberA, memberB, outsider]);
  }
}

async function toSocketAcrossPods([podA, podB]: TestApp[]): Promise<void> {
  const target = await connect(podA);
  const bystander = await connect(podB);

  try {
    expect((await post(podB, `/pods/socket/${target.id}`, { message: 'private' })).status).toBe(200);
    expect(await target.socket.nextJson()).toEqual({ message: 'private' });
    await bystander.socket.expectNoMessage(200);
  } finally {
    await closeAll([target, bystander]);
  }
}

scenario(
  'P2.redis-ws.001',
  'a broadcast from either pod reaches the clients of both pods',
  async () => {
    await using pods = await bootPods(channelFor('001'));

    await broadcastBothWays(pods.apps);
  },
  redis,
);

scenario(
  'P2.redis-ws.002',
  'a room message reaches the members on both pods and nobody else',
  async () => {
    await using pods = await bootPods(channelFor('002'));

    await roomAcrossPods(pods.apps);
  },
  redis,
);

scenario(
  'P2.redis-ws.003',
  'toSocket from one pod reaches a socket held by the other pod only',
  async () => {
    await using pods = await bootPods(channelFor('003'));

    await toSocketAcrossPods(pods.apps);
  },
  redis,
);

scenario(
  'P2.redis-ws.004',
  'the socket count is per pod',
  async () => {
    await using pods = await bootPods(channelFor('004'));
    const [podA, podB] = pods.apps;
    const clients = [await connect(podA), await connect(podA), await connect(podB)];

    try {
      expect((await podA.get('/pods/count')).json()).toEqual({ count: 2 });
      expect((await podB.get('/pods/count')).json()).toEqual({ count: 1 });
    } finally {
      await closeAll(clients);
    }
  },
  redis,
);

scenario(
  'P2.redis-ws.005',
  'socket.publish leaves the sender out locally and reaches the remote member',
  async () => {
    await using pods = await bootPods(channelFor('005'));
    const [podA, podB] = pods.apps;
    const sender = await connect(podA);
    const localPeer = await connect(podA);
    const remotePeer = await connect(podB);

    try {
      for (const client of [sender, localPeer, remotePeer]) await join(client, 'chat');

      sender.socket.json({ type: 'say', room: 'chat', message: 'hello room' });

      expect(await localPeer.socket.nextJson()).toEqual({ type: 'said', message: 'hello room' });
      expect(await remotePeer.socket.nextJson()).toEqual({ type: 'said', message: 'hello room' });
      await sender.socket.expectNoMessage(200);
    } finally {
      await closeAll([sender, localPeer, remotePeer]);
    }
  },
  redis,
);

scenario(
  'P2.redis-ws.006',
  'stopping the pods destroys the transport: no Redis subscriber is left on the channel',
  async () => {
    const channel = channelFor('006');
    const pods = await bootPods(channel);

    expect(await subscribers(channel)).toBe(2);

    await pods.stopAll();

    expect(await subscribers(channel)).toBe(0);
  },
  redis,
);

scenario(
  'P2.redis-ws.010',
  'an unreachable Redis fails start() instead of escaping as an unhandled rejection',
  async () => {
    const transport = new ProbedRedisTransport({ url: UNREACHABLE_REDIS, channel: channelFor('010'), latencyMs: 50 });
    const adapter = getDescriptor().createAdapter({ logger: silentLogger });
    let app: TestApp | undefined;
    let bootError: unknown;
    let initPendingAfterStart = false;

    try {
      try {
        app = await bootApp({ components: podComponents(transport), adapter });
      } catch (error) {
        bootError = error;
      }

      initPendingAfterStart = transport.initCalled && !transport.initSettled;

      if (initPendingAfterStart) transport.defuse();

      await withTimeout(transport.settled, 3000, 'transport init');
    } finally {
      if (app) await app.stop();
      else await adapter.stop(true).catch(() => undefined);
    }

    expect(transport.initCalled).toBe(true);
    expect(initPendingAfterStart).toBe(false);
    expect(bootError).toBeInstanceOf(Error);
  },
  startAwaits,
);

scenario(
  'P2.redis-ws.011',
  'each pod has its WebSocket service server assigned when its start() resolves',
  async () => {
    const channel = channelFor('011');
    const transports = [0, 1].map(() => new ProbedRedisTransport({ url: redisUrl(), channel, latencyMs: 50 }));
    const pods = await bootApps(2, (index) => bootApp({ components: podComponents(transports[index]) }));

    try {
      const servers = await Promise.all(
        pods.apps.map(async (app) => (await app.resolve<AsenaWebSocketService>(POD_SOCKET)).server ?? null),
      );

      expect(servers.map((server) => server !== null)).toEqual([true, true]);
    } finally {
      await Promise.all(transports.map((transport) => withTimeout(transport.settled, 3000, 'transport init')));
      await pods.stopAll();
    }
  },
  startAwaits,
);

scenario(
  'P2.redis-ws.020',
  'pods of two different adapters share the transport: broadcast, rooms and toSocket',
  async () => {
    await using pods = await bootPods(channelFor('020'), mixedDescriptors());

    await broadcastBothWays(pods.apps);
    await roomAcrossPods(pods.apps);
    await toSocketAcrossPods(pods.apps);
  },
  { services: ['redis', 'mixed'] },
);
