import { runTag } from '@asenajs/adapter-conformance';

let current: string | undefined;
const cleanups: (() => Promise<void> | void)[] = [];

function random6(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));

  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

export function runNamespace(): string {
  current ??= `asena_${runTag()}_${process.pid}_${random6()}`.replace(/-/g, '_');

  return current;
}

export function redisPrefix(ns: string = runNamespace()): string {
  return `${ns}:`;
}

export function kafkaTopic(ns: string, name: string): string {
  return `${ns}.${name}`;
}

export function onNamespaceCleanup(cleanup: () => Promise<void> | void): void {
  cleanups.push(cleanup);
}

export async function cleanupNamespace(): Promise<void> {
  const errors: unknown[] = [];

  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) throw new AggregateError(errors, `cleanupNamespace: ${errors.length} cleanup(s) failed`);
}

export interface PgSchema {
  readonly schema: string;
  readonly url: string;
  create(): Promise<void>;
  drop(): Promise<void>;
}

async function pgQuery(baseUrl: string, sql: string): Promise<void> {
  const { Client } = (await import('pg')).default;
  const client = new Client({ connectionString: baseUrl });

  await client.connect();

  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

export function pgSchema(baseUrl: string, ns: string = runNamespace()): PgSchema {
  const url = new URL(baseUrl);

  url.searchParams.set('options', `-c search_path=${ns}`);

  const schema: PgSchema = {
    schema: ns,
    url: url.toString(),
    async create() {
      await pgQuery(baseUrl, `CREATE SCHEMA IF NOT EXISTS "${ns}"`);
      onNamespaceCleanup(() => schema.drop());
    },
    async drop() {
      await pgQuery(baseUrl, `DROP SCHEMA IF EXISTS "${ns}" CASCADE`);
    },
  };

  return schema;
}

export async function dropRedisPrefix(redisUrl: string, prefix: string = redisPrefix()): Promise<number> {
  const { createClient } = await import('redis');
  const client = createClient({ url: redisUrl });

  await client.connect();

  try {
    let removed = 0;

    for await (const keys of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 200 })) {
      if (keys.length > 0) removed += await client.del(keys);
    }

    return removed;
  } finally {
    client.destroy();
  }
}

export function trackRedisPrefix(redisUrl: string, prefix: string = redisPrefix()): string {
  onNamespaceCleanup(async () => {
    await dropRedisPrefix(redisUrl, prefix);
  });

  return prefix;
}
