import { expect } from 'bun:test';
import { join } from 'node:path';
import { scenario } from '@asenajs/adapter-conformance';
import { RESULT_MARKER, type Mode, type RunResult } from './harness/report.ts';

const ECOSYSTEM_DIR = join(import.meta.dir, '..', '..');
const CHILD = join(import.meta.dir, 'child.ts');
const TIMEOUT = 180_000;
const runs = new Map<Mode, Promise<{ exitCode: number; result: RunResult }>>();

async function spawnMode(mode: Mode): Promise<{ exitCode: number; result: RunResult }> {
  const child = Bun.spawn([process.execPath, CHILD, `--mode=${mode}`], {
    cwd: ECOSYSTEM_DIR,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout.split('\n').find((entry) => entry.startsWith(RESULT_MARKER));

  if (!line) throw new Error(`no result line from mode=${mode} (exit ${exitCode})\n${stdout}\n${stderr}`);

  return { exitCode, result: JSON.parse(line.slice(RESULT_MARKER.length)) as RunResult };
}

function run(mode: Mode): Promise<{ exitCode: number; result: RunResult }> {
  let pending = runs.get(mode);

  if (!pending) {
    pending = spawnMode(mode);
    runs.set(mode, pending);
  }

  return pending;
}

const opts = { services: ['slow' as const], timeout: TIMEOUT };

scenario(
  'P2.otel-leak-sim.001',
  'the frozen leaky control is detected as a leak (harness sensitivity)',
  async () => {
    const leaky = await run('leaky');

    expect(leaky.result.verdict).toBe('LEAK_DETECTED');
    expect(leaky.exitCode).toBe(0);
  },
  opts,
);

scenario(
  'P2.otel-leak-sim.002',
  'the released middleware plateaus with at most 64 duration data points',
  async () => {
    const fixed = await run('fixed');

    expect(fixed.result.verdict).toBe('PLATEAU');
    expect(fixed.result.deltas.finalDurationDataPoints).toBeLessThanOrEqual(64);
    expect(fixed.exitCode).toBe(0);
  },
  opts,
);

scenario(
  'P2.otel-leak-sim.003',
  'fixed growth in the last wave is at most 1 % of the leaky growth under the same traffic',
  async () => {
    const leaky = await run('leaky');
    const fixed = await run('fixed');
    const leakyGrowth = leaky.result.deltas.durationGrowthLastWave;

    expect(leakyGrowth).toBeGreaterThan(100);
    expect(fixed.result.deltas.durationGrowthLastWave).toBeLessThanOrEqual(0.01 * leakyGrowth);
  },
  opts,
);
