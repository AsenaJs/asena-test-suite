import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Subprocess } from 'bun';
import {
  type DevtoolsAgentMessage,
  type DevtoolsCommand,
  type DevtoolsCommandResult,
  type DevtoolsHello,
  type DevtoolsMetrics,
  type DevtoolsRequestRecord,
  type DevtoolsServerRef,
  type DevtoolsSnapshot,
  hostMessage,
  isDevtoolsAgentMessage,
} from '@asenajs/asena/devtools';
import { isPortFree, randomPort, waitFor } from '@asenajs/adapter-conformance/helpers';

// The child runs from ecosystem/: its bunfig.toml preload selects the adapter from the inherited env, and Bun takes
// the decorator settings from the cwd's tsconfig.
const ECOSYSTEM_DIR = join(import.meta.dir, '..', '..', '..');
const FIXTURES_DIR = join(import.meta.dir, '..', 'fixtures');
const ATTEMPTS = 3;

export type FixtureEntry = 'main' | 'main.explicit' | 'main.drafts' | 'main.warnings' | 'main.pair';

export type ServerSnapshot = DevtoolsSnapshot & DevtoolsServerRef;
export type ServerRecord = DevtoolsRequestRecord & DevtoolsServerRef;

export interface SpawnOptions {
  env?: Record<string, string>;
  /** What tells the child is up: the agent's hello, or the app answering HTTP when no agent is expected. */
  ready?: 'hello' | 'http';
}

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | number | null;
  afterMs: number;
}

const live = new Set<AgentChild>();

process.on('exit', () => {
  for (const child of live) child.kill();
});

/** The version in the manifest of the core the child resolves, which the agent reports as `coreVersion`. */
export function installedCoreVersion(): string {
  const entry = Bun.resolveSync('@asenajs/asena', ECOSYSTEM_DIR);

  return (JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')) as { version: string }).version;
}

async function freePort(taken?: number): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = randomPort();

    if (port !== taken && (await isPortFree(port))) return port;
  }

  throw new Error('no free port in 10000-31999');
}

/**
 * The wrapper `asena console` writes: the build list, then the prelude that installs the agent as the
 * `Symbol.for('asena.devtools')` hook, then the entry. Every import is absolute, so this copy of core is the one
 * the app and the adapter load.
 */
function writeWrapper(dir: string, entry: FixtureEntry): string {
  const agentPath = Bun.resolveSync('@asenajs/asena/devtools', ECOSYSTEM_DIR);

  writeFileSync(
    join(dir, 'asena.components.js'),
    `import { allComponents } from '${join(FIXTURES_DIR, 'app.ts')}';\n\n` +
      "globalThis[Symbol.for('asena.buildComponents')] = [...allComponents];\n",
  );
  writeFileSync(
    join(dir, 'asena.devtools.js'),
    `import { attachDevtoolsAgent } from '${agentPath}';\n\n` +
      "globalThis[Symbol.for('asena.devtools')] = attachDevtoolsAgent;\n",
  );

  const wrapper = join(dir, 'index.asena.js');

  writeFileSync(
    wrapper,
    "import './asena.components.js';\nimport './asena.devtools.js';\n" +
      `import '${join(FIXTURES_DIR, `${entry}.ts`)}';\n`,
  );

  return wrapper;
}

/** A fixture app spawned the way `asena console` spawns it, with the agent's IPC messages collected in order. */
export class AgentChild implements AsyncDisposable {
  public readonly messages: DevtoolsAgentMessage[] = [];

  private readonly lines: string[] = [];

  private readonly proc: Subprocess<'ignore', 'pipe', 'pipe'>;

  private commands = 0;

  private readonly claimed = new Set<string>();

  private stopping?: Promise<ChildExit>;

  private constructor(
    public readonly port: number,
    /** Where the second server of the `main.pair` entry listens. */
    public readonly secondPort: number,
    private readonly dir: string,
    wrapper: string,
    env: Record<string, string> = {},
  ) {
    this.proc = Bun.spawn([process.execPath, `--tsconfig-override=${join(ECOSYSTEM_DIR, 'tsconfig.json')}`, wrapper], {
      cwd: ECOSYSTEM_DIR,
      env: {
        ...process.env,
        DEVTOOLS_FIXTURE_PORT: String(port),
        DEVTOOLS_FIXTURE_SECOND_PORT: String(secondPort),
        DEVTOOLS_FIXTURE_PAGE_SIZE: undefined,
        ...env,
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      ipc: (message) => {
        if (isDevtoolsAgentMessage(message)) this.messages.push(message);
      },
    });
    live.add(this);
    void this.consume(this.proc.stdout);
    void this.consume(this.proc.stderr);
  }

  public static async spawn(entry: FixtureEntry, options: SpawnOptions = {}): Promise<AgentChild> {
    let last: AgentChild | undefined;

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const dir = mkdtempSync(join(tmpdir(), 'asena-suite-devtools-'));
      const port = await freePort();
      const child = new AgentChild(port, await freePort(port), dir, writeWrapper(dir, entry), options.env);

      try {
        await (options.ready === 'http' ? child.serving() : child.hello());

        return child;
      } catch (error) {
        await child.stop();
        last = child;

        if (!/EADDRINUSE|address already in use|port \d+ in use/i.test(child.output())) throw error;
      }
    }

    throw new Error(`fixture ${entry} never bound a port after ${ATTEMPTS} attempts:\n${last?.output() ?? ''}`);
  }

  public get pid(): number {
    return this.proc.pid;
  }

  public output(): string {
    return this.lines.join('\n');
  }

  public kill(): void {
    if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill('SIGKILL');
  }

  public async hello(): Promise<DevtoolsHello> {
    return (await this.first('hello')).payload as DevtoolsHello;
  }

  public async snapshot(): Promise<ServerSnapshot> {
    return (await this.first('snapshot')).payload as ServerSnapshot;
  }

  /** The first `count` hellos, one per server, in the order the servers attached. */
  public async hellos(count: number): Promise<DevtoolsHello[]> {
    return waitFor(
      () => {
        const found = this.messages.flatMap((message) => (message.type === 'hello' ? [message.payload] : []));

        return found.length >= count ? found.slice(0, count) : undefined;
      },
      { label: `${count} hellos from the agent`, timeout: 15_000 },
    );
  }

  public snapshots(): ServerSnapshot[] {
    return this.messages.flatMap((message) => (message.type === 'snapshot' ? [message.payload] : []));
  }

  public metrics(): DevtoolsMetrics[] {
    return this.messages.flatMap((message) => (message.type === 'metrics' ? [message.payload] : []));
  }

  /** Records the agent sent, in arrival order. */
  public requests(): ServerRecord[] {
    return this.messages.flatMap((message) => (message.type === 'request' ? [message.payload] : []));
  }

  /**
   * Sends one request and returns its response together with the first record for it that no earlier call took,
   * so concurrent calls for different paths each get their own record.
   */
  public async fetch(
    method: string,
    path: string,
    body?: unknown,
    port = this.port,
  ): Promise<{ status: number; body: string; record: ServerRecord }> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const record = await waitFor(
      () =>
        this.requests().find(
          (candidate) => candidate.method === method && candidate.path === path && !this.claimed.has(candidate.id),
        ),
      { label: `request record for ${method} ${path}`, timeout: 5000 },
    );

    this.claimed.add(record.id);

    return { status: response.status, body: text, record };
  }

  /** One request with no record awaited, for an app whose agent is not expected to report. */
  public async status(method: string, path: string): Promise<number> {
    const response = await fetch(`http://127.0.0.1:${this.port}${path}`, { method });

    await response.text();

    return response.status;
  }

  /** Sends a command without waiting for its result; with `serverId`, addressed to that server. */
  public post(command: DevtoolsCommand, serverId?: string): string {
    const id = `suite-${++this.commands}`;

    this.proc.send(hostMessage('command', { id, ...(serverId === undefined ? {} : { serverId }), ...command }));

    return id;
  }

  public async command(command: DevtoolsCommand, serverId?: string): Promise<DevtoolsCommandResult> {
    const id = this.post(command, serverId);

    let result: DevtoolsCommandResult | undefined;

    await waitFor(
      () => {
        for (const message of this.messages) {
          if (message.type === 'commandResult' && message.payload.id === id) result = message.payload;
        }

        return result !== undefined;
      },
      { label: `commandResult ${id}`, timeout: 5000 },
    );

    return result!;
  }

  /** SIGTERM, then SIGKILL after 3 s, the way the console host stops a child. */
  public stop(): Promise<ChildExit> {
    const stopping = this.stopping ?? this.terminate();

    this.stopping = stopping;

    return stopping;
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }

  private async terminate(): Promise<ChildExit> {
    const sent = performance.now();

    if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill('SIGTERM');

    const fallback = setTimeout(() => this.kill(), 3000);

    try {
      await this.proc.exited;
    } finally {
      clearTimeout(fallback);
      live.delete(this);
      rmSync(this.dir, { recursive: true, force: true });
    }

    return { code: this.proc.exitCode, signal: this.proc.signalCode, afterMs: performance.now() - sent };
  }

  private async serving(): Promise<void> {
    const found = await waitFor(
      async () => {
        if (this.proc.exitCode !== null || this.proc.signalCode !== null) return 'exited';

        return fetch(`http://127.0.0.1:${this.port}/status`).then(
          async (response) => {
            await response.text();

            return 'up';
          },
          () => undefined,
        );
      },
      { label: 'the fixture answering HTTP', timeout: 15_000, interval: 25 },
    ).catch((error: unknown) => {
      throw new Error(`${(error as Error).message}\n--- fixture output ---\n${this.output()}`, { cause: error });
    });

    if (found === 'exited') {
      throw new Error(
        `fixture exited (${this.proc.exitCode ?? this.proc.signalCode}) before serving:\n${this.output()}`,
      );
    }
  }

  private async first(type: DevtoolsAgentMessage['type']): Promise<DevtoolsAgentMessage> {
    const found = await waitFor(
      () => {
        const message = this.messages.find((candidate) => candidate.type === type);

        if (message) return message;

        return this.proc.exitCode !== null || this.proc.signalCode !== null ? 'exited' : undefined;
      },
      { label: `${type} from the agent`, timeout: 15_000 },
    ).catch((error: unknown) => {
      throw new Error(`${(error as Error).message}\n--- fixture output ---\n${this.output()}`, { cause: error });
    });

    if (found === 'exited') {
      throw new Error(
        `fixture exited (${this.proc.exitCode ?? this.proc.signalCode}) before ${type}:\n${this.output()}`,
      );
    }

    return found;
  }

  private async consume(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let pending = '';

    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      pending += decoder.decode(chunk.value, { stream: true });

      const parts = pending.split('\n');

      pending = parts.pop() ?? '';
      this.lines.push(...parts);
    }

    if (pending) this.lines.push(pending);
  }
}
