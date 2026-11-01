import { type AsenaServer, AsenaServerFactory } from '@asenajs/asena';
import { Config } from '@asenajs/asena/decorators';
import { InMemoryTransport } from '@asenajs/asena/microservice';
import type { AsenaConfig } from '@asenajs/asena/server/config';
import { silentLogger } from '@asenajs/asena/test';
import { isPortFree, randomPort } from '@asenajs/adapter-conformance/helpers';
import { createMemoryApp } from '../../src/main.memory.ts';
import { BadPatternController } from '../../src/services/badpattern/BadPatternController.ts';
import { getMemoryTransport, resetMemoryTransport } from '../../src/shared/buildTransport.ts';

type Component = new (...args: any[]) => unknown;

export type ServiceName = 'gateway' | 'booking' | 'notification' | 'inventory' | 'audit';

export interface SendOptions {
  timeout?: number;
  headers?: Record<string, string>;
}

// Every timing budget of a bed; the scenarios contain no timing literals of their own.
export interface TransportTiming {
  /** Grace period for "arrive-and-be-ignored" negative re-assertions. */
  settleMs: number;
  rpcTimeoutMs: number;
  waitForMs: number;
  chainMs: number;
  /** clientSend timeout for the unknown-pattern probe (C07). */
  probeTimeoutMs: number;
  testMs: number;
  bootMs: number;
}

// Broker-admin surface the portable resilience scenarios use; anything beyond it stays bed-private.
export interface TransportAdmin {
  dlqCount(): Promise<number>;
  /** DLQ entries as flat records including origin_group, origin_stream, p (pattern), delivery_count. */
  dlqEntries(): Promise<Record<string, string>[]>;
  /** Erase the broker-side delivery bookkeeping of one service for events; the transport must recover (R8). */
  destroyDeliveryState(serviceName: string): Promise<void>;
  /** Sever this bed's broker connections - the "network blip" (R9). */
  severConnections(): Promise<void>;
  sweepNamespace(): Promise<void>;
}

// Transport capabilities, identical for every adapter: a false capability means the case is not registered for that
// bed (C13) or a bed-specific branch inside one shared body (C07, C08), never an adapter flag.
export interface TransportCapabilities {
  multiProcess: boolean;
  unknownPatternSend: 'immediate-send-failed' | 'timeout';
  durableEvents: boolean;
  orderedEvents: boolean;
  exactlyOnceDelivery: boolean;
}

export interface TransportTestBed {
  readonly name: 'memory' | 'redis' | 'kafka';
  readonly capabilities: TransportCapabilities;
  readonly timing: TransportTiming;
  readonly admin?: TransportAdmin;
  readonly baseUrl: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  clientSend<T = any>(pattern: string, data?: unknown, opts?: SendOptions): Promise<T>;
  clientEmit(pattern: string, data?: unknown, opts?: { headers?: Record<string, string> }): Promise<void>;
  bootBadPatternService(): Promise<{ failed: boolean; message: string }>;
}

export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = randomPort();

    if (await isPortFree(port)) return port;
  }

  throw new Error('freePort: no free port in 10000-31999 after 100 attempts');
}

// Boots a headless app on a fresh in-memory bus and reports whether start() refused it.
export async function bootFailure(controller: Component): Promise<{ failed: boolean; message: string }> {
  const transport = new InMemoryTransport();

  @Config()
  class FixtureConfig implements AsenaConfig {
    public transport() {
      return { microservice: transport };
    }
  }

  try {
    const server = await AsenaServerFactory.create({
      headless: true,
      logger: silentLogger,
      components: [FixtureConfig, controller],
    });

    await server.start();
    await server.stop();

    return { failed: false, message: 'boot unexpectedly succeeded' };
  } catch (error) {
    return { failed: true, message: (error as Error).message };
  }
}

export const MEMORY_TIMING: TransportTiming = {
  settleMs: 150,
  rpcTimeoutMs: 5000,
  waitForMs: 10_000,
  chainMs: 15_000,
  probeTimeoutMs: 800,
  testMs: 30_000,
  bootMs: 90_000,
};

export class MemoryTestBed implements TransportTestBed {
  public readonly name = 'memory' as const;

  public readonly capabilities: TransportCapabilities = {
    multiProcess: false,
    unknownPatternSend: 'immediate-send-failed',
    durableEvents: false,
    // emit() awaits the handlers in registration order
    orderedEvents: true,
    exactlyOnceDelivery: true,
  };

  public readonly timing = MEMORY_TIMING;

  private server?: AsenaServer<any>;

  private httpPort = 0;

  public get baseUrl(): string {
    return `http://127.0.0.1:${this.httpPort}`;
  }

  public async start(): Promise<void> {
    this.httpPort = await freePort();
    this.server = await createMemoryApp({ httpPort: this.httpPort });
  }

  public async stop(): Promise<void> {
    await this.server?.stop();
    this.server = undefined;
    resetMemoryTransport();
  }

  public clientSend<T = any>(pattern: string, data?: unknown, opts?: SendOptions): Promise<T> {
    return this.bus().send<T>(pattern, data, opts);
  }

  public clientEmit(pattern: string, data?: unknown, opts?: { headers?: Record<string, string> }): Promise<void> {
    return this.bus().emit(pattern, data, opts);
  }

  public bootBadPatternService(): Promise<{ failed: boolean; message: string }> {
    return bootFailure(BadPatternController);
  }

  private bus(): InMemoryTransport {
    const transport = getMemoryTransport();

    if (!transport) throw new Error('memory bed: the app has not booted its in-memory transport');

    return transport;
  }
}
