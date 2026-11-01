import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { waitFor } from '@asenajs/adapter-conformance/helpers';

// ecosystem/: its bunfig.toml preload hands every child the selected adapter descriptor through the inherited env.
const ECOSYSTEM_DIR = join(import.meta.dir, '..', '..', '..', '..');

export const SRC_DIR = join(import.meta.dir, '..', '..', 'src');

const registry = new Set<SpawnedService>();

export function killAllSpawned(): void {
  for (const service of registry) {
    try {
      service.kill('SIGKILL');
    } catch {
      // already dead
    }
  }

  registry.clear();
}

process.on('exit', killAllSpawned);

// stdout/stderr go into a line buffer because scenarios key off marker lines; E2E_VERBOSE=1 tees them to the console.
export class SpawnedService {
  public readonly name: string;

  public readonly exited: Promise<number>;

  public healthPort = 0;

  private proc: Subprocess<'pipe', 'pipe', 'pipe'>;

  private lines: string[] = [];

  public constructor(name: string, entryPath: string, env: Record<string, string>) {
    this.name = name;
    // The child watches this stdin pipe (E2E_PARENT_WATCH) and exits when the runner dies without cleanup.
    this.proc = Bun.spawn([process.execPath, entryPath], {
      cwd: ECOSYSTEM_DIR,
      env: { ...process.env, QUIET: '1', E2E_PARENT_WATCH: '1', ...env },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    this.exited = this.proc.exited;
    void this.consume(this.proc.stdout);
    void this.consume(this.proc.stderr);
    registry.add(this);
  }

  public get pid(): number {
    return this.proc.pid;
  }

  public get alive(): boolean {
    return this.proc.exitCode === null && this.proc.signalCode === null;
  }

  public output(): string {
    return this.lines.join('\n');
  }

  public kill(signal: 'SIGKILL' | 'SIGTERM' = 'SIGKILL'): void {
    this.proc.kill(signal);
  }

  public async waitReady(healthPort: number, timeout = 15_000): Promise<void> {
    this.healthPort = healthPort;

    const ready = waitFor(
      async () => {
        const response = await fetch(`http://127.0.0.1:${healthPort}/healthz`, { signal: AbortSignal.timeout(1000) });

        return response.status === 200;
      },
      { timeout, interval: 50, label: `${this.name} ready on :${healthPort}` },
    );
    const exitedEarly = this.exited.then((code) => {
      throw new Error(`${this.name} exited with ${code} before ready. Output:\n${this.output()}`);
    });

    try {
      await Promise.race([ready, exitedEarly]);
    } catch (error) {
      throw new Error(`${(error as Error).message}\nOutput:\n${this.output()}`, { cause: error });
    } finally {
      exitedEarly.catch(() => {});
      ready.catch(() => {});
    }
  }

  public async waitForLine(pattern: RegExp, timeout = 10_000): Promise<string> {
    return waitFor(() => this.lines.find((line) => pattern.test(line)), {
      timeout,
      label: `${this.name}: a line matching ${pattern}`,
    });
  }

  // SIGTERM and require exit code 0: anything else means the lifecycle handler is missing or stop() failed.
  public async stopGracefully(timeout = 8000): Promise<void> {
    this.proc.kill('SIGTERM');

    let timer: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([
      this.exited,
      new Promise<number>((_, reject) => {
        timer = setTimeout(() => {
          this.kill('SIGKILL');
          reject(new Error(`${this.name}: no exit within ${timeout}ms after SIGTERM. Output:\n${this.output()}`));
        }, timeout);
      }),
    ]).finally(() => clearTimeout(timer));

    registry.delete(this);

    if (code !== 0) throw new Error(`${this.name}: graceful stop exited with ${code}. Output:\n${this.output()}`);
  }

  private async consume(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';

    const reader = stream.getReader();

    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      buffer += decoder.decode(chunk.value, { stream: true });

      let newline: number;

      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);

        buffer = buffer.slice(newline + 1);
        this.lines.push(line);

        if (Bun.env.E2E_VERBOSE === '1') console.log(`  [${this.name}] ${line}`);
      }
    }

    if (buffer) this.lines.push(buffer);
  }
}
