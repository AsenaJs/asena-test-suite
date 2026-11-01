import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Finding } from './common.ts';

export const SELECTORS = ['ergenecore', 'hono'] as const;
export type Selector = (typeof SELECTORS)[number];

export interface Case {
  name: string;
  classname: string;
  file: string;
  status: 'pass' | 'skip' | 'fail';
  message: string;
}

export interface RogueResult {
  label: string;
  exitCode: number;
  cases: Case[];
}

export interface ParityInputs {
  p1: Record<string, Case[]>;
  p2: Record<string, Case[]>;
  entry: Record<string, Case[]>;
  rogue: RogueResult[];
  divergences: Record<string, Record<string, unknown>>;
  missingReports?: string[];
}

export interface ParityResult {
  findings: Finding[];
  otherFailures: number;
}

const ID = /^\[(P[12](?:\.[A-Za-z0-9-]+){2,})\]/;
const P2_TEST_SEGMENTS = new Set(['resolution', 'services']);
const ROGUE_ID = 'P1.resolution.010';

function decode(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attributes(text: string): Record<string, string> {
  const found: Record<string, string> = {};

  for (const match of text.matchAll(/([\w:-]+)="([^"]*)"/g)) found[match[1]] = decode(match[2]);

  return found;
}

export function parseJunit(xml: string): Case[] {
  const cases: Case[] = [];

  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = attributes(match[1]);
    const body = match[2] ?? '';
    const failure = /<(?:failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:failure|error)>)/.exec(body);
    const status = failure ? 'fail' : /<skipped\b/.test(body) ? 'skip' : 'pass';
    const message = failure ? `${attributes(failure[1]).message ?? ''}\n${decode(failure[2] ?? '')}` : '';

    cases.push({ name: attrs.name ?? '', classname: attrs.classname ?? '', file: attrs.file ?? '', status, message });
  }

  return cases;
}

export function readJunit(file: string): Case[] {
  return existsSync(file) ? parseJunit(readFileSync(file, 'utf8')) : [];
}

function tags(name: string, kind: 'cap' | 'svc'): string[] {
  return [...name.matchAll(new RegExp(`\\[${kind}:([^\\]]+)\\]`, 'g'))].map((match) => match[1]);
}

function expectedSegment(part: 'P1' | 'P2', testCase: Case): string[] | undefined {
  if (part === 'P1') {
    const area = testCase.classname.split(/\s*>\s*/)[0]?.trim();

    return area ? [area] : undefined;
  }

  const file = testCase.file.replace(/\\/g, '/');
  const module = /(?:^|\/)modules\/([^/]+)\//.exec(file)?.[1];

  if (module) return [module];
  if (/(?:^|\/)test\/[^/]+$/.test(file)) return [...P2_TEST_SEGMENTS];

  return undefined;
}

function idOf(testCase: Case): string | undefined {
  return ID.exec(testCase.name)?.[1];
}

function symmetricDifference(a: Set<string>, b: Set<string>): string[] {
  return [
    ...[...a].filter((id) => !b.has(id)).map((id) => `-${id}`),
    ...[...b].filter((id) => !a.has(id)).map((id) => `+${id}`),
  ];
}

export function judgeParity(inputs: ParityInputs): ParityResult {
  const findings: Finding[] = [];
  let otherFailures = 0;
  const report = (rule: string, file: string, message: string): void => {
    findings.push({ check: 'parity', rule, file, message });
  };
  const declaredOff = (adapter: string): Set<string> =>
    new Set(
      Object.entries(inputs.divergences[adapter] ?? {})
        .filter(([, value]) => value === false)
        .map(([flag]) => flag),
    );

  const judgeRun = (label: string, part: 'P1' | 'P2', cases: Case[], declared: Set<string>): Set<string> => {
    const ids = new Set<string>();

    for (const testCase of cases) {
      const id = idOf(testCase);
      const where = `${label}:${testCase.file}`;

      if (!id) {
        report('id-grammar', where, `test name without a valid ID: '${testCase.name}'`);
        continue;
      }

      const segments = id.split('.');

      if (segments[0] !== part) report('id-part', where, `${id} runs in the ${part} set`);

      const expected = expectedSegment(part, testCase);

      if (!expected?.includes(segments[1])) {
        report(
          'id-segment',
          where,
          `${id}: second segment '${segments[1]}' does not match '${expected?.join('|') ?? '?'}'`,
        );
      }

      if (ids.has(id)) report('id-duplicate', where, `${id} is registered twice`);
      ids.add(id);

      const caps = tags(testCase.name, 'cap');
      const services = tags(testCase.name, 'svc');
      const divergenceTags = caps.filter((cap) => !cap.startsWith('optional.') && !cap.startsWith('member:'));
      const hasDeclaredDivergence = divergenceTags.some((flag) => declared.has(flag));

      if (
        testCase.status === 'skip' &&
        services.length === 0 &&
        !caps.some((cap) => cap.startsWith('optional.') || cap.startsWith('member:'))
      ) {
        report('skip-untagged', where, `${id} is skipped without a [svc:], [cap:optional.*] or [cap:member:*] tag`);
      }

      for (const cap of caps) {
        if (cap.startsWith('optional.')) {
          report('first-party-optional-skip', where, `${id} carries [cap:${cap}] in a first-party run`);
        } else if (cap.startsWith('member:')) {
          if (!hasDeclaredDivergence) {
            report('first-party-member-skip', where, `${id} carries [cap:${cap}] in a first-party run`);
          }
        } else if (!declared.has(cap)) {
          report(
            'undeclared-divergence',
            where,
            `${id} carries [cap:${cap}] but the adapter does not declare it false`,
          );
        } else if (testCase.status === 'skip' && services.length === 0) {
          report('divergence-skipped', where, `${id} is divergence-gated and skipped`);
        }
      }

      if (testCase.status === 'fail') {
        const firstLine = testCase.message.split('\n')[0];

        if (testCase.message.includes('STALE FLAG')) report('stale-flag', where, `${id}: ${firstLine}`);
        else if (testCase.message.includes('UNEXPECTED (flag')) report('wrong-cause', where, `${id}: ${firstLine}`);
        else otherFailures++;
      }
    }

    return ids;
  };

  const p1Sets = new Map<string, Set<string>>();
  const p2Sets = new Map<string, Set<string>>();

  for (const adapter of Object.keys(inputs.p1)) {
    const declared = declaredOff(adapter);
    const p1 = judgeRun(`p1-${adapter}`, 'P1', inputs.p1[adapter], declared);
    const p2 = judgeRun(`p2-${adapter}`, 'P2', inputs.p2[adapter] ?? [], declared);

    p1Sets.set(adapter, p1);
    p2Sets.set(adapter, p2);

    const titles = [...(inputs.p1[adapter] ?? []), ...(inputs.p2[adapter] ?? [])].map((testCase) => testCase.name);

    for (const flag of declared) {
      if (!titles.some((title) => title.includes(`[cap:${flag}]`))) {
        report('dead-flag', `p1-${adapter}`, `${flag} is declared false but no test of this run carries it`);
      }
    }

    if (inputs.entry[adapter]) {
      const entry = judgeRun(`entry-${adapter}`, 'P1', inputs.entry[adapter], new Set());
      const diff = symmetricDifference(p1, entry);

      if (diff.length > 0) {
        report('entry-id-mismatch', `entry-${adapter}`, `entry ID set differs from P1: ${diff.join(' ')}`);
      }
    }
  }

  const compare = (label: string, sets: Map<string, Set<string>>): void => {
    const [first, ...rest] = [...sets.entries()];

    for (const [adapter, set] of rest) {
      const diff = symmetricDifference(first[1], set);

      if (diff.length > 0) report('id-set-mismatch', label, `${first[0]} vs ${adapter}: ${diff.join(' ')}`);
    }
  };

  compare('p1', p1Sets);
  compare('p2', p2Sets);

  for (const label of inputs.missingReports ?? []) {
    report('missing-report', label, 'the run wrote no junit report (crashed before reporting?)');
  }

  for (const rogue of inputs.rogue) {
    if (rogue.exitCode === 0) report('rogue-exit', rogue.label, 'the rogue entry exited 0');

    const guard = rogue.cases.find((testCase) => idOf(testCase) === ROGUE_ID);

    if (guard?.status !== 'fail' || !guard.message.includes('NOT-CONFORMANT')) {
      report('rogue-not-flagged', rogue.label, `${ROGUE_ID} did not fail with NOT-CONFORMANT`);
    }
  }

  return { findings, otherFailures };
}

interface Spawned {
  exitCode: number;
}

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === 'ASENA_ADAPTER') continue;
    if (key.startsWith('ASENA_SUITE_') && key !== 'ASENA_SUITE_PACKS_DIR' && key !== 'ASENA_SUITE_PLANS_DIR') continue;
    env[key] = value;
  }

  return { ...env, ...extra };
}

function spawn(cmd: string[], cwd: string, env: Record<string, string>, quiet: boolean): Spawned {
  const child = Bun.spawnSync(cmd, {
    cwd,
    env,
    stdout: quiet ? 'ignore' : 'inherit',
    stderr: quiet ? 'ignore' : 'inherit',
  });

  return { exitCode: child.exitCode ?? 1 };
}

export const ROGUE_DIR = 'tools/validate/fixtures/rogue-entry';

export function runRogueEntries(root: string, quiet = true): RogueResult[] {
  const out = join(root, 'out', 'validate');
  const filter = ['-t', `\\[${ROGUE_ID.replace(/\./g, '\\.')}\\]`];

  mkdirSync(out, { recursive: true });

  const runs: { label: string; cmd: string[]; cwd: string; env: Record<string, string> }[] = [
    {
      label: 'rogue-runConformance',
      cmd: ['test', `./${ROGUE_DIR}/rogue.entry.ts`],
      cwd: root,
      env: cleanEnv({}),
    },
    {
      label: 'rogue-selector-path',
      cmd: ['test', './test/00-resolution.test.ts'],
      cwd: join(root, 'packages', 'conformance'),
      env: cleanEnv({ ASENA_ADAPTER: join(root, ROGUE_DIR, 'rogue-adapter.ts') }),
    },
  ];

  return runs.map(({ label, cmd, cwd, env }) => {
    const report = join(out, `${label}.xml`);

    rmSync(report, { force: true });

    const { exitCode } = spawn(
      [process.execPath, ...cmd, ...filter, '--reporter=junit', `--reporter-outfile=${report}`],
      cwd,
      env,
      quiet,
    );

    return { label, exitCode, cases: readJunit(report) };
  });
}

export async function runParity(root: string, quiet = false): Promise<ParityResult> {
  const out = join(root, 'out');
  const inputs: ParityInputs = { p1: {}, p2: {}, entry: {}, rogue: [], divergences: {}, missingReports: [] };

  mkdirSync(join(out, 'entry'), { recursive: true });

  for (const selector of SELECTORS) {
    const adapterModule = join(root, 'adapters', `${selector}.ts`);
    const mod = (await import(adapterModule)) as { divergences?: Record<string, unknown> };

    inputs.divergences[selector] = mod.divergences ?? {};

    const p1 = join(out, `p1-${selector}.xml`);
    const p2 = join(out, `p2-${selector}.xml`);
    const entryXml = join(out, `entry-${selector}.xml`);
    const entryFile = join(out, 'entry', `${selector}.entry.test.ts`);

    for (const file of [p1, p2, entryXml]) rmSync(file, { force: true });

    spawn(
      [process.execPath, 'test', './test/', '--reporter=junit', `--reporter-outfile=${p1}`],
      join(root, 'packages', 'conformance'),
      cleanEnv({ ASENA_ADAPTER: selector }),
      quiet,
    );
    spawn(
      [process.execPath, join(root, 'ecosystem', 'run.ts'), '--reporter=junit', '--out', p2],
      root,
      cleanEnv({ ASENA_ADAPTER: selector }),
      quiet,
    );

    writeFileSync(
      entryFile,
      [
        "import { runConformance } from '@asenajs/adapter-conformance';",
        `import descriptor from ${JSON.stringify(adapterModule)};`,
        '',
        `runConformance({ ...descriptor, packageRoot: ${JSON.stringify(root)} });`,
        '',
      ].join('\n'),
    );
    spawn(
      [
        process.execPath,
        'test',
        `./out/entry/${selector}.entry.test.ts`,
        '--reporter=junit',
        `--reporter-outfile=${entryXml}`,
      ],
      root,
      cleanEnv({}),
      quiet,
    );

    for (const file of [p1, p2, entryXml]) {
      if (!existsSync(file)) inputs.missingReports!.push(relative(root, file));
    }

    inputs.p1[selector] = readJunit(p1);
    inputs.p2[selector] = readJunit(p2);
    inputs.entry[selector] = readJunit(entryXml);
  }

  inputs.rogue = runRogueEntries(root, quiet);

  return judgeParity(inputs);
}
