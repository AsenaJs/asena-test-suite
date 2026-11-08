import { randomPort } from '@asenajs/adapter-conformance/helpers';
import type { Server, ServerWebSocket } from 'bun';

export const PUBLIC_HOST = 'app.example';
export const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;

const FORWARDED_WS_HEADERS = ['host', 'origin', 'cookie', 'sec-fetch-site', 'sec-websocket-protocol'];
const ATTEMPTS = 20;

interface Bridge {
  backend: WebSocket;
  pending: string[];
}

export type TlsTerminatingProxy = Server<Bridge> & AsyncDisposable;

const BackendSocket = WebSocket as unknown as new (
  url: string,
  options: { headers: Record<string, string> },
) => WebSocket;

/** Plays the TLS terminator in front of `upstream`: the browser spoke https, the app hears plain http. */
function serve(upstream: string, port: number): Server<Bridge> {
  return Bun.serve<Bridge>({
    port,
    async fetch(req, server) {
      const url = new URL(req.url);
      const target = new URL(url.pathname + url.search, upstream);
      const forwarded = {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': PUBLIC_HOST,
        'x-forwarded-for': '127.0.0.1',
      };

      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        const headers = new Headers(req.headers);

        for (const [name, value] of Object.entries(forwarded)) headers.set(name, value);

        return fetch(target, { method: req.method, headers, body: req.body, redirect: 'manual' });
      }

      const headers: Record<string, string> = { ...forwarded };

      for (const name of FORWARDED_WS_HEADERS) {
        const value = req.headers.get(name);

        if (value !== null) headers[name] = value;
      }

      target.protocol = 'ws:';

      const backend = new BackendSocket(target.href, { headers });
      const pending: string[] = [];

      backend.onmessage = (event) => pending.push(String(event.data));

      const opened = await new Promise<boolean>((resolve) => {
        backend.onopen = () => resolve(true);
        backend.onclose = () => resolve(false);
      });

      if (opened && server.upgrade(req, { data: { backend, pending } })) return undefined;

      backend.close();

      return new Response(null, { status: 502 });
    },
    websocket: {
      open(ws: ServerWebSocket<Bridge>) {
        const { backend, pending } = ws.data;

        for (const message of pending) ws.send(message);

        backend.onmessage = (event) => ws.send(String(event.data));
        backend.onclose = () => ws.close();
      },
      message(ws: ServerWebSocket<Bridge>, message) {
        ws.data.backend.send(message);
      },
      close(ws: ServerWebSocket<Bridge>) {
        ws.data.backend.close();
      },
    },
  });
}

export function startTlsTerminatingProxy(upstream: string): TlsTerminatingProxy {
  let lastError: unknown;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const server = serve(upstream, randomPort());

      return Object.assign(server, {
        [Symbol.asyncDispose]: async () => {
          await server.stop(true);
        },
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}
