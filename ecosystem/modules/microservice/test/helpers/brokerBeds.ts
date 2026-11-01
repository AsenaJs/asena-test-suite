import { join } from 'node:path';
import { KafkaMicroserviceTransport } from '@asenajs/asena-kafka';
import { RedisMicroserviceTransport } from '@asenajs/asena-redis';
import { runNamespace } from '../../../../src/namespace.ts';
import { streamPrefix, topicPrefix } from '../../src/shared/env.ts';
import { KafkaAdmin } from './kafkaAdmin.ts';
import { RedisAdmin } from './redisAdmin.ts';
import { SpawnedService, SRC_DIR } from './spawn.ts';
import { TcpProxy } from './tcpProxy.ts';
import {
  freePort,
  type SendOptions,
  type ServiceName,
  type TransportCapabilities,
  type TransportTestBed,
  type TransportTiming,
} from './testbed.ts';

export type MixedServiceName = ServiceName | 'bridge';

interface Headers {
  headers?: Record<string, string>;
}

const DEFAULT_SERVICES: ServiceName[] = ['gateway', 'booking', 'notification', 'inventory'];

export const REDIS_TIMING: TransportTiming = {
  settleMs: 400,
  rpcTimeoutMs: 5000,
  waitForMs: 10_000,
  chainMs: 15_000,
  probeTimeoutMs: 800,
  testMs: 30_000,
  bootMs: 90_000,
};

// Group joins, rebalances and topic metadata dominate Kafka; SESSION_TIMEOUT 3 s needs the broker's
// group.min.session.timeout.ms lowered to 1000 (compose.yaml does).
export const KAFKA_TIMING: TransportTiming = {
  settleMs: 800,
  rpcTimeoutMs: 15_000,
  waitForMs: 30_000,
  chainMs: 45_000,
  probeTimeoutMs: 3000,
  testMs: 120_000,
  bootMs: 180_000,
};

const KAFKA_SERVICE_ENV = {
  SESSION_TIMEOUT: '3000',
  HEARTBEAT_INTERVAL: '800',
  RETRY_BACKOFF: '400',
  HEALTH_CHECK_INTERVAL: '1000',
  DRAIN_TIMEOUT: '500',
};

const KAFKA_CLIENT_OPTIONS = {
  sessionTimeout: 3000,
  heartbeatInterval: 800,
  healthCheckIntervalMs: 1000,
  drainTimeout: 500,
};

function redisUrl(): string {
  return process.env.ASENA_SUITE_REDIS_URL ?? '';
}

function kafkaBrokers(): string[] {
  return (process.env.ASENA_SUITE_KAFKA_BROKERS ?? '')
    .split(',')
    .map((broker) => broker.trim())
    .filter(Boolean);
}

function bedNamespace(): string {
  return `${runNamespace()}_${crypto.randomUUID().slice(0, 8)}`;
}

// Spawns each service as its own process (cwd ecosystem/, env inherited) inside this bed's namespace.
abstract class SpawningBed<Name extends string> {
  public readonly ns = bedNamespace();

  protected httpPort = 0;

  protected serviceEnv: Record<string, string> = {};

  private replicas = new Map<Name, SpawnedService[]>();

  public constructor(
    private readonly transportEnv: Record<string, string>,
    private readonly envOverrides: Record<string, string>,
    private readonly readyTimeout: number,
  ) {}

  public get baseUrl(): string {
    return `http://127.0.0.1:${this.httpPort}`;
  }

  public async spawnReplica(name: Name, extraEnv: Record<string, string> = {}): Promise<SpawnedService> {
    const healthPort = await freePort();
    const env: Record<string, string> = {
      ...this.transportEnv,
      ...this.serviceEnv,
      ASENA_SUITE_NS: this.ns,
      HEALTH_PORT: String(healthPort),
      ...this.envOverrides,
      ...extraEnv,
    };

    if (name === 'gateway') {
      this.httpPort ||= await freePort();
      env.HTTP_PORT = String(this.httpPort);
    }

    const list = this.replicas.get(name) ?? [];
    const proc = new SpawnedService(`${name}#${list.length + 1}`, join(SRC_DIR, 'services', name, 'main.ts'), env);

    this.replicas.set(name, [...list, proc]);
    await proc.waitReady(healthPort, this.readyTimeout);

    return proc;
  }

  public get(name: Name): SpawnedService {
    const live = (this.replicas.get(name) ?? []).find((proc) => proc.alive);

    if (!live) throw new Error(`No live replica of ${name}`);

    return live;
  }

  public replicasOf(name: Name): SpawnedService[] {
    return [...(this.replicas.get(name) ?? [])];
  }

  public healthPortOf(proc: SpawnedService): number {
    return proc.healthPort;
  }

  public bootBadPatternService(): Promise<{ failed: boolean; message: string }> {
    return this.bootFailing('badpattern');
  }

  public bootDuplicatePatternService(): Promise<{ failed: boolean; message: string }> {
    return this.bootFailing('duppattern');
  }

  protected async stopReplicas(): Promise<void> {
    for (const proc of [...this.replicas.values()].flat()) {
      if (proc.alive) await proc.stopGracefully(3000).catch(() => {});
    }

    this.replicas.clear();
  }

  private async bootFailing(service: string): Promise<{ failed: boolean; message: string }> {
    const proc = new SpawnedService(service, join(SRC_DIR, 'services', service, 'main.ts'), {
      ...this.transportEnv,
      ASENA_SUITE_NS: this.ns,
      HEALTH_PORT: String(await freePort()),
    });
    const code = await proc.exited;

    return { failed: code !== 0, message: proc.output() };
  }
}

export class RedisTestBed extends SpawningBed<ServiceName> implements TransportTestBed {
  public readonly name = 'redis' as const;

  public readonly capabilities: TransportCapabilities = {
    multiProcess: true,
    unknownPatternSend: 'timeout',
    durableEvents: true,
    // maxInFlight dispatches concurrently and the sweep redelivers out of band
    orderedEvents: false,
    exactlyOnceDelivery: false,
  };

  public readonly timing = REDIS_TIMING;

  public readonly streamPrefix = streamPrefix(this.ns);

  public readonly admin = new RedisAdmin(redisUrl(), this.streamPrefix, () => this.severServices());

  private client?: RedisMicroserviceTransport;

  private proxy?: TcpProxy;

  public constructor(
    envOverrides: Record<string, string> = {},
    private readonly options: { proxy?: boolean } = {},
  ) {
    super({ TRANSPORT: 'redis', BLOCK_MS: '200', DRAIN_TIMEOUT: '500' }, envOverrides, 15_000);
  }

  public async start(services: ServiceName[] = DEFAULT_SERVICES): Promise<void> {
    if (this.options.proxy) {
      const target = new URL(redisUrl());

      this.proxy = TcpProxy.start(target.hostname, Number(target.port || 6379));
      target.hostname = '127.0.0.1';
      target.port = String(this.proxy.port);
      this.serviceEnv = { ASENA_SUITE_REDIS_URL: target.toString() };
    }

    await Promise.all(services.map((name) => this.spawnReplica(name)));
    this.client = new RedisMicroserviceTransport(
      { url: redisUrl() },
      { serviceName: 'test-client', streamPrefix: this.streamPrefix, blockMs: 200 },
    );
    await this.client.init();
  }

  public async stop(): Promise<void> {
    await this.client?.destroy({ drainTimeout: 500 }).catch(() => {});
    this.client = undefined;
    await this.stopReplicas();
    this.proxy?.stop();
    await this.admin.sweepNamespace().catch(() => {});
    await this.admin.disconnect();
  }

  public clientSend<T = any>(pattern: string, data?: unknown, opts?: SendOptions): Promise<T> {
    return requireClient(this.client).send<T>(pattern, data, opts);
  }

  public clientEmit(pattern: string, data?: unknown, opts?: Headers): Promise<void> {
    return requireClient(this.client).emit(pattern, data, opts);
  }

  private severServices(): void {
    if (!this.proxy) throw new Error('severConnections needs a bed created with { proxy: true }');

    this.proxy.severAll();
  }
}

export class KafkaTestBed extends SpawningBed<ServiceName> implements TransportTestBed {
  public readonly name = 'kafka' as const;

  public readonly capabilities: TransportCapabilities = {
    multiProcess: true,
    // request topics are pre-created, so an unknown pattern lands where nobody consumes
    unknownPatternSend: 'timeout',
    durableEvents: true,
    // multi-partition event topic, keyless round-robin, partitions consumed concurrently
    orderedEvents: false,
    exactlyOnceDelivery: false,
  };

  public readonly timing = KAFKA_TIMING;

  public readonly topicPrefix = topicPrefix(this.ns);

  public readonly admin = new KafkaAdmin(kafkaBrokers(), this.topicPrefix);

  private client?: KafkaMicroserviceTransport;

  public constructor(envOverrides: Record<string, string> = {}) {
    super({ TRANSPORT: 'kafka', ...KAFKA_SERVICE_ENV }, envOverrides, 60_000);
  }

  public async start(services: ServiceName[] = DEFAULT_SERVICES): Promise<void> {
    await Promise.all(services.map((name) => this.spawnReplica(name)));
    this.client = new KafkaMicroserviceTransport(
      { brokers: kafkaBrokers() },
      { serviceName: 'test-client', topicPrefix: this.topicPrefix, ...KAFKA_CLIENT_OPTIONS },
    );
    await this.client.init();
  }

  public async stop(): Promise<void> {
    await this.client?.destroy({ drainTimeout: 500 }).catch(() => {});
    this.client = undefined;
    await this.stopReplicas();
    await this.admin.sweepNamespace().catch(() => {});
    await this.admin.disconnect();
  }

  public clientSend<T = any>(pattern: string, data?: unknown, opts?: SendOptions): Promise<T> {
    return requireClient(this.client).send<T>(pattern, data, opts);
  }

  public clientEmit(pattern: string, data?: unknown, opts?: Headers): Promise<void> {
    return requireClient(this.client).emit(pattern, data, opts);
  }
}

// Every service boots both brokers (redis as `default`, kafka by name). No gateway: the mixed scenarios need no HTTP.
export class MixedTestBed extends SpawningBed<MixedServiceName> {
  public readonly timing = KAFKA_TIMING;

  public readonly streamPrefix = streamPrefix(this.ns);

  public readonly topicPrefix = topicPrefix(this.ns);

  public readonly redisAdmin = new RedisAdmin(redisUrl(), this.streamPrefix, () => {
    throw new Error('the mixed bed does not sever Redis connections');
  });

  public readonly kafkaAdmin = new KafkaAdmin(kafkaBrokers(), this.topicPrefix);

  private redisClient?: RedisMicroserviceTransport;

  private kafkaClient?: KafkaMicroserviceTransport;

  public constructor(envOverrides: Record<string, string> = {}) {
    super({ TRANSPORT: 'mixed', BLOCK_MS: '200', ...KAFKA_SERVICE_ENV }, envOverrides, 60_000);
  }

  public async start(services: MixedServiceName[] = ['bridge', 'notification']): Promise<void> {
    await Promise.all(services.map((name) => this.spawnReplica(name)));
    this.redisClient = new RedisMicroserviceTransport(
      { url: redisUrl() },
      { serviceName: 'test-client', streamPrefix: this.streamPrefix, blockMs: 200 },
    );
    await this.redisClient.init();
    this.kafkaClient = new KafkaMicroserviceTransport(
      { brokers: kafkaBrokers() },
      { serviceName: 'test-client', topicPrefix: this.topicPrefix, ...KAFKA_CLIENT_OPTIONS },
    );
    await this.kafkaClient.init();
  }

  public async stop(): Promise<void> {
    await this.redisClient?.destroy({ drainTimeout: 500 }).catch(() => {});
    this.redisClient = undefined;
    await this.kafkaClient?.destroy({ drainTimeout: 500 }).catch(() => {});
    this.kafkaClient = undefined;
    await this.stopReplicas();
    await this.redisAdmin.sweepNamespace().catch(() => {});
    await this.redisAdmin.disconnect();
    await this.kafkaAdmin.sweepNamespace().catch(() => {});
    await this.kafkaAdmin.disconnect();
  }

  public redisSend<T = any>(pattern: string, data?: unknown, opts?: SendOptions): Promise<T> {
    return requireClient(this.redisClient).send<T>(pattern, data, opts);
  }

  public redisEmit(pattern: string, data?: unknown, opts?: Headers): Promise<void> {
    return requireClient(this.redisClient).emit(pattern, data, opts);
  }

  public kafkaSend<T = any>(pattern: string, data?: unknown, opts?: SendOptions): Promise<T> {
    return requireClient(this.kafkaClient).send<T>(pattern, data, opts);
  }

  public kafkaEmit(pattern: string, data?: unknown, opts?: Headers): Promise<void> {
    return requireClient(this.kafkaClient).emit(pattern, data, opts);
  }
}

function requireClient<T>(client: T | undefined): T {
  if (!client) throw new Error('the bed has not started its client transport');

  return client;
}
