import type { Socket, TCPSocketListener } from 'bun';

interface Side {
  socket?: Socket<Pair>;
  pending: Uint8Array[];
}

interface Pair {
  client: Side;
  upstream: Side;
}

function flush(side: Side): void {
  while (side.socket && side.pending.length > 0) {
    const chunk = side.pending[0];
    const written = side.socket.write(chunk);

    if (written < chunk.length) {
      side.pending[0] = chunk.subarray(Math.max(written, 0));

      return;
    }

    side.pending.shift();
  }
}

function send(side: Side, data: Uint8Array): void {
  side.pending.push(data.slice());
  flush(side);
}

// A bed-private TCP hop in front of a broker that clients dial directly (Redis). Severing it closes exactly the
// connections of the processes that were pointed at it, so a concurrent run on the same broker is not disturbed.
export class TcpProxy {
  private constructor(
    private readonly listener: TCPSocketListener<Pair>,
    private readonly pairs: Set<Pair>,
  ) {}

  public static start(targetHost: string, targetPort: number): TcpProxy {
    const pairs = new Set<Pair>();
    const closePair = (pair: Pair) => {
      pairs.delete(pair);
      pair.client.socket?.end();
      pair.upstream.socket?.end();
    };
    const listener = Bun.listen<Pair>({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open(client) {
          const pair: Pair = { client: { socket: client, pending: [] }, upstream: { pending: [] } };

          client.data = pair;
          pairs.add(pair);
          Bun.connect<Pair>({
            hostname: targetHost,
            port: targetPort,
            data: pair,
            socket: {
              open(upstream) {
                pair.upstream.socket = upstream;
                flush(pair.upstream);
              },
              data(_upstream, data) {
                send(pair.client, data);
              },
              drain() {
                flush(pair.upstream);
              },
              close() {
                closePair(pair);
              },
              error() {
                closePair(pair);
              },
            },
          }).catch(() => closePair(pair));
        },
        data(client, data) {
          send(client.data.upstream, data);
        },
        drain(client) {
          flush(client.data.client);
        },
        close(client) {
          closePair(client.data);
        },
        error(client) {
          closePair(client.data);
        },
      },
    });

    return new TcpProxy(listener, pairs);
  }

  public get port(): number {
    return this.listener.port;
  }

  public severAll(): void {
    for (const pair of [...this.pairs]) {
      this.pairs.delete(pair);
      pair.client.socket?.terminate();
      pair.upstream.socket?.terminate();
    }
  }

  public stop(): void {
    this.severAll();
    this.listener.stop(true);
  }
}
