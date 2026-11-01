/**
 * External services for Part 2 modules. Every service is opt-in through one environment variable:
 *
 * - `ASENA_SUITE_REDIS_URL`      e.g. `redis://localhost:6379`
 * - `ASENA_SUITE_POSTGRES_URL`   e.g. `postgres://asena:asena@localhost:5432/asena_suite`
 * - `ASENA_SUITE_KAFKA_BROKERS`  comma-separated `host:port` list, e.g. `localhost:9092`
 * - `ASENA_SUITE_REQUIRE_SERVICES=1` (CI): an unset or unreachable service fails instead of skipping.
 *
 * `compose.yaml` at the suite root starts all three. Scenarios declare `services: [...]`; an unset variable registers them
 * skipped with a `[svc:<name>]` tag. A module calls `await assertReachable(name)` at top level, before it registers its
 * scenarios: outside require mode an unreachable service is unset for this process (so its scenarios skip with the tag),
 * in require mode it throws.
 */

export type ExternalService = 'redis' | 'postgres' | 'kafka';

export interface Endpoint {
  host: string;
  port: number;
}

export interface ServiceConfig {
  redisUrl?: string;
  postgresUrl?: string;
  kafkaBrokers?: string[];
  requireServices: boolean;
}

type Env = Record<string, string | undefined>;

export const SERVICE_ENV: Readonly<Record<ExternalService, string>> = Object.freeze({
  redis: 'ASENA_SUITE_REDIS_URL',
  postgres: 'ASENA_SUITE_POSTGRES_URL',
  kafka: 'ASENA_SUITE_KAFKA_BROKERS',
});

const DEFAULT_PORT: Readonly<Record<ExternalService, number>> = Object.freeze({
  redis: 6379,
  postgres: 5432,
  kafka: 9092,
});

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed === '' ? undefined : trimmed;
}

export function serviceConfig(env: Env = process.env): ServiceConfig {
  const brokers = nonEmpty(env[SERVICE_ENV.kafka])
    ?.split(',')
    .map((broker) => broker.trim())
    .filter(Boolean);

  return {
    redisUrl: nonEmpty(env[SERVICE_ENV.redis]),
    postgresUrl: nonEmpty(env[SERVICE_ENV.postgres]),
    kafkaBrokers: brokers && brokers.length > 0 ? brokers : undefined,
    requireServices: env.ASENA_SUITE_REQUIRE_SERVICES === '1',
  };
}

function urlEndpoint(value: string, fallbackPort: number): Endpoint {
  const url = new URL(value);

  return { host: url.hostname || 'localhost', port: url.port ? Number(url.port) : fallbackPort };
}

function brokerEndpoint(broker: string): Endpoint {
  const at = broker.lastIndexOf(':');

  if (at <= 0) return { host: broker, port: DEFAULT_PORT.kafka };

  return { host: broker.slice(0, at), port: Number(broker.slice(at + 1)) };
}

export function serviceEndpoints(name: ExternalService, config: ServiceConfig = serviceConfig()): Endpoint[] {
  switch (name) {
    case 'redis':
      return config.redisUrl ? [urlEndpoint(config.redisUrl, DEFAULT_PORT.redis)] : [];
    case 'postgres':
      return config.postgresUrl ? [urlEndpoint(config.postgresUrl, DEFAULT_PORT.postgres)] : [];
    case 'kafka':
      return (config.kafkaBrokers ?? []).map(brokerEndpoint);
    default:
      throw new Error(`Unknown external service '${String(name)}'`);
  }
}

export async function tcpReachable({ host, port }: Endpoint, timeoutMs = 1000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = Bun.connect({
    hostname: host,
    port,
    socket: { data() {}, error() {} },
  }).then(
    (socket) => {
      socket.end();

      return true;
    },
    () => false,
  );
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });

  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ReachableOptions {
  env?: Env;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export async function assertReachable(name: ExternalService, options: ReachableOptions = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.warn(line));
  const config = serviceConfig(env);
  const variable = SERVICE_ENV[name];
  const endpoints = serviceEndpoints(name, config);

  if (endpoints.length === 0) {
    if (config.requireServices) {
      throw new Error(`${name}: ASENA_SUITE_REQUIRE_SERVICES=1 but ${variable} is not set`);
    }

    return false;
  }

  for (const endpoint of endpoints) {
    if (await tcpReachable(endpoint, options.timeoutMs)) continue;

    const where = `${endpoint.host}:${endpoint.port}`;

    if (config.requireServices) {
      throw new Error(`${name}: ${where} from ${variable} is unreachable (ASENA_SUITE_REQUIRE_SERVICES=1)`);
    }

    delete env[variable];
    log(`[services] ${name}: ${where} from ${variable} is unreachable; its scenarios are skipped with [svc:${name}]`);

    return false;
  }

  return true;
}
