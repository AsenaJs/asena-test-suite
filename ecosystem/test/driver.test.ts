import { expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scenario } from '@asenajs/adapter-conformance';

const ecosystemDir = join(import.meta.dir, '..');
const fixtures = join(import.meta.dir, 'fixtures');

function driver(...args: string[]): { exitCode: number; output: string } {
  const child = Bun.spawnSync([process.execPath, join(ecosystemDir, 'run.ts'), '--modules-dir', fixtures, ...args], {
    cwd: join(ecosystemDir, '..'),
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return { exitCode: child.exitCode ?? -1, output: `${child.stdout.toString()}${child.stderr.toString()}` };
}

function runLabels(output: string): string[] {
  return [...output.matchAll(/^\[p2\] ([\w-]+): bun test /gm)].map((match) => match[1]);
}

scenario(
  'P2.services.101',
  'the driver runs the prelude, one process per marked file, and merges junit into --out',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'asena-p2-driver-'));
    const out = join(dir, 'merged.xml');

    try {
      const { exitCode, output } = driver('--reporter=junit', '--out', out);
      const pids = [...output.matchAll(/^\[fixture\] ([\w-]+) pid=(\d+) createAdapter=function$/gm)].map(
        (match) => [match[1], match[2]] as const,
      );
      const xml = readFileSync(out, 'utf8');

      expect(exitCode).toBe(0);
      expect(runLabels(output)).toEqual(['prelude', 'alpha', 'beta-one', 'beta-two']);
      expect(pids.map(([name]) => name)).toEqual(['alpha', 'beta-one', 'beta-two']);
      expect(new Set(pids.map(([, pid]) => pid)).size).toBe(3);
      expect(xml.match(/<testsuites\b/g)).toHaveLength(1);
      expect(xml).toContain('[P2.resolution.001]');
      expect(xml).toContain('alpha reports its process');
      expect(xml).toContain('beta one reports its process');
      expect(xml).toContain('beta two reports its process');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

scenario(
  'P2.services.102',
  '--module restricts the run to the named modules after the prelude',
  () => {
    expect(runLabels(driver('--module', 'alpha').output)).toEqual(['prelude', 'alpha']);
    expect(runLabels(driver('--module', 'beta', '--module', 'alpha').output)).toEqual([
      'prelude',
      'alpha',
      'beta-one',
      'beta-two',
    ]);
  },
  { timeout: 60_000 },
);

scenario('P2.services.103', 'an unknown --module exits 2 and lists the valid modules', () => {
  const { exitCode, output } = driver('--module', 'nope');

  expect(exitCode).toBe(2);
  expect(output).toContain(`unknown module(s): nope; valid modules in ${fixtures}: alpha, beta`);
});
