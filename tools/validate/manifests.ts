import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type Finding, listFiles, rel, under } from './common.ts';
import { checkIdentityFiles } from './identity.ts';
import { checkImportsInFile } from './imports.ts';

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
const ADAPTER_DEP = /^(?:@asenajs\/ergenecore|@asenajs\/hono-adapter|hono|@hono\/.+)$/;
const CONFORMANCE = 'packages/conformance/package.json';
const ECOSYSTEM = 'ecosystem/package.json';
const SELECTOR = 'tools/select-adapter.ts';

type Manifest = Record<string, unknown>;

function readJson(file: string): Manifest {
  return JSON.parse(readFileSync(file, 'utf8')) as Manifest;
}

function exportTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(exportTargets);

  return [];
}

function checkDependencies(manifest: Manifest, file: string, findings: Finding[]): void {
  for (const field of DEP_FIELDS) {
    const deps = manifest[field] as Record<string, string> | undefined;

    for (const name of Object.keys(deps ?? {})) {
      if (ADAPTER_DEP.test(name)) {
        findings.push({ check: 'manifests', rule: 'adapter-dependency', file, message: `${field} names '${name}'` });
      }
    }
  }
}

function checkConformance(root: string, findings: Finding[]): void {
  const path = join(root, CONFORMANCE);

  if (!existsSync(path)) {
    findings.push({ check: 'manifests', rule: 'missing-manifest', file: CONFORMANCE, message: 'file not found' });

    return;
  }

  const manifest = readJson(path);
  const report = (rule: string, message: string): void => {
    findings.push({ check: 'manifests', rule, file: CONFORMANCE, message });
  };

  checkDependencies(manifest, CONFORMANCE, findings);

  for (const field of DEP_FIELDS) {
    const deps = manifest[field] as Record<string, string> | undefined;

    if (deps && 'zod' in deps && field !== 'peerDependencies') report('zod-placement', `zod appears in ${field}`);
  }

  const peers = manifest.peerDependencies as Record<string, string> | undefined;
  const meta = manifest.peerDependenciesMeta as Record<string, { optional?: boolean }> | undefined;

  if (peers && 'zod' in peers && meta?.zod?.optional !== true) {
    report('zod-placement', 'zod is a peer but peerDependenciesMeta.zod.optional is not true');
  }

  const files = manifest.files;

  if (!Array.isArray(files) || files.length !== 2 || files[0] !== 'dist' || files[1] !== 'README.md') {
    report('package-files', `files must be exactly ["dist", "README.md"], got ${JSON.stringify(files)}`);
  }

  const exportsField = manifest.exports;
  const keys = exportsField && typeof exportsField === 'object' ? Object.keys(exportsField) : [];

  if (keys.length !== 2 || !keys.includes('.') || !keys.includes('./helpers')) {
    report('package-exports', `exports must have exactly '.' and './helpers', got ${JSON.stringify(keys)}`);
  }

  const targets = [...exportTargets(exportsField), ...exportTargets(manifest.types)];

  for (const target of targets) {
    if (!target.startsWith('./dist/')) report('package-exports', `'${target}' does not lie under dist/`);
  }

  if (typeof manifest.types !== 'string') report('package-exports', '`types` must point into dist/');
}

function preloadEntries(toml: Record<string, unknown>): string[] {
  const entries: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === 'string') entries.push(value);
    else if (Array.isArray(value)) entries.push(...value.filter((item): item is string => typeof item === 'string'));
  };

  add(toml.preload);
  add((toml.test as Record<string, unknown> | undefined)?.preload);

  return entries;
}

function checkBunfigs(root: string, findings: Finding[]): void {
  const selector = resolve(root, SELECTOR);

  for (const file of listFiles(root, (relPath) => relPath.endsWith('bunfig.toml'))) {
    const relPath = rel(root, file);
    const entries = preloadEntries(Bun.TOML.parse(readFileSync(file, 'utf8')) as Record<string, unknown>);
    const report = (rule: string, message: string): void => {
      findings.push({ check: 'manifests', rule, file: relPath, message });
    };

    if (relPath === 'bunfig.toml' && entries.length > 0) {
      report('root-preload', 'the root bunfig.toml must not preload anything (generated entries run there)');
      continue;
    }

    for (const entry of entries) {
      const target = resolve(dirname(file), entry);
      const targetRel = rel(root, target);

      if (target === selector) continue;

      if (targetRel.startsWith('../') || under(targetRel, 'adapters/')) {
        report('preload-target', `preload '${entry}' resolves to ${targetRel}`);
        continue;
      }

      if (!existsSync(target)) {
        report('preload-target', `preload '${entry}' does not exist`);
        continue;
      }

      const inner = [...checkImportsInFile(root, target), ...checkIdentityFiles(root, [target])];

      for (const finding of inner) {
        report('preload-target', `preload '${entry}' fails ${finding.check}/${finding.rule}: ${finding.message}`);
      }
    }
  }
}

export function checkManifests(root: string): Finding[] {
  const findings: Finding[] = [];

  checkConformance(root, findings);

  if (existsSync(join(root, ECOSYSTEM))) checkDependencies(readJson(join(root, ECOSYSTEM)), ECOSYSTEM, findings);

  checkBunfigs(root, findings);

  return findings;
}
