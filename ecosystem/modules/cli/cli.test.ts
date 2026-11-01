import { afterAll, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getDescriptor, scenario } from '@asenajs/adapter-conformance';
import { isPortFree, randomPort, waitFor } from '@asenajs/adapter-conformance/helpers';
import { expectedCoreRange, localSpecs, packageVersion, portableOverrides, readManifest } from './specs.ts';

const ECOSYSTEM_DIR = join(import.meta.dir, '..', '..');
const SUITE_ROOT = join(ECOSYSTEM_DIR, '..');
const CLI_ENTRY = join(
  dirname(Bun.resolveSync('@asenajs/asena-cli/package.json', import.meta.dir)),
  'dist/bin/asena.js',
);
const GENERATED_PORT = 'port: 3000';
const TIMEOUT = 180_000;

let workDir: string | undefined;
let created: Promise<string> | undefined;
let installed: Promise<string> | undefined;

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

async function run(cmd: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(cmd, { cwd, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (code !== 0) throw new Error(`${cmd.join(' ')} exited ${code}\n${stdout}\n${stderr}`);

  return stdout;
}

function create(template: string): Promise<string> {
  created ??= (async () => {
    workDir = mkdtempSync(join(tmpdir(), 'asena-p2-cli-'));
    await run(
      [
        process.execPath,
        CLI_ENTRY,
        'create',
        'app',
        `--adapter=${template}`,
        '--no-logger',
        '--no-eslint',
        '--no-prettier',
        '--skip-install',
      ],
      workDir,
    );

    return join(workDir, 'app');
  })();

  return created;
}

function install(template: string): Promise<string> {
  installed ??= (async () => {
    const dir = await create(template);
    const manifestPath = join(dir, 'package.json');
    const manifest = readManifest(manifestPath);
    const local = new Map([
      ...localSpecs(join(SUITE_ROOT, 'package.json')),
      ...localSpecs(join(ECOSYSTEM_DIR, 'package.json')),
    ]);

    for (const deps of [manifest.dependencies, manifest.devDependencies]) {
      for (const name of Object.keys(deps ?? {})) {
        const spec = local.get(name);

        if (deps && spec) deps[name] = spec;
      }
    }

    manifest.overrides = portableOverrides(join(SUITE_ROOT, 'package.json'));
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const entry = join(dir, 'src', 'index.ts');
    const source = readFileSync(entry, 'utf8');

    if (!source.includes(GENERATED_PORT)) throw new Error(`generated entry has no '${GENERATED_PORT}':\n${source}`);
    writeFileSync(entry, source.replace(GENERATED_PORT, 'port: Number(process.env.PORT)'));

    await run([process.execPath, 'install'], dir);

    return dir;
  })();

  return installed;
}

async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = randomPort();

    if (await isPortFree(port)) return port;
  }

  throw new Error('no free port in 10000-31999');
}

async function serveAndAsk(dir: string, entry: string): Promise<void> {
  const port = await freePort();
  const child = Bun.spawn([process.execPath, entry], {
    cwd: dir,
    env: { ...process.env, PORT: String(port) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = new Response(child.stderr).text();

  try {
    const response = await waitFor(
      async () => {
        if (child.exitCode !== null) throw new Error(`exited ${child.exitCode}: ${await output}`);

        return fetch(`http://127.0.0.1:${port}/`).catch(() => undefined);
      },
      { timeout: 30_000, interval: 100, label: `${entry} answers on :${port}` },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('Hello asena');
  } finally {
    child.kill('SIGTERM');
    await child.exited;
  }

  expect(await isPortFree(port)).toBe(true);
}

function stripLineComments(text: string): string {
  return text.replace(/^\s*\/\/.*$/gm, '');
}

scenario(
  'P2.cli.001',
  'asena create --adapter=<cliTemplate> writes a project with both decorator flags',
  async () => {
    const dir = await create(getDescriptor().cliTemplate!);
    const tsconfig = JSON.parse(stripLineComments(readFileSync(join(dir, 'tsconfig.json'), 'utf8'))) as {
      compilerOptions: Record<string, unknown>;
    };

    expect(tsconfig.compilerOptions.experimentalDecorators).toBe(true);
    expect(tsconfig.compilerOptions.emitDecoratorMetadata).toBe(true);
  },
  { members: ['cliTemplate'], services: ['slow'], timeout: TIMEOUT },
);

scenario(
  'P2.cli.002',
  'the generated project installs on the suite core, boots from source and answers its route',
  async () => {
    const dir = await install(getDescriptor().cliTemplate!);
    const coreRange = expectedCoreRange(
      readManifest(join(SUITE_ROOT, 'package.json')).overrides?.['@asenajs/asena'] ?? '',
      packageVersion(Bun.resolveSync('@asenajs/asena/package.json', SUITE_ROOT)),
    );
    const version = packageVersion(join(dir, 'node_modules/@asenajs/asena/package.json'));

    expect(Bun.semver.satisfies(version, coreRange)).toBe(true);
    await serveAndAsk(dir, 'src/index.ts');
  },
  { members: ['cliTemplate'], services: ['slow'], timeout: TIMEOUT },
);

scenario(
  'P2.cli.003',
  'asena build output boots and answers the same route (decorator metadata survives bundling)',
  async () => {
    const dir = await install(getDescriptor().cliTemplate!);

    await run(
      [process.execPath, join(dir, 'node_modules', '@asenajs', 'asena-cli', 'dist', 'bin', 'asena.js'), 'build'],
      dir,
    );
    await serveAndAsk(dir, 'dist/index.asena.js');
  },
  { members: ['cliTemplate'], services: ['slow'], timeout: TIMEOUT },
);
