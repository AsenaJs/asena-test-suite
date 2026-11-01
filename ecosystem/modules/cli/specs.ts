import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
}

export function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

export function packageVersion(manifestPath: string): string {
  return (JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string }).version;
}

function absoluteFileSpec(spec: string, manifestPath: string): string {
  const target = spec.slice('file:'.length);

  return `file:${isAbsolute(target) ? target : resolve(dirname(manifestPath), target)}`;
}

export function localSpecs(manifestPath: string): Map<string, string> {
  const manifest = readManifest(manifestPath);
  const specs = new Map<string, string>();

  for (const [name, spec] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    if (spec.startsWith('file:')) specs.set(name, absoluteFileSpec(spec, manifestPath));
  }

  return specs;
}

export function portableOverrides(manifestPath: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(readManifest(manifestPath).overrides ?? {}).map(([name, spec]) => [
      name,
      spec.startsWith('file:') ? absoluteFileSpec(spec, manifestPath) : spec,
    ]),
  );
}

export function expectedCoreRange(override: string, suiteCoreVersion: string): string {
  return override.startsWith('file:') ? suiteCoreVersion : override;
}
