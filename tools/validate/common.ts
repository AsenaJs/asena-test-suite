import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export const suiteRoot = resolve(import.meta.dir, '..', '..');

export interface Finding {
  check: 'imports' | 'identity' | 'manifests' | 'parity' | 'flags' | 'packed';
  rule: string;
  file: string;
  line?: number;
  message: string;
}

export const BITS = {
  imports: 1,
  identity: 2,
  manifests: 4,
  parity: 8,
  flags: 16,
  packed: 32,
} as const;

const ALWAYS_EXCLUDED = ['node_modules', '.local-packs', 'out', 'dist', '.git', '.glm-build'];
const FIXTURES = 'tools/validate/fixtures';

export const EXEMPT = [
  'adapters/',
  'tools/',
  'packages/conformance/src/load.ts',
  'packages/conformance/src/maintainer.ts',
  'packages/conformance/src/areas/resolution/',
  'packages/conformance/test/00-resolution.test.ts',
  'packages/conformance/examples/',
];

export function toPosix(path: string): string {
  return path.split(sep).join('/');
}

export function rel(root: string, file: string): string {
  return toPosix(relative(root, file));
}

export function under(relPath: string, prefix: string): boolean {
  return prefix.endsWith('/') ? relPath.startsWith(prefix) : relPath === prefix;
}

export function isExempt(relPath: string): boolean {
  return EXEMPT.some((prefix) => under(relPath, prefix));
}

export function listFiles(root: string, accept: (relPath: string) => boolean): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const relPath = rel(root, path);

      if (entry.isDirectory()) {
        if (ALWAYS_EXCLUDED.includes(entry.name) || relPath === FIXTURES) continue;
        walk(path);
      } else if (accept(relPath)) {
        found.push(path);
      }
    }
  };

  walk(root);

  return found.sort();
}

export function sourceFiles(root: string): string[] {
  return listFiles(root, (relPath) => /\.tsx?$/.test(relPath) && !relPath.endsWith('.d.ts'));
}

export function format(finding: Finding): string {
  const where = finding.line ? `${finding.file}:${finding.line}` : finding.file;

  return `${where} [${finding.check}/${finding.rule}] ${finding.message}`;
}
