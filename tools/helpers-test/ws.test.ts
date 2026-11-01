import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';
import { openWs, TestSocket, waitFor } from '@asenajs/adapter-conformance/helpers';
import { errorOf } from './errorOf.ts';

interface Data {
  path: string;
}

interface Probe {
  serverPings: number;
  serverPongs: number;
  sockets: ServerWebSocket<Data>[];
  protocols: string | null;
  headerValue: string | null;
}

let server: Server<Data> | undefined;
let unixDir: string | undefined;

function serve(options: { unix?: string } = {}): { url: string; probe: Probe } {
  const probe: Probe = { serverPings: 0, serverPongs: 0, sockets: [], protocols: null, headerValue: null };
  const base = {
    fetch(req: Request, srv: Server<Data>) {
      const url = new URL(req.url);

      if (url.pathname === '/reject') return new Response('forbidden', { status: 403 });

      probe.protocols = req.headers.get('sec-websocket-protocol');
      probe.headerValue = req.headers.get('x-probe');

      const protocol = probe.protocols?.split(',')[0]?.trim();
      const upgraded = srv.upgrade(req, {
        data: { path: url.pathname },
        ...(protocol && { headers: { 'Sec-WebSocket-Protocol': protocol } }),
      });

      return upgraded ? undefined : new Response('upgrade failed', { status: 400 });
    },
    websocket: {
      open(ws: ServerWebSocket<Data>) {
        probe.sockets.push(ws);

        if (ws.data.path === '/ping-twice') {
          ws.ping();
          ws.ping();
        }

        if (ws.data.path === '/close-4001') ws.close(4001, 'reason');
      },
      message(ws: ServerWebSocket<Data>, message: string | Buffer) {
        ws.send(message);
      },
      ping() {
        probe.serverPings++;
      },
      pong() {
        probe.serverPongs++;
      },
    },
  };

  server = options.unix ? Bun.serve<Data>({ ...base, unix: options.unix }) : Bun.serve<Data>({ ...base, port: 0 });

  const url = options.unix ? `ws+unix://${options.unix}:` : `ws://localhost:${server.port}`;

  return { url, probe };
}

afterEach(async () => {
  await server?.stop(true);
  server = undefined;

  if (unixDir) rmSync(unixDir, { recursive: true, force: true });
  unixDir = undefined;
});

describe('openWs', () => {
  it('returns a TestSocket and echoes text', async () => {
    const { url } = serve();
    await using socket = await openWs(`${url}/echo`);

    expect(socket).toBeInstanceOf(TestSocket);
    socket.send('hello');
    expect(await socket.nextMessage()).toBe('hello');
  });

  it('round-trips a binary frame byte-exact', async () => {
    const { url } = serve();
    await using socket = await openWs(`${url}/echo`);
    const payload = new Uint8Array([0, 1, 2, 127, 128, 254, 255, 0, 42]);

    socket.send(payload);

    const received = await socket.nextMessage();

    expect(received).toBeInstanceOf(Uint8Array);
    expect(Array.from(received as Uint8Array)).toEqual(Array.from(payload));
  });

  it('parses JSON with json() and nextJson()', async () => {
    const { url } = serve();
    await using socket = await openWs(`${url}/echo`);

    socket.json({ a: 1, b: ['x'] });
    expect(await socket.nextJson()).toEqual({ a: 1, b: ['x'] });
  });

  it('passes protocols and headers to the upgrade request', async () => {
    const { url, probe } = serve();
    await using socket = await openWs(`${url}/echo`, { protocols: ['p1', 'p2'], headers: { 'x-probe': 'yes' } });

    expect(probe.protocols).toBe('p1, p2');
    expect(probe.headerValue).toBe('yes');
    expect(socket.protocol).toBe('p1');
  });

  it('rejects when the upgrade is refused', async () => {
    const { url } = serve();

    expect((await errorOf(openWs(`${url}/reject`))).message).toContain('closed before open');
  });

  it('buffers messages that arrive before nextMessage is called', async () => {
    const { url, probe } = serve();
    await using socket = await openWs(`${url}/echo`);

    await waitFor(() => probe.sockets.length === 1);
    probe.sockets[0].send('one');
    probe.sockets[0].send('two');
    await waitFor(() => socket.buffered.length === 2);

    expect(await socket.nextMessage()).toBe('one');
    expect(await socket.nextMessage()).toBe('two');
  });

  it('nextMessage rejects after its timeout', async () => {
    const { url } = serve();
    await using socket = await openWs(`${url}/echo`);

    expect((await errorOf(socket.nextMessage({ timeout: 50 }))).message).toBe('no message within 50ms');
  });

  it('works over ws+unix://', async () => {
    unixDir = mkdtempSync(join(tmpdir(), 'helpers-ws-'));
    const { url } = serve({ unix: join(unixDir, 'app.sock') });
    await using socket = await openWs(`${url}/echo`);

    socket.send('over unix');
    expect(await socket.nextMessage()).toBe('over unix');
  });
});

describe('expectNoMessage', () => {
  it('resolves when nothing arrives', async () => {
    const { url } = serve();
    await using socket = await openWs(`${url}/echo`);

    await socket.expectNoMessage(50);
  });

  it('rejects when a message arrives inside the window and keeps it queued', async () => {
    const { url, probe } = serve();
    await using socket = await openWs(`${url}/echo`);

    await waitFor(() => probe.sockets.length === 1);

    const pending = socket.expectNoMessage(500);

    probe.sockets[0].send('late');

    expect((await errorOf(pending)).message).toContain('expected no message');
    expect(await socket.nextMessage()).toBe('late');
  });

  it('rejects when a message is already buffered', async () => {
    const { url } = serve();
    await using socket = await openWs(`${url}/echo`);

    socket.send('buffered');
    await waitFor(() => socket.buffered.length === 1);

    expect((await errorOf(socket.expectNoMessage(10))).message).toContain('expected no message');
    expect(await socket.nextMessage()).toBe('buffered');
  });

  it('does not lose a message that arrives right after it resolves', async () => {
    const { url, probe } = serve();
    await using socket = await openWs(`${url}/echo`);

    await waitFor(() => probe.sockets.length === 1);
    await socket.expectNoMessage(30);
    probe.sockets[0].send('right after');

    expect(await socket.nextMessage()).toBe('right after');
  });
});

describe('ping / pong counters', () => {
  it('counts two server pings', async () => {
    const { url } = serve();
    await using socket = await openWs(`${url}/ping-twice`);

    await waitFor(() => socket.pings === 2);
    expect(socket.pings).toBe(2);
    expect(socket.pongs).toBe(0);
  });

  it('client ping reaches the server ping handler and the pong is counted', async () => {
    const { url, probe } = serve();
    await using socket = await openWs(`${url}/echo`);

    socket.ping('hi');

    await waitFor(() => probe.serverPings === 1 && socket.pongs === 1);
    expect(probe.serverPings).toBe(1);
    expect(socket.pongs).toBe(1);
    expect(socket.pings).toBe(0);
  });
});

describe('close', () => {
  it('resolves closed with the server close code and reason', async () => {
    const { url } = serve();
    const socket = await openWs(`${url}/close-4001`);

    expect(await socket.closed).toEqual({ code: 4001, reason: 'reason' });
  });

  it('rejects pending nextMessage when the server closes', async () => {
    const { url, probe } = serve();
    const socket = await openWs(`${url}/echo`);

    await waitFor(() => probe.sockets.length === 1);

    const pending = socket.nextMessage({ timeout: 2000 });

    probe.sockets[0].close(4002, 'bye');

    expect((await errorOf(pending)).message).toContain('socket closed (4002 bye)');
  });

  it('client close resolves with its code and reason', async () => {
    const { url } = serve();
    const socket = await openWs(`${url}/echo`);

    expect(await socket.close(4100, 'done')).toEqual({ code: 4100, reason: 'done' });
  });
});
