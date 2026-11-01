import { BunRedisAdapter } from '@asenajs/asena-redis';
import type { TransportAdmin } from './testbed.ts';

// Raw Redis access for setup and assertions the transport does not expose: the portable TransportAdmin surface plus
// redis-private helpers. Every key it touches is under this bed's stream prefix.
export class RedisAdmin implements TransportAdmin {
  private adapter?: BunRedisAdapter;

  public constructor(
    private readonly url: string,
    private readonly streamPrefix: string,
    private readonly sever: () => void,
  ) {}

  public dlqCount(): Promise<number> {
    return this.xlen(`${this.streamPrefix}:dlq`);
  }

  public async dlqEntries(): Promise<Record<string, string>[]> {
    return (await this.xrange(`${this.streamPrefix}:dlq`)).map(entryFields);
  }

  public async destroyDeliveryState(serviceName: string): Promise<void> {
    await this.command('XGROUP', ['DESTROY', `${this.streamPrefix}:evt`, serviceName]);
  }

  // Not `CLIENT KILL`: that hits every client of a shared Redis (and behind a container port proxy the client
  // addresses are the proxy's). The bed's own TCP hop is cut instead.
  public severConnections(): Promise<void> {
    this.sever();

    return Promise.resolve();
  }

  public async sweepNamespace(): Promise<void> {
    const keys: unknown = await this.command('KEYS', [`${this.streamPrefix}*`]);

    if (Array.isArray(keys) && keys.length) await this.command('DEL', keys.map(String));
  }

  public async xlen(key: string): Promise<number> {
    return Number(await this.command('XLEN', [key]).catch(() => 0));
  }

  public async xrange(key: string): Promise<unknown[]> {
    const reply: unknown = await this.command('XRANGE', [key, '-', '+']);

    return Array.isArray(reply) ? reply : [];
  }

  public async xpendingCount(stream: string, group: string): Promise<number> {
    const reply: unknown = await this.command('XPENDING', [stream, group]).catch(() => null);

    return Array.isArray(reply) ? Number(reply[0] ?? 0) : 0;
  }

  public async disconnect(): Promise<void> {
    await this.adapter?.disconnect().catch(() => {});
    this.adapter = undefined;
  }

  private async command(cmd: string, args: string[]): Promise<any> {
    if (!this.adapter) {
      this.adapter = new BunRedisAdapter(this.url);
      await this.adapter.connect();
    }

    return this.adapter.send(cmd, args);
  }
}

function entryFields(entry: unknown): Record<string, string> {
  const raw: unknown = Array.isArray(entry) ? entry[1] : undefined;
  const out: Record<string, string> = {};

  if (raw instanceof Map) {
    for (const [key, value] of raw) out[String(key)] = String(value);
  } else if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) out[String(raw[i])] = String(raw[i + 1]);
  }

  return out;
}
