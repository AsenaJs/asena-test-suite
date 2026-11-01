import { expect } from 'bun:test';
import type { TestApp } from '@asenajs/asena/test';
import { silentLogger } from '@asenajs/asena/test';
import type { AsenaWebSocketService } from '@asenajs/asena/web-socket';
import { bootApp } from '../../boot.ts';
import { waitFor, withTimeout } from '../../helpers/wait.ts';
import { openWs, type TestSocket } from '../../helpers/ws.ts';
import { getDescriptor } from '../../load.ts';
import { area, scenario } from '../../scenario.ts';
import {
  DeferredTransport,
  ECHO_PATH,
  ECHO_SOCKET,
  FLOOD_FRAME_BYTES,
  type FloodResult,
  HookProbe,
  INHERITED_PATH,
  TRANSPORT_INIT_FAILURE,
  UPGRADE_VALUES,
  wsFixture,
} from './fixtures/sockets.ts';

const QUIET_MS = 300;
const JSON_HEADERS = { 'content-type': 'application/json' };
const UPGRADE_HEADERS = {
  connection: 'Upgrade',
  upgrade: 'websocket',
  'sec-websocket-version': '13',
  'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
};

function probeOf(app: TestApp): Promise<HookProbe> {
  return app.resolve<HookProbe>('HookProbe');
}

async function whoami(socket: TestSocket): Promise<string> {
  socket.json({ type: 'whoami' });

  const reply = await socket.nextJson<{ type: string; id: string }>();

  expect(reply.type).toBe('whoami');

  return reply.id;
}

async function join(socket: TestSocket, room: string): Promise<void> {
  socket.json({ type: 'join', room });
  expect(await socket.nextJson()).toEqual({ type: 'joined', room });
}

async function socketCount(app: TestApp): Promise<number> {
  const response = await app.get('/ws-ulak/count');

  expect(response.status).toBe(200);

  return response.json<{ count: number }>().count;
}

export function register(): void {
  area('websocket', () => {
    scenario('P1.websocket.001', 'an upgrade request opens a socket and runs onOpen', async () => {
      await using app = await bootApp({ components: wsFixture().components });
      await using socket = await openWs(app.wsUrl(ECHO_PATH));
      const probe = await probeOf(app);

      expect(socket.readyState).toBe(WebSocket.OPEN);
      await waitFor(() => probe.count('onOpen') === 1, { label: 'onOpen recorded' });
      expect(probe.count('onOpen')).toBe(1);
    });

    scenario('P1.websocket.002', 'onMessage receives text and the reply carries the socket id', async () => {
      await using app = await bootApp({ components: wsFixture().components });
      await using socket = await openWs(app.wsUrl(ECHO_PATH));
      const probe = await probeOf(app);
      const opened = await waitFor(() => probe.of('onOpen')[0], { label: 'onOpen recorded' });

      socket.send('hello world');

      expect(await socket.nextJson()).toEqual({ echo: 'hello world', from: opened.socketId });
    });

    scenario('P1.websocket.003', 'two clients are served independently', async () => {
      await using app = await bootApp({ components: wsFixture().components });
      await using first = await openWs(app.wsUrl(ECHO_PATH));
      await using second = await openWs(app.wsUrl(ECHO_PATH));
      const firstId = await whoami(first);
      const secondId = await whoami(second);

      expect(firstId).not.toBe(secondId);

      first.send('from-first');
      second.send('from-second');

      expect(await first.nextJson()).toEqual({ echo: 'from-first', from: firstId });
      expect(await second.nextJson()).toEqual({ echo: 'from-second', from: secondId });
      await first.expectNoMessage(100);
      await second.expectNoMessage(100);
    });

    scenario('P1.websocket.004', 'a client close with 1000 reaches onClose with code 1000', async () => {
      await using app = await bootApp({ components: wsFixture().components });
      const socket = await openWs(app.wsUrl(ECHO_PATH));
      const probe = await probeOf(app);
      const id = await whoami(socket);

      expect((await withTimeout(socket.close(1000, 'bye'), 2000, 'client close')).code).toBe(1000);

      const closed = await waitFor(() => probe.of('onClose', id)[0], { label: 'onClose recorded' });

      expect(closed.payload).toEqual({ code: 1000, reason: 'bye' });
    });

    scenario('P1.websocket.005', 'an inherited @WebSocket subclass runs the undecorated base handlers', async () => {
      await using app = await bootApp({ components: wsFixture({ inherited: true }).components });
      await using socket = await openWs(app.wsUrl(INHERITED_PATH));

      socket.send('inherited');

      expect(await socket.nextJson()).toEqual({ echo: 'inherited', from: 'ConformanceInheritedSocket' });
    });

    scenario('P1.websocket.006', 'a binary frame round-trips byte for byte', async () => {
      await using app = await bootApp({ components: wsFixture().components });
      await using socket = await openWs(app.wsUrl(ECHO_PATH));
      const bytes = Uint8Array.from({ length: 1024 }, (_, index) => index % 256);

      socket.send(bytes);

      const reply = await socket.nextMessage();

      expect(reply).toBeInstanceOf(Uint8Array);
      expect(reply).toEqual(bytes);
    });

    scenario('P1.websocket.007', 'a server-initiated close(4001, reason) reaches the client exactly', async () => {
      await using app = await bootApp({ components: wsFixture().components });
      await using socket = await openWs(app.wsUrl(ECHO_PATH));
      const probe = await probeOf(app);
      const id = await whoami(socket);

      socket.send('close-me');

      expect(await withTimeout(socket.closed, 2000, 'server close')).toEqual({ code: 4001, reason: 'policy reason' });

      const closed = await waitFor(() => probe.of('onClose', id)[0], { label: 'onClose recorded' });

      expect((closed.payload as { code: number }).code).toBe(4001);
    });

    scenario('P1.websocket.010', 'an upgrade middleware returning false refuses the upgrade with 403', async () => {
      const fixture = wsFixture({ upgrade: 'reject' });
      await using app = await bootApp({ components: fixture.components });
      const probe = await probeOf(app);

      const refused = await openWs(app.wsUrl(ECHO_PATH), { timeout: 2000 }).then(
        async (socket) => {
          await socket.close();

          return undefined;
        },
        (error: unknown) => error,
      );

      expect(refused).toBeInstanceOf(Error);
      expect((refused as Error).message).toContain('openWs');

      const response = await app.get(ECHO_PATH, { headers: UPGRADE_HEADERS });

      expect(response.status).toBe(403);
      expect(fixture.upgradeCalls.count).toBe(2);
      expect(probe.count('onOpen')).toBe(0);
    });

    scenario(
      'P1.websocket.011',
      'setWebSocketValue in an upgrade middleware is visible in ws.data.values',
      async () => {
        const fixture = wsFixture({ upgrade: 'values' });
        await using app = await bootApp({ components: fixture.components });
        await using socket = await openWs(app.wsUrl(ECHO_PATH));
        const probe = await probeOf(app);
        const opened = await waitFor(() => probe.of('onOpen')[0], { label: 'onOpen recorded' });

        expect(fixture.upgradeCalls.count).toBe(1);
        expect(opened.payload).toEqual(UPGRADE_VALUES);

        socket.json({ type: 'values' });

        expect(await socket.nextJson()).toEqual({ type: 'values', values: UPGRADE_VALUES });
      },
    );

    scenario('P1.websocket.020', 'a room message reaches members only', async () => {
      await using app = await bootApp({ components: wsFixture().components });
      await using member = await openWs(app.wsUrl(ECHO_PATH));
      await using outsider = await openWs(app.wsUrl(ECHO_PATH));

      await join(member, 'lobby');
      outsider.json({ type: 'to', room: 'lobby', data: 'hi lobby' });

      expect(await member.nextJson()).toEqual({ type: 'room', room: 'lobby', data: 'hi lobby' });
      await outsider.expectNoMessage(QUIET_MS);
    });

    scenario('P1.websocket.021', 'after leaving a room nothing more arrives from it', async () => {
      await using app = await bootApp({ components: wsFixture().components });
      await using leaver = await openWs(app.wsUrl(ECHO_PATH));
      await using stayer = await openWs(app.wsUrl(ECHO_PATH));
      await using sender = await openWs(app.wsUrl(ECHO_PATH));

      await join(leaver, 'lobby');
      await join(stayer, 'lobby');

      leaver.json({ type: 'leave', room: 'lobby' });
      expect(await leaver.nextJson()).toEqual({ type: 'left', room: 'lobby' });

      sender.json({ type: 'to', room: 'lobby', data: 'after leave' });

      expect(await stayer.nextJson()).toEqual({ type: 'room', room: 'lobby', data: 'after leave' });
      await leaver.expectNoMessage(QUIET_MS);
    });

    scenario('P1.websocket.022', 'an ulak broadcast from an HTTP route reaches every client', async () => {
      await using app = await bootApp({ components: wsFixture({ ulak: true }).components });
      await using first = await openWs(app.wsUrl(ECHO_PATH));
      await using second = await openWs(app.wsUrl(ECHO_PATH));
      const probe = await probeOf(app);

      await waitFor(() => probe.count('onOpen') === 2, { label: 'both sockets opened' });

      const response = await app.post('/ws-ulak/broadcast', {
        headers: JSON_HEADERS,
        body: JSON.stringify({ message: 'hello all' }),
      });

      expect(response.status).toBe(200);
      expect(await first.nextJson()).toEqual({ message: 'hello all' });
      expect(await second.nextJson()).toEqual({ message: 'hello all' });
    });

    scenario('P1.websocket.023', 'ulak toSocket reaches only the target socket', async () => {
      await using app = await bootApp({ components: wsFixture({ ulak: true }).components });
      await using target = await openWs(app.wsUrl(ECHO_PATH));
      await using bystander = await openWs(app.wsUrl(ECHO_PATH));
      const targetId = await whoami(target);

      await whoami(bystander);

      const response = await app.post('/ws-ulak/to-socket', {
        headers: JSON_HEADERS,
        body: JSON.stringify({ socketId: targetId, data: { direct: true } }),
      });

      expect(response.status).toBe(200);
      expect(await target.nextJson()).toEqual({ direct: true });
      await bystander.expectNoMessage(QUIET_MS);
    });

    scenario('P1.websocket.024', 'the ulak socket count follows opens and closes', async () => {
      await using app = await bootApp({ components: wsFixture({ ulak: true }).components });

      expect(await socketCount(app)).toBe(0);

      const first = await openWs(app.wsUrl(ECHO_PATH));

      await waitFor(async () => (await socketCount(app)) === 1, { label: 'count 1' });

      await using second = await openWs(app.wsUrl(ECHO_PATH));

      await waitFor(async () => (await socketCount(app)) === 2, { label: 'count 2' });

      await withTimeout(first.close(1000), 2000, 'client close');
      await waitFor(async () => (await socketCount(app)) === 1, { label: 'count back to 1' });

      expect(await socketCount(app)).toBe(1);
      expect(second.readyState).toBe(WebSocket.OPEN);
    });

    scenario('P1.websocket.025', 'socket.publish reaches other room members but not the sender', async () => {
      await using app = await bootApp({ components: wsFixture().components });
      await using sender = await openWs(app.wsUrl(ECHO_PATH));
      await using receiver = await openWs(app.wsUrl(ECHO_PATH));

      await join(sender, 'news');
      await join(receiver, 'news');

      sender.json({ type: 'publish', room: 'news', data: 'extra' });

      expect(await receiver.nextJson()).toEqual({ type: 'published', room: 'news', data: 'extra' });
      await sender.expectNoMessage(QUIET_MS);
    });

    scenario('P1.websocket.030', "heartbeat 'adapter' pings every client and onPong counts the replies", async () => {
      const components = wsFixture({ wsOptions: { sendPingStrategy: 'adapter', heartbeatInterval: 50 } }).components;
      await using app = await bootApp({ components });
      await using first = await openWs(app.wsUrl(ECHO_PATH));
      await using second = await openWs(app.wsUrl(ECHO_PATH));
      const probe = await probeOf(app);
      const firstId = await whoami(first);
      const secondId = await whoami(second);

      await waitFor(
        () =>
          first.pings >= 2 &&
          second.pings >= 2 &&
          probe.count('onPong', firstId) >= 2 &&
          probe.count('onPong', secondId) >= 2,
        { timeout: 1000, label: 'two heartbeats per client' },
      ).catch(() => undefined);

      expect(first.pings).toBeGreaterThanOrEqual(2);
      expect(second.pings).toBeGreaterThanOrEqual(2);
      expect(probe.count('onPong', firstId)).toBeGreaterThanOrEqual(2);
      expect(probe.count('onPong', secondId)).toBeGreaterThanOrEqual(2);
    });

    scenario('P1.websocket.031', "heartbeat 'native' sends no adapter pings and keeps the socket open", async () => {
      const components = wsFixture({ wsOptions: { sendPingStrategy: 'native', heartbeatInterval: 50 } }).components;
      await using app = await bootApp({ components });
      await using socket = await openWs(app.wsUrl(ECHO_PATH));
      const probe = await probeOf(app);
      const id = await whoami(socket);

      await socket.expectNoMessage(500);

      expect(socket.pings).toBe(0);
      expect(probe.count('onPong', id)).toBe(0);
      expect(socket.readyState).toBe(WebSocket.OPEN);
    });

    scenario('P1.websocket.032', 'a client ping reaches onPing for that socket', async () => {
      await using app = await bootApp({ components: wsFixture().components });
      await using socket = await openWs(app.wsUrl(ECHO_PATH));
      const probe = await probeOf(app);
      const id = await whoami(socket);

      socket.ping('p');

      const ping = await waitFor(() => probe.of('onPing', id)[0], { timeout: 1000, label: 'onPing recorded' });

      expect(ping.payload).toBe('p');
    });

    scenario(
      'P1.websocket.033',
      'onDrain runs after backpressure and every frame still arrives',
      async () => {
        const components = wsFixture({ wsOptions: { backpressureLimit: FLOOD_FRAME_BYTES } }).components;
        await using app = await bootApp({ components });
        await using socket = await openWs(app.wsUrl(ECHO_PATH));
        const probe = await probeOf(app);
        const id = await whoami(socket);

        socket.send('flood');

        const flood = await waitFor(() => probe.of('flood', id)[0], { label: 'flood recorded' });
        const result = flood.payload as FloodResult;

        expect(result.statuses).toContain(-1);
        expect(result.statuses.filter((status) => status === 0)).toEqual([]);

        await waitFor(() => probe.count('onDrain', id) >= 1, { timeout: 5000, label: 'onDrain recorded' }).catch(
          () => undefined,
        );

        expect(probe.count('onDrain', id)).toBeGreaterThanOrEqual(1);

        let received = 0;

        while (received < result.sent) {
          const frame = await socket.nextMessage({ timeout: 5000 });

          expect(frame).toBeInstanceOf(Uint8Array);
          expect((frame as Uint8Array).byteLength).toBe(FLOOD_FRAME_BYTES);
          received++;
        }

        expect(received).toBe(result.sent);
        await socket.expectNoMessage(100);
      },
      { timeout: 20000 },
    );

    scenario(
      'P1.websocket.040',
      'start() resolves only after transport.init completed and service.server is assigned',
      async () => {
        const transport = new DeferredTransport({ delayMs: 50 });
        const app = await bootApp({ components: wsFixture({ transport }).components });

        try {
          const initCompleted = transport.initCompleted;
          const service = await app.resolve<AsenaWebSocketService>(ECHO_SOCKET);
          const server = service.server ?? null;

          expect(transport.initCalled).toBe(true);
          expect(initCompleted).toBe(true);
          expect(server).not.toBeNull();
        } finally {
          await withTimeout(transport.settled, 2000, 'transport init');
          await app.stop();
        }
      },
    );

    scenario(
      'P1.websocket.041',
      'a rejecting transport.init fails start() instead of escaping as an unhandled rejection',
      async () => {
        const transport = new DeferredTransport({ delayMs: 200, fail: true });
        const adapter = getDescriptor().createAdapter({ logger: silentLogger });
        let app: TestApp | undefined;
        let bootError: unknown;
        let initPendingAfterStart = false;

        try {
          try {
            app = await bootApp({ components: wsFixture({ transport }).components, adapter });
          } catch (error) {
            bootError = error;
          }

          initPendingAfterStart = transport.initCalled && !transport.initSettled;

          if (initPendingAfterStart) transport.defuse();

          await withTimeout(transport.settled, 2000, 'transport init');
        } finally {
          if (app) await app.stop();
          else await adapter.stop(true).catch(() => undefined);
        }

        expect(transport.initCalled).toBe(true);
        expect(initPendingAfterStart).toBe(false);
        expect(bootError).toBeInstanceOf(Error);
        expect((bootError as Error).message).toContain(TRANSPORT_INIT_FAILURE);
      },
    );

    scenario('P1.websocket.042', 'service.to(room) publishes through the configured transport', async () => {
      const transport = new DeferredTransport({ delayMs: 0 });
      await using app = await bootApp({ components: wsFixture({ transport }).components });
      const service = await app.resolve<AsenaWebSocketService>(ECHO_SOCKET);

      await waitFor(() => transport.initCompleted && service.server, { label: 'transport ready' });

      await using member = await openWs(app.wsUrl(ECHO_PATH));

      await join(member, 'room-a');

      service.to('room-a', { hello: 'transport' });

      expect(transport.published).toEqual([
        { topic: `${service.namespace}.room-a`, data: JSON.stringify({ hello: 'transport' }) },
      ]);
      expect(await member.nextJson()).toEqual({ hello: 'transport' });
    });

    scenario('P1.websocket.043', 'stop() destroys the configured transport', async () => {
      const transport = new DeferredTransport({ delayMs: 0 });
      const app = await bootApp({ components: wsFixture({ transport }).components });

      try {
        await waitFor(() => transport.initCompleted, { label: 'transport ready' });
        expect(transport.destroyCalls).toBe(0);
      } finally {
        await app.stop();
      }

      expect(transport.destroyCalls).toBe(1);
    });

    scenario(
      'P1.websocket.050',
      'stop() with open sockets closes them and resolves',
      async () => {
        const app = await bootApp({ components: wsFixture().components });
        await using first = await openWs(app.wsUrl(ECHO_PATH));
        await using second = await openWs(app.wsUrl(ECHO_PATH));

        await whoami(first);
        await whoami(second);

        const [, closes] = await Promise.all([
          withTimeout(app.stop(), 5000, 'app.stop()'),
          withTimeout(Promise.all([first.closed, second.closed]), 5000, 'client close'),
        ]);

        expect(closes).toHaveLength(2);
        expect(first.readyState).toBe(WebSocket.CLOSED);
        expect(second.readyState).toBe(WebSocket.CLOSED);
      },
      { timeout: 15000 },
    );
  });
}
