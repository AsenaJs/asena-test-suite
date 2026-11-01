// Every spawned service process is configured exclusively through these variables. The bed passes ASENA_SUITE_NS (the run
// namespace plus a per-bed suffix), so streams, topics and consumer groups of concurrent runs never meet.
const optionalNumber = (value: string | undefined): number | undefined => (value ? Number(value) : undefined);

const namespace = Bun.env.ASENA_SUITE_NS ?? 'asena_local';

export const env = {
  TRANSPORT: (Bun.env.TRANSPORT ?? 'memory') as 'memory' | 'redis' | 'kafka' | 'mixed',
  REDIS_URL: Bun.env.ASENA_SUITE_REDIS_URL ?? 'redis://localhost:6379',
  STREAM_PREFIX: streamPrefix(namespace),
  KAFKA_BROKERS: (Bun.env.ASENA_SUITE_KAFKA_BROKERS ?? 'localhost:9092').split(',').map((broker) => broker.trim()),
  TOPIC_PREFIX: topicPrefix(namespace),
  HTTP_PORT: Number(Bun.env.HTTP_PORT ?? 3000),
  HEALTH_PORT: Number(Bun.env.HEALTH_PORT ?? 9090),
  BLOCK_MS: Number(Bun.env.BLOCK_MS ?? 200),
  CLAIM_IDLE_MS: optionalNumber(Bun.env.CLAIM_IDLE_MS),
  MAX_RETRIES: optionalNumber(Bun.env.MAX_RETRIES),
  REQUEST_TIMEOUT: optionalNumber(Bun.env.REQUEST_TIMEOUT),
  SESSION_TIMEOUT: optionalNumber(Bun.env.SESSION_TIMEOUT),
  HEARTBEAT_INTERVAL: optionalNumber(Bun.env.HEARTBEAT_INTERVAL),
  RETRY_BACKOFF: optionalNumber(Bun.env.RETRY_BACKOFF),
  EVENT_PARTITIONS: optionalNumber(Bun.env.EVENT_PARTITIONS),
  HEALTH_CHECK_INTERVAL: optionalNumber(Bun.env.HEALTH_CHECK_INTERVAL),
  DRAIN_TIMEOUT: Number(Bun.env.DRAIN_TIMEOUT ?? 500),
  QUIET: Bun.env.QUIET === '1',
};

export function streamPrefix(ns: string): string {
  return `${ns}:msvc`;
}

export function topicPrefix(ns: string): string {
  return `${ns}.msvc`;
}
