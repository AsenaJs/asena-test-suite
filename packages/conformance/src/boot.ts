import type { AsenaAdapter } from '@asenajs/asena/adapter';
import type { ServerLogger } from '@asenajs/asena/logger';
import { createTestApp, type DispatchMode, silentLogger, type TestApp } from '@asenajs/asena/test';
import { getDescriptor, isOn } from './load.ts';

type Component = Parameters<typeof createTestApp>[0]['components'][number];

export interface BootOptions {
  components: Component[];
  overrides?: Record<string, object>;
  logger?: ServerLogger;
  dispatch?: DispatchMode;
  port?: number;
  /** A pre-built adapter (e.g. wrapped by `recordCalls`); built by the caller from `getDescriptor().createAdapter`. */
  adapter?: AsenaAdapter<any, any>;
}

const PORT_FLOOR = 10000;
const PORT_SPAN = 22000;
const ATTEMPTS = 5;

function candidatePort(): number {
  return PORT_FLOOR + Math.floor(Math.random() * PORT_SPAN);
}

function portFree(port: number): boolean {
  try {
    const probe = Bun.listen({ hostname: '0.0.0.0', port, socket: { data() {} } });

    probe.stop(true);

    return true;
  } catch {
    return false;
  }
}

function pickPort(): number {
  for (let i = 0; i < 50; i++) {
    const port = candidatePort();

    if (portFree(port)) return port;
  }

  return candidatePort();
}

function addressInUse(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    const { code, message } = current as { code?: unknown; message?: unknown };

    if (code === 'EADDRINUSE') return true;
    if (typeof message === 'string' && /EADDRINUSE|address already in use|port \d+ in use/i.test(message)) return true;

    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

export async function bootApp(options: BootOptions): Promise<TestApp> {
  const dispatch = options.dispatch ?? 'server';

  if (dispatch === 'socket' && !isOn('optional.unixSocket')) {
    throw new Error(
      "bootApp: dispatch 'socket' needs the unix start option; declare requires: ['optional.unixSocket'] on the scenario",
    );
  }

  const logger = options.logger ?? silentLogger;
  const boot = (adapter: AsenaAdapter<any, any>, port: number | undefined) =>
    createTestApp({
      adapter,
      components: options.components,
      overrides: options.overrides,
      logger,
      dispatch,
      port,
    });

  if (dispatch === 'socket') {
    return boot(options.adapter ?? getDescriptor().createAdapter({ logger }), undefined);
  }

  if (options.adapter || options.port !== undefined) {
    return boot(options.adapter ?? getDescriptor().createAdapter({ logger }), options.port ?? pickPort());
  }

  let lastError: unknown;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      return await boot(getDescriptor().createAdapter({ logger }), pickPort());
    } catch (error) {
      if (!addressInUse(error)) throw error;
      lastError = error;
    }
  }

  throw lastError;
}
