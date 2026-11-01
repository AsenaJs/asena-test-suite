import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Finding } from '../common.ts';
import { type Case, cleanEnv, idOf, loadDivergences, readJunit, runP1, SELECTORS, type Selector } from '../parity.ts';

export type Variant = 'archive' | 'npm';
export type Status = Case['status'];

export const ADAPTER_REPOS: Record<Selector, { repo: string; packageName: string }> = {
  ergenecore: { repo: 'ergenecore', packageName: '@asenajs/ergenecore' },
  hono: { repo: 'hono-adapter', packageName: '@asenajs/hono-adapter' },
};

const GUARD_ID = 'P1.resolution.004';
const ALLOWED_SCOPED = new Set(['asena', 'adapter-conformance']);

export interface Difference {
  id: string;
  p1: Status | 'missing';
  expected: Status | 'missing';
  packed: Status | 'missing';
  note: string;
}

export interface Comparison {
  findings: Finding[];
  differences: Difference[];
  expectedFailures: string[];
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] || '(no failure message in the junit report)';
}

function divergenceTags(name: string): string[] {
  return [...name.matchAll(/\[cap:([^\]]+)\]/g)]
    .map((match) => match[1])
    .filter((cap) => !cap.startsWith('optional.') && !cap.startsWith('member:'));
}

function byId(cases: Case[]): Map<string, Case> {
  const map = new Map<string, Case>();

  for (const testCase of cases) {
    const id = idOf(testCase);

    if (id) map.set(id, testCase);
  }

  return map;
}

export function comparePacked(label: string, p1: Case[], packed: Case[], declaredOff: Set<string>): Comparison {
  const findings: Finding[] = [];
  const differences: Difference[] = [];
  const expectedFailures: string[] = [];
  const report = (rule: string, message: string): void => {
    findings.push({ check: 'packed', rule, file: label, message });
  };
  const p1Cases = byId(p1);
  const packedCases = byId(packed);

  for (const [id, p1Case] of p1Cases) {
    const packedCase = packedCases.get(id);
    const flags = divergenceTags(p1Case.name).filter((flag) => declaredOff.has(flag));
    const expected: Status = flags.length > 0 ? 'fail' : p1Case.status;

    if (!packedCase) {
      differences.push({ id, p1: p1Case.status, expected, packed: 'missing', note: 'not collected by the packed run' });
      report('packed-id-set', `${id} is in the P1 run but not in the packed run`);
      continue;
    }

    if (id === GUARD_ID && packedCase.status !== 'pass') {
      differences.push({
        id,
        p1: p1Case.status,
        expected,
        packed: packedCase.status,
        note: firstLine(packedCase.message),
      });
      report('packed-guard', `${GUARD_ID} must pass in the packed run: ${firstLine(packedCase.message)}`);
      continue;
    }

    if (packedCase.status === expected) {
      if (flags.length > 0) expectedFailures.push(id);
      continue;
    }

    if (flags.length > 0) {
      differences.push({
        id,
        p1: p1Case.status,
        expected,
        packed: packedCase.status,
        note: `declared-false divergence ${flags.join(', ')} did not fail`,
      });
      report(
        'packed-divergence-passed',
        `${id} carries the declared-false divergence ${flags.join(', ')} in P1 but is ${packedCase.status} in the packed run`,
      );
    } else {
      const note = packedCase.status === 'fail' ? firstLine(packedCase.message) : '';

      differences.push({ id, p1: p1Case.status, expected, packed: packedCase.status, note });
      report('packed-status', `${id}: P1 ${p1Case.status}, packed ${packedCase.status} ${note}`.trimEnd());
    }
  }

  for (const [id, packedCase] of packedCases) {
    if (p1Cases.has(id)) continue;

    differences.push({ id, p1: 'missing', expected: 'missing', packed: packedCase.status, note: 'not in the P1 run' });
    report('packed-id-set', `${id} is in the packed run but not in the P1 run`);
  }

  for (const testCase of packed) {
    if (!idOf(testCase)) report('packed-id-grammar', `test name without a valid ID: '${testCase.name}'`);
  }

  return { findings, differences, expectedFailures };
}

export function formatDifferences(differences: Difference[]): string[] {
  if (differences.length === 0) return ['  (no differences)'];

  const rows = differences.map((row) => [row.id, row.p1, row.expected, row.packed, row.note]);
  const header = ['ID', 'P1', 'expected', 'packed', 'note'];
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
  const line = (cells: string[]): string =>
    `  | ${cells.map((cell, column) => cell.padEnd(column === 4 ? 0 : widths[column])).join(' | ')} |`;

  return [line(header), line(widths.map((width, column) => '-'.repeat(column === 4 ? 3 : width))), ...rows.map(line)];
}

export function resolveWorkspace(root: string, cli: string | undefined, env: string | undefined): string | undefined {
  if (cli) return resolve(cli);
  if (env !== undefined) return env === '' ? undefined : resolve(env);

  const parent = dirname(root);

  return existsSync(join(parent, 'ergenecore', '.git')) ? parent : undefined;
}

interface Exec {
  ok: boolean;
  output: string;
}

function exec(cmd: string[], cwd: string, env = cleanEnv({})): Exec {
  const child = Bun.spawnSync(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const output = `${child.stdout.toString()}${child.stderr.toString()}`;

  return { ok: child.exitCode === 0, output };
}

function tail(text: string, lines = 15): string {
  return text.trim().split('\n').slice(-lines).join('\n');
}

function readJson(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
}

function installedVersion(root: string, packageName: string): string {
  return readJson(join(root, 'node_modules', packageName, 'package.json')).version as string;
}

export function entryOf(manifest: Record<string, any>): string {
  const dot = manifest.exports?.['.'] ?? manifest.exports;
  const target =
    typeof dot === 'string' ? dot : (dot?.import ?? dot?.default ?? manifest.main ?? manifest.module ?? 'index.js');

  return `../${String(target).replace(/^\.\//, '')}`;
}

function counts(cases: Case[]): string {
  const of = (status: Status): number => cases.filter((testCase) => testCase.status === status).length;

  return `${cases.length} (${of('pass')} pass / ${of('skip')} skip / ${of('fail')} fail)`;
}

const CONSUMER_TSCONFIG = {
  compilerOptions: {
    strict: true,
    target: 'ESNext',
    module: 'ESNext',
    moduleResolution: 'bundler',
    types: ['bun'],
    skipLibCheck: false,
    noEmit: true,
  },
  include: ['test/conformance*.ts'],
};

const TEST_ENTRY = [
  "import { runConformance } from '@asenajs/adapter-conformance';",
  "import { descriptor } from './conformance.adapter';",
  '',
  "runConformance({ ...descriptor, packageRoot: import.meta.dir + '/..' });",
  '',
].join('\n');

export interface PackedOptions {
  workspace?: string;
  keep?: boolean;
  reuseP1?: boolean;
  adapters?: readonly Selector[];
}

export interface PackedLeg {
  adapter: Selector;
  variant: Variant;
  version: string;
  seconds: number;
  p1: string;
  packed: string;
  differences: Difference[];
  expectedFailures: string[];
}

export interface PackedResult {
  findings: Finding[];
  legs: PackedLeg[];
  tmp: string;
}

function packTarball(root: string, tmp: string, findings: Finding[]): string | undefined {
  const pkgDir = join(root, 'packages', 'conformance');
  const fail = (rule: string, message: string): undefined => {
    findings.push({ check: 'packed', rule, file: 'packages/conformance', message });

    return undefined;
  };
  const build = exec([process.execPath, 'run', 'build'], pkgDir);

  if (!build.ok) return fail('packed-build', `bun run build failed:\n${tail(build.output)}`);

  const pack = exec([process.execPath, 'pm', 'pack', '--destination', tmp], pkgDir);
  const tarball = readdirSync(tmp).find((name) => name.endsWith('.tgz'));

  if (!pack.ok || !tarball) return fail('packed-pack', `bun pm pack failed:\n${tail(pack.output)}`);

  const file = join(tmp, tarball);
  const listing = exec(['tar', '-tzf', file], tmp).output.split('\n');
  const sources = listing.filter((entry) => entry.startsWith('package/src/'));

  if (sources.length > 0) fail('packed-tarball-src', `the tarball ships ${sources.length} src/ entries`);
  if (!listing.includes('package/dist/index.js')) fail('packed-tarball-dist', 'the tarball has no dist/index.js');

  return file;
}

function prepareArchive(workspace: string, repo: string, version: string, project: string, tmp: string): Exec {
  const tar = join(tmp, `${repo}-v${version}.tar`);
  const archive = exec(['git', '-C', join(workspace, repo), 'archive', '-o', tar, `v${version}`], tmp);

  if (!archive.ok) return archive;

  const extract = exec(['tar', '-xf', tar, '-C', project], tmp);

  if (!extract.ok) return extract;

  const install = exec([process.execPath, 'install'], project);

  if (!install.ok) return install;

  return exec([process.execPath, 'run', 'build'], project);
}

function prepareNpm(packageName: string, version: string, project: string, tmp: string): Exec {
  const npmDir = join(tmp, 'npm');

  mkdirSync(npmDir, { recursive: true });

  const pack = exec(['npm', 'pack', `${packageName}@${version}`, '--pack-destination', npmDir, '--silent'], npmDir);
  const tarball = pack.output.trim().split('\n').pop() ?? '';

  if (!pack.ok || !existsSync(join(npmDir, tarball))) return { ok: false, output: pack.output };

  const extract = exec(['tar', '-xzf', join(npmDir, tarball), '-C', project, '--strip-components=1'], tmp);

  if (!extract.ok) return extract;

  const manifestFile = join(project, 'package.json');
  const manifest = readJson(manifestFile);

  delete manifest.devDependencies;
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  rmSync(join(project, 'tsconfig.json'), { force: true });

  return exec([process.execPath, 'install'], project);
}

function locateReport(project: string, requested: string): string | undefined {
  if (existsSync(requested)) return requested;

  const bunfig = join(project, 'bunfig.toml');

  if (!existsSync(bunfig)) return undefined;

  const config = Bun.TOML.parse(readFileSync(bunfig, 'utf8')) as { test?: { reporter?: { junit?: string } } };
  const declared = config.test?.reporter?.junit;

  if (!declared || !existsSync(join(project, declared))) return undefined;

  copyFileSync(join(project, declared), requested);

  return requested;
}

async function runLeg(
  root: string,
  adapter: Selector,
  variant: Variant,
  tarball: string,
  tmp: string,
  workspace: string | undefined,
  reuseP1: boolean,
): Promise<{ findings: Finding[]; leg?: PackedLeg }> {
  const started = performance.now();
  const label = `packed-${adapter}-${variant}`;
  const findings: Finding[] = [];
  const fail = (rule: string, message: string): { findings: Finding[] } => {
    findings.push({ check: 'packed', rule, file: label, message });

    return { findings };
  };
  const { repo, packageName } = ADAPTER_REPOS[adapter];
  const version = installedVersion(root, packageName);
  const project = join(tmp, `${adapter}-${variant}`);

  mkdirSync(project, { recursive: true });

  const prepared =
    variant === 'archive'
      ? prepareArchive(workspace!, repo, version, project, tmp)
      : prepareNpm(packageName, version, project, tmp);

  if (!prepared.ok) return fail('packed-setup', `preparing the ${variant} project failed:\n${tail(prepared.output)}`);
  if (variant === 'npm' && existsSync(join(project, 'tsconfig.json'))) {
    return fail('packed-setup', 'the npm project still has a root tsconfig.json');
  }

  const manifest = readJson(join(project, 'package.json'));
  const typescript = (manifest.devDependencies?.typescript ??
    manifest.peerDependencies?.typescript ??
    'latest') as string;
  const typesBun = installedVersion(root, '@types/bun');
  const add = exec(
    [process.execPath, 'add', '-d', tarball, `typescript@${typescript}`, `@types/bun@${typesBun}`],
    project,
  );

  if (!add.ok) return fail('packed-setup', `bun add -d failed:\n${tail(add.output)}`);

  const scoped = readdirSync(join(project, 'node_modules', '@asenajs')).filter((name) => !ALLOWED_SCOPED.has(name));

  if (scoped.length > 0) {
    fail('packed-foreign-package', `unexpected @asenajs packages installed: ${scoped.join(', ')}`);
  }

  const template = readFileSync(join(import.meta.dir, `descriptor.${adapter}.ts.template`), 'utf8');

  mkdirSync(join(project, 'test'), { recursive: true });
  writeFileSync(join(project, 'test', 'conformance.adapter.ts'), template.replace('{{ENTRY}}', entryOf(manifest)));
  writeFileSync(join(project, 'test', 'conformance.test.ts'), TEST_ENTRY);
  writeFileSync(join(project, 'tsconfig.consumer.json'), `${JSON.stringify(CONSUMER_TSCONFIG, null, 2)}\n`);

  const tsc = exec(
    [
      process.execPath,
      join(project, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--noEmit',
      '-p',
      'tsconfig.consumer.json',
    ],
    project,
  );

  if (!tsc.ok) fail('packed-consumer-tsc', `consumer tsc --noEmit failed:\n${tail(tsc.output, 30)}`);

  const outDir = join(root, 'out');
  const xml = join(outDir, `${label}.xml`);
  const p1Xml = join(outDir, `p1-${adapter}.xml`);

  mkdirSync(outDir, { recursive: true });
  rmSync(xml, { force: true });

  const run = exec(
    [process.execPath, 'test', 'test/conformance.test.ts', '--reporter=junit', `--reporter-outfile=${xml}`],
    project,
  );

  if (!locateReport(project, xml)) {
    return fail('packed-missing-report', `the packed run wrote no junit report:\n${tail(run.output)}`);
  }
  if (!reuseP1 || !existsSync(p1Xml)) runP1(root, adapter, p1Xml, true);
  if (!existsSync(p1Xml)) return fail('packed-missing-report', `the P1 run wrote no ${p1Xml}`);

  const p1 = readJunit(p1Xml);
  const packed = readJunit(xml);
  const declared = await loadDivergences(root, adapter);
  const declaredOff = new Set(Object.keys(declared).filter((flag) => declared[flag] === false));
  const comparison = comparePacked(label, p1, packed, declaredOff);

  findings.push(...comparison.findings);

  return {
    findings,
    leg: {
      adapter,
      variant,
      version,
      seconds: (performance.now() - started) / 1000,
      p1: counts(p1),
      packed: counts(packed),
      differences: comparison.differences,
      expectedFailures: comparison.expectedFailures,
    },
  };
}

export async function runPacked(root: string, options: PackedOptions = {}): Promise<PackedResult> {
  const tmp = mkdtempSync(join(tmpdir(), 'asena-packed-'));
  const findings: Finding[] = [];
  const legs: PackedLeg[] = [];
  const variant: Variant = options.workspace ? 'archive' : 'npm';
  const tarball = packTarball(root, tmp, findings);

  if (tarball) {
    for (const adapter of options.adapters ?? SELECTORS) {
      const result = await runLeg(root, adapter, variant, tarball, tmp, options.workspace, options.reuseP1 ?? false);

      findings.push(...result.findings);
      if (result.leg) legs.push(result.leg);
    }
  }

  if (!options.keep) rmSync(tmp, { recursive: true, force: true });

  return { findings, legs, tmp };
}
