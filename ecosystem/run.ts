import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

const ecosystemDir = import.meta.dir;
const PRELUDE = ['test/00-resolution.test.ts', 'test/services.test.ts'];
const MARKER = '.process-per-file';
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

interface Options {
  modules: string[];
  modulesDir: string;
  out: string;
  junit: boolean;
  forward: string[];
}

interface Run {
  label: string;
  files: string[];
}

function usage(message: string): never {
  console.error(`ecosystem/run.ts: ${message}`);
  console.error(
    'usage: bun ecosystem/run.ts [--module <name> ...] [--modules-dir <dir>] [--reporter=junit] [--out <file>] [bun test args]',
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    modules: [],
    modulesDir: join(ecosystemDir, 'modules'),
    out: resolve('out/p2.xml'),
    junit: false,
    forward: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg] : [arg];
    const value = (): string => {
      if (inline !== undefined) return inline.slice(flag.length + 1);

      const next = argv[++i];

      if (next === undefined) usage(`${flag} needs a value`);

      return next;
    };

    switch (flag) {
      case '--module':
        options.modules.push(value());
        break;
      case '--modules-dir':
        options.modulesDir = resolve(value());
        break;
      case '--out':
        options.out = resolve(value());
        break;
      case '--reporter': {
        const reporter = value();

        if (reporter !== 'junit') usage(`unsupported reporter '${reporter}' (only junit is merged)`);
        options.junit = true;
        break;
      }
      case '--reporter-outfile':
        usage('--reporter-outfile is set per child process; use --out for the merged file');
        break;
      default:
        if (inline !== undefined) options.forward.push(inline);
        else options.forward.push(arg);
    }
  }

  return options;
}

function testFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') found.push(...testFiles(path));
    } else if (TEST_FILE.test(entry.name)) {
      found.push(path);
    }
  }

  return found.sort();
}

function moduleNames(modulesDir: string): string[] {
  if (!existsSync(modulesDir)) return [];

  return readdirSync(modulesDir)
    .filter((name) => !name.startsWith('.') && statSync(join(modulesDir, name)).isDirectory())
    .sort();
}

function plan(options: Options): Run[] {
  const available = moduleNames(options.modulesDir);
  const unknown = options.modules.filter((name) => !available.includes(name));

  if (unknown.length > 0) {
    usage(
      `unknown module(s): ${unknown.join(', ')}; valid modules in ${options.modulesDir}: ${available.join(', ') || '(none)'}`,
    );
  }

  const selected = options.modules.length > 0 ? available.filter((name) => options.modules.includes(name)) : available;
  const runs: Run[] = [{ label: 'prelude', files: PRELUDE.map((file) => join(ecosystemDir, file)) }];

  for (const name of selected) {
    const dir = join(options.modulesDir, name);
    const files = testFiles(dir);

    if (files.length === 0) continue;

    if (existsSync(join(dir, MARKER))) {
      for (const file of files) {
        const label = `${name}-${relative(dir, file)
          .replace(TEST_FILE, '')
          .replace(/[^A-Za-z0-9_-]+/g, '_')}`;

        runs.push({ label, files: [file] });
      }
    } else {
      runs.push({ label: name, files });
    }
  }

  return runs;
}

function attribute(tag: string, name: string): number {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);

  return match ? Number(match[1]) : 0;
}

function mergeJunit(files: string[], out: string): void {
  const totals = { tests: 0, assertions: 0, failures: 0, skipped: 0, time: 0 };
  const suites: string[] = [];

  for (const file of files) {
    if (!existsSync(file)) continue;

    const xml = readFileSync(file, 'utf8');
    const open = /<testsuites\b[^>]*>/.exec(xml);
    const close = xml.lastIndexOf('</testsuites>');

    if (!open || close < 0) continue;

    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += attribute(open[0], key);
    suites.push(xml.slice(open.index + open[0].length, close).replace(/^\n+|\s+$/g, ''));
  }

  const head =
    `<testsuites name="bun test" tests="${totals.tests}" assertions="${totals.assertions}" ` +
    `failures="${totals.failures}" skipped="${totals.skipped}" time="${totals.time}">`;

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `<?xml version="1.0" encoding="UTF-8"?>\n${head}\n${suites.join('\n')}\n</testsuites>\n`);
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  const runs = plan(options);
  const reportDir = options.junit ? mkdtempSync(join(tmpdir(), 'asena-p2-')) : undefined;
  const reports: string[] = [];
  let failed = false;

  try {
    for (const run of runs) {
      const args = ['test', ...run.files.map((file) => `./${relative(ecosystemDir, file)}`)];

      if (reportDir) {
        const report = join(reportDir, `${run.label}.xml`);

        reports.push(report);
        args.push('--reporter=junit', `--reporter-outfile=${report}`);
      }

      args.push(...options.forward);
      console.log(`\n[p2] ${run.label}: bun ${args.join(' ')}`);

      const child = Bun.spawnSync([process.execPath, ...args], {
        cwd: ecosystemDir,
        env: process.env,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      });

      if (child.exitCode !== 0) {
        failed = true;
        console.error(`[p2] ${run.label}: exit ${child.exitCode ?? child.signalCode}`);
      }
    }

    if (reportDir) {
      mergeJunit(reports, options.out);
      console.log(`[p2] junit: ${options.out} (${reports.map((report) => basename(report)).join(', ')})`);
    }
  } finally {
    if (reportDir) rmSync(reportDir, { recursive: true, force: true });
  }

  return failed ? 1 : 0;
}

process.exit(main());
