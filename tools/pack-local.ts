import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
}

interface Job {
  name: string;
  version: string;
  source: 'git' | 'dir';
  repo?: string;
  ref?: string;
  dir: string;
  commit?: string;
  sha: string;
  explicit: boolean;
  released: boolean;
  corePeer?: string;
  tarball?: string;
}

class Abort extends Error {}

const CORE = '@asenajs/asena';
const DEFAULT_REPOS = ['Asena', 'ergenecore', 'hono-adapter'];
const DEFAULT_REF = 'origin/master';
const MANIFESTS = ['package.json', 'packages/conformance/package.json', 'ecosystem/package.json'];
const WORKSPACE_DIRS = ['.', 'packages/conformance', 'ecosystem'];
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

const suiteRoot = resolve(import.meta.dir, '..');
const packsDir = resolve(process.env.ASENA_SUITE_PACKS_DIR ?? join(suiteRoot, '.local-packs'));
const restoreDir = join(packsDir, 'restore');

function fail(message: string): never {
  throw new Abort(message);
}

function run(cmd: string[], cwd: string, capture = false): string {
  const proc = Bun.spawnSync(cmd, {
    cwd,
    stdout: capture ? 'pipe' : 'inherit',
    stderr: 'inherit',
    env: process.env,
  });

  if (proc.exitCode !== 0) fail(`command failed (${proc.exitCode}) in ${cwd}: ${cmd.join(' ')}`);

  return capture ? (proc.stdout?.toString().trim() ?? '') : '';
}

function tryRun(cmd: string[], cwd: string): string | undefined {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', env: process.env });

  return proc.exitCode === 0 ? proc.stdout.toString().trim() : undefined;
}

function readManifest(file: string): Manifest {
  return JSON.parse(readFileSync(file, 'utf8')) as Manifest;
}

function writeManifest(file: string, manifest: Manifest): void {
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

function parseArgs(argv: string[]) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const opts = {
    workspace: undefined as string | undefined,
    refs: new Map<string, string>(),
    pkgs: new Map<string, string>(),
    restore: false,
  };

  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const value = (): string => {
      if (eq > 0) return raw.slice(eq + 1);

      const next = args[++i];

      if (next === undefined || next.startsWith('--')) fail(`${flag} needs a value`);

      return next;
    };
    const pair = (text: string): [string, string] => {
      const at = text.indexOf('=');

      if (at <= 0 || at === text.length - 1) fail(`${flag} expects <key>=<value>, got "${text}"`);

      return [text.slice(0, at), text.slice(at + 1)];
    };

    switch (flag) {
      case '--workspace':
        opts.workspace = resolve(value());
        break;
      case '--ref': {
        const [repo, ref] = pair(value());

        opts.refs.set(repo, ref);
        break;
      }
      case '--pkg': {
        const [name, dir] = pair(value());

        opts.pkgs.set(name, resolve(dir));
        break;
      }
      case '--restore':
        opts.restore = true;
        break;
      default:
        fail(
          `unknown argument "${raw}"\nusage: bun tools/pack-local.ts --workspace <dir> [--ref <repo>=<ref> ...] [--pkg <name>=<dir> ...] | --restore`,
        );
    }
  }

  return opts;
}

function npmVersion(name: string): string | undefined {
  return tryRun(['npm', 'view', name, 'version'], suiteRoot);
}

function cleanInstall(): void {
  for (const ws of WORKSPACE_DIRS) rmSync(join(suiteRoot, ws, 'node_modules'), { recursive: true, force: true });

  run(['bun', 'install'], suiteRoot);
}

function coreCopies(): string[] {
  const nm = join(suiteRoot, 'node_modules');
  const found = new Set<string>();

  for (const rel of new Bun.Glob('**/@asenajs/asena/package.json').scanSync({
    cwd: nm,
    dot: true,
    followSymlinks: false,
  })) {
    found.add(realpathSync(dirname(join(nm, rel))));
  }

  return [...found];
}

function installedCoreVersion(): string | undefined {
  const file = join(suiteRoot, 'node_modules', CORE, 'package.json');

  return existsSync(file) ? readManifest(file).version : undefined;
}

function restore(): void {
  if (!existsSync(restoreDir)) {
    console.log(`pack-local: no saved published manifests in ${restoreDir}; already in published mode`);
  } else {
    for (const file of [...MANIFESTS, 'bun.lock']) {
      const saved = join(restoreDir, file);

      if (existsSync(saved)) cpSync(saved, join(suiteRoot, file));
    }

    rmSync(restoreDir, { recursive: true, force: true });
    console.log('pack-local: published manifests and bun.lock restored');
  }

  cleanInstall();
  console.log(`pack-local: published mode, ${CORE}@${installedCoreVersion()}, core copies: ${coreCopies().length}`);
}

function resolveGitJob(workspace: string, repo: string, ref: string | undefined, fetched: Set<string>): Job {
  const repoDir = join(workspace, repo);

  if (!existsSync(join(repoDir, '.git'))) fail(`${repoDir} is not a git repository`);

  if (!fetched.has(repo)) {
    run(['git', '-C', repoDir, 'fetch', '--quiet', 'origin'], suiteRoot);
    fetched.add(repo);
  }

  const useRef = ref ?? DEFAULT_REF;
  const sha = tryRun(['git', '-C', repoDir, 'rev-parse', '--verify', '--quiet', `${useRef}^{commit}`], suiteRoot);

  if (!sha) fail(`${repo}: unknown ref "${useRef}"`);

  const manifest = JSON.parse(run(['git', '-C', repoDir, 'show', `${sha}:package.json`], suiteRoot, true)) as Manifest;

  return {
    name: manifest.name,
    version: manifest.version,
    source: 'git',
    repo,
    ref: useRef,
    dir: join(packsDir, 'src', repo),
    commit: sha,
    sha: sha.slice(0, 7),
    explicit: ref !== undefined,
    released: false,
    corePeer: manifest.peerDependencies?.[CORE],
  };
}

function resolveDirJob(name: string, dir: string): Job {
  const file = join(dir, 'package.json');

  if (!existsSync(file)) fail(`--pkg ${name}: ${file} does not exist`);

  const manifest = readManifest(file);

  if (manifest.name !== name) fail(`--pkg ${name}: ${file} is ${manifest.name}`);

  const head = tryRun(['git', '-C', dir, 'rev-parse', '--short=7', 'HEAD'], suiteRoot);
  const dirty = head !== undefined && (tryRun(['git', '-C', dir, 'status', '--porcelain'], suiteRoot) ?? '') !== '';

  return {
    name,
    version: manifest.version,
    source: 'dir',
    dir,
    sha: head ? `${head}${dirty ? '+dirty' : ''}` : '-',
    explicit: true,
    released: false,
    corePeer: manifest.peerDependencies?.[CORE],
  };
}

function peerCheck(jobs: Job[]): void {
  const coreJob = jobs.find((job) => job.name === CORE);
  const coreVersion = coreJob?.version ?? installedCoreVersion();

  if (!coreVersion) fail(`no ${CORE} version to check peers against (run bun install first)`);

  const conformance = readManifest(join(suiteRoot, 'packages/conformance/package.json'));
  const consumers: [string, string | undefined][] = [[conformance.name, conformance.peerDependencies?.[CORE]]];

  for (const job of jobs) {
    if (job.name !== CORE) consumers.push([job.name, job.corePeer]);
  }

  const broken = consumers.filter(([, range]) => range !== undefined && !Bun.semver.satisfies(coreVersion, range));

  if (broken.length > 0) {
    fail(
      [
        `peer range: ${CORE}@${coreVersion} does not satisfy`,
        ...broken.map(([name, range]) => `  ${name} peerDependencies["${CORE}"] = "${range}"`),
      ].join('\n'),
    );
  }
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.restore) {
    restore();
    return;
  }

  if (!opts.workspace) fail('--workspace <dir> is required');

  const fetched = new Set<string>();
  const repos = [...new Set([...DEFAULT_REPOS, ...opts.refs.keys()])];
  const dirJobs = [...opts.pkgs].map(([name, dir]) => resolveDirJob(name, dir));
  const covered = new Set(dirJobs.map((job) => job.name));
  const gitJobs = repos
    .map((repo) => resolveGitJob(opts.workspace!, repo, opts.refs.get(repo), fetched))
    .filter((job) => !covered.has(job.name));
  const jobs = [...gitJobs, ...dirJobs].sort((a, b) => Number(b.name === CORE) - Number(a.name === CORE));

  for (const job of jobs) {
    const published = npmVersion(job.name);

    job.released = published === job.version;

    if (!job.explicit && !job.released) {
      fail(`archived ${job.name}@${job.version} != npm ${published ?? '<unavailable>'}`);
    }
  }

  peerCheck(jobs);

  mkdirSync(packsDir, { recursive: true });

  for (const job of jobs) {
    if (job.source === 'git') {
      rmSync(job.dir, { recursive: true, force: true });
      mkdirSync(job.dir, { recursive: true });

      run(
        [
          'bash',
          '-o',
          'pipefail',
          '-c',
          'git -C "$1" archive "$2" | tar -x -C "$3"',
          'pack-local',
          join(opts.workspace, job.repo!),
          job.commit!,
          job.dir,
        ],
        suiteRoot,
      );
      run(['bun', 'install'], job.dir);
    } else if (!existsSync(join(job.dir, 'node_modules'))) {
      run(['bun', 'install', '--frozen-lockfile'], job.dir);
    }

    run(['bun', 'run', 'build'], job.dir);

    const base = `${job.name.replace(/^@/, '').replace('/', '-')}-${job.version}-${job.sha.replace('+', '-')}`;

    for (const old of readdirSync(packsDir)) {
      if (old.startsWith(`${job.name.replace(/^@/, '').replace('/', '-')}-`) && old.endsWith('.tgz')) {
        rmSync(join(packsDir, old));
      }
    }

    job.tarball = join(packsDir, `${base}.tgz`);
    run(['bun', 'pm', 'pack', '--ignore-scripts', '--quiet', '--filename', job.tarball], job.dir);

    if (!existsSync(job.tarball)) fail(`${job.name}: bun pm pack did not write ${job.tarball}`);
  }

  if (!existsSync(restoreDir)) {
    for (const file of [...MANIFESTS, 'bun.lock']) {
      const target = join(restoreDir, file);

      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(suiteRoot, file), target);
    }
  }

  const tarballs = new Map(jobs.map((job) => [job.name, job.tarball!]));

  for (const file of MANIFESTS) {
    const manifest = readManifest(join(restoreDir, file));
    const from = dirname(join(suiteRoot, file));
    const spec = (name: string) => `file:./${relative(from, tarballs.get(name)!)}`;

    for (const field of DEP_FIELDS) {
      const deps = manifest[field];

      if (!deps) continue;

      for (const name of Object.keys(deps)) if (tarballs.has(name)) deps[name] = spec(name);
    }

    if (file === 'package.json') {
      manifest.overrides ??= {};
      for (const name of new Set([CORE, ...Object.keys(manifest.overrides)])) {
        if (tarballs.has(name)) manifest.overrides[name] = spec(name);
      }
    }

    writeManifest(join(suiteRoot, file), manifest);
  }

  rmSync(join(suiteRoot, 'bun.lock'), { force: true });
  cleanInstall();

  const copies = coreCopies();
  const installed = installedCoreVersion();
  const core = jobs.find((job) => job.name === CORE);

  if (core && installed !== core.version) fail(`installed ${CORE}@${installed} != packed ${core.version}`);

  console.log('\npack-local: installed from local tarballs');
  console.table(
    jobs.map((job) => ({
      package: job.name,
      version: job.version,
      'ref / dir': job.source === 'git' ? `${job.repo}@${job.ref}` : job.dir,
      sha: job.sha,
      status: job.released ? 'released' : 'UNRELEASED',
    })),
  );
  console.log(`core copies: ${copies.length}${copies.length === 1 ? '' : ` -> ${copies.join(', ')}`}`);

  if (copies.length !== 1) fail(`expected one ${CORE} copy, found ${copies.length}`);
}

try {
  main();
} catch (error) {
  if (error instanceof Abort) {
    console.error(`pack-local: ${error.message}`);
    process.exit(1);
  }

  throw error;
}
