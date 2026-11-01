import { InMemoryTransport, type MicroserviceTransport } from '@asenajs/asena/microservice';
import { KafkaMicroserviceTransport } from '@asenajs/asena-kafka';
import { RedisMicroserviceTransport } from '@asenajs/asena-redis';
import { env } from './env.ts';

let memoryInstance: InMemoryTransport | undefined;

function buildRedis(serviceName: string): RedisMicroserviceTransport {
  return new RedisMicroserviceTransport(
    { url: env.REDIS_URL },
    {
      serviceName,
      streamPrefix: env.STREAM_PREFIX,
      blockMs: env.BLOCK_MS,
      drainTimeout: env.DRAIN_TIMEOUT,
      ...(env.CLAIM_IDLE_MS !== undefined && { claimIdleMs: env.CLAIM_IDLE_MS }),
      ...(env.MAX_RETRIES !== undefined && { maxRetries: env.MAX_RETRIES }),
      ...(env.REQUEST_TIMEOUT !== undefined && { requestTimeout: env.REQUEST_TIMEOUT }),
    },
  );
}

function buildKafka(serviceName: string): KafkaMicroserviceTransport {
  return new KafkaMicroserviceTransport(
    { brokers: env.KAFKA_BROKERS },
    {
      serviceName,
      topicPrefix: env.TOPIC_PREFIX,
      drainTimeout: env.DRAIN_TIMEOUT,
      ...(env.SESSION_TIMEOUT !== undefined && { sessionTimeout: env.SESSION_TIMEOUT }),
      ...(env.HEARTBEAT_INTERVAL !== undefined && { heartbeatInterval: env.HEARTBEAT_INTERVAL }),
      ...(env.RETRY_BACKOFF !== undefined && { retryBackoffMs: env.RETRY_BACKOFF }),
      ...(env.EVENT_PARTITIONS !== undefined && { eventPartitions: env.EVENT_PARTITIONS }),
      ...(env.HEALTH_CHECK_INTERVAL !== undefined && { healthCheckIntervalMs: env.HEALTH_CHECK_INTERVAL }),
      ...(env.MAX_RETRIES !== undefined && { maxRetries: env.MAX_RETRIES }),
      ...(env.REQUEST_TIMEOUT !== undefined && { requestTimeout: env.REQUEST_TIMEOUT }),
    },
  );
}

// The only transport-aware code of the app: controllers and services never import a transport. Memory mode shares one
// in-process bus across every service of the all-in-one process.
export function buildTransport(serviceName: string): MicroserviceTransport {
  if (env.TRANSPORT === 'memory') {
    memoryInstance ??= new InMemoryTransport();

    return memoryInstance;
  }

  if (env.TRANSPORT === 'kafka') return buildKafka(serviceName);

  return buildRedis(serviceName);
}

// Mixed mode boots both brokers: redis as `default` (prefix-only controllers stay unchanged) and kafka by name for the
// controllers that opt in with `@MessageController({ transport: 'kafka' })`.
export function buildTransportConfig(
  serviceName: string,
): MicroserviceTransport | Record<string, MicroserviceTransport> {
  if (env.TRANSPORT === 'mixed') return { default: buildRedis(serviceName), kafka: buildKafka(serviceName) };

  return buildTransport(serviceName);
}

export function getMemoryTransport(): InMemoryTransport | undefined {
  return memoryInstance;
}

export function resetMemoryTransport(): void {
  memoryInstance = undefined;
}
