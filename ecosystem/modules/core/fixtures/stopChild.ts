import { join } from 'node:path';
import { isPortFree, randomPort, waitFor, withTimeout } from '@asenajs/adapter-conformance/helpers';

// ecosystem/: its bunfig.toml preload hands the child the selected adapter descriptor through the inherited env.
const ECOSYSTEM_DIR = join(import.meta.dir, '..', '..', '..');

export const STOP_HOOK_MARKER = 'suite-stop-fixture: the stop hook ran';

export interface StopRun {
  code: number | null;
  signal: NodeJS.Signals | number | null;
  hookRan: boolean;
}

/**
 * Runs `main.stop.ts` as its own process until it exits: stopped by SIGTERM once it answers HTTP, or by its own
 * `await server.stop()` right after the start.
 */
export async function runStopFixture(hook: 'returns' | 'throws', by: 'signal' | 'call'): Promise<StopRun> {
  let port = randomPort();

  for (let attempt = 0; attempt < 50 && !(await isPortFree(port)); attempt++) port = randomPort();

  const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'main.stop.ts')], {
    cwd: ECOSYSTEM_DIR,
    env: { ...process.env, SUITE_STOP_PORT: String(port), SUITE_STOP_HOOK: hook, SUITE_STOP_BY: by },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);

  try {
    if (by === 'signal') {
      await waitFor(
        async () => {
          if (proc.exitCode !== null || proc.signalCode !== null) return true;

          const response = await fetch(`http://127.0.0.1:${port}/stop/ping`);

          await response.text();

          return response.ok;
        },
        { label: 'the stop fixture answering HTTP', timeout: 15_000, interval: 25 },
      );
      proc.kill('SIGTERM');
    }

    await withTimeout(proc.exited, 8000, 'the stop fixture exiting on its own');
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }

  const [stdout, stderr] = await output;

  if (!stdout.includes(STOP_HOOK_MARKER) && proc.exitCode !== 0) {
    throw new Error(
      `the stop fixture exited ${proc.exitCode ?? proc.signalCode} before its hook ran:\n${stdout}${stderr}`,
    );
  }

  return { code: proc.exitCode, signal: proc.signalCode, hookRan: stdout.includes(STOP_HOOK_MARKER) };
}
