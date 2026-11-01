import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { capabilities, divergenceFlags, optionalFlags } from './capabilities.ts';
import type { AdapterDescriptor, CapabilityFlag, DescriptorMember, DivergenceFlag } from './descriptor.ts';
import { divergenceOff, maintainerMixed, maintainerTag, maintainerViolations } from './maintainer.ts';

const KNOWN_KEYS = new Set([
  'id',
  'packageName',
  'packageRoot',
  'createAdapter',
  'defineContext',
  'cliTemplate',
  'builtins',
  'capabilities',
]);

let current: AdapterDescriptor | undefined;
let violations: string[] = [];

function fail(message: string): never {
  throw new TypeError(`setDescriptor: ${message}`);
}

export function setDescriptor(descriptor: AdapterDescriptor): void {
  if (descriptor === null || typeof descriptor !== 'object') fail('the descriptor must be an object');

  const found: string[] = [];
  const raw = descriptor as unknown as Record<string, unknown>;

  if (typeof raw.id !== 'string' || raw.id.length === 0) fail('`id` must be a non-empty string');
  if (typeof raw.packageName !== 'string' || raw.packageName.length === 0) {
    fail('`packageName` must be a non-empty string');
  }
  if (raw.packageRoot !== undefined && typeof raw.packageRoot !== 'string') fail('`packageRoot` must be a string');
  if (typeof raw.createAdapter !== 'function') fail('`createAdapter` must be a function');
  if (typeof raw.defineContext !== 'function') fail('`defineContext` must be a function');
  if (raw.cliTemplate !== undefined && typeof raw.cliTemplate !== 'string') fail('`cliTemplate` must be a string');

  const builtins = raw.builtins as Record<string, unknown> | undefined;

  if (builtins !== undefined) {
    if (builtins === null || typeof builtins !== 'object') fail('`builtins` must be an object');

    for (const key of Object.keys(builtins)) {
      if (key !== 'cors' && key !== 'rateLimiter') found.push(`unknown builtins key '${key}'`);
      else if (builtins[key] !== undefined && typeof builtins[key] !== 'function') {
        fail(`\`builtins.${key}\` must be a function`);
      }
    }
  }

  for (const key of Object.keys(raw)) {
    if (key === 'divergences') found.push('divergences');
    else if (!KNOWN_KEYS.has(key)) found.push(`unknown descriptor key '${key}'`);
  }

  const caps = raw.capabilities as Record<string, unknown> | undefined;

  if (caps === null || typeof caps !== 'object') fail('`capabilities` must be an object');

  for (const flag of optionalFlags) {
    if (!(flag in caps)) fail(`capabilities.'${flag}' is missing`);
    if (typeof caps[flag] !== 'boolean') fail(`capabilities.'${flag}' must be a boolean`);
  }

  for (const key of Object.keys(caps)) {
    if ((divergenceFlags as readonly string[]).includes(key)) found.push(`capabilities.${key}`);
    else if (!(optionalFlags as readonly string[]).includes(key)) found.push(`unknown capability '${key}'`);
  }

  if (caps['optional.builtinCors'] === true && typeof builtins?.cors !== 'function') {
    fail("capabilities.'optional.builtinCors' is true but builtins.cors is missing");
  }
  if (caps['optional.builtinRateLimiter'] === true && typeof builtins?.rateLimiter !== 'function') {
    fail("capabilities.'optional.builtinRateLimiter' is true but builtins.rateLimiter is missing");
  }

  current = descriptor;
  violations = found;
}

export function getDescriptor(): AdapterDescriptor {
  if (!current) {
    throw new Error(
      'No adapter descriptor is set. Adapter authors: call runConformance(descriptor) from ' +
        '@asenajs/adapter-conformance in your test file. Suite maintainers: set ASENA_ADAPTER=<name|path> ' +
        '(the bunfig preload tools/select-adapter.ts applies it).',
    );
  }

  return current;
}

function forced(): Set<string> {
  const value = process.env.ASENA_SUITE_FORCE_CAPS ?? '';

  return new Set(
    value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

export function isOn(flag: CapabilityFlag): boolean {
  const entry = capabilities[flag];

  if (!entry) throw new Error(`Unknown capability flag '${String(flag)}'`);
  if (forced().has(flag)) return true;
  if (entry.kind === 'divergence') return !divergenceOff(flag as DivergenceFlag);

  return getDescriptor().capabilities[flag as keyof AdapterDescriptor['capabilities']];
}

export function hasMember(member: DescriptorMember): boolean {
  const descriptor = getDescriptor();

  switch (member) {
    case 'cliTemplate':
      return typeof descriptor.cliTemplate === 'string' && descriptor.cliTemplate.length > 0;
    case 'builtins.cors':
      return typeof descriptor.builtins?.cors === 'function';
    case 'builtins.rateLimiter':
      return typeof descriptor.builtins?.rateLimiter === 'function';
    default:
      throw new Error(`Unknown descriptor member '${String(member)}'`);
  }
}

export function runTag(): string {
  const tag = maintainerTag() ?? getDescriptor().id;
  const sanitised = tag
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return sanitised || 'adapter';
}

export function adapterPackageRoot(): string {
  const descriptor = getDescriptor();

  if (descriptor.packageRoot) return descriptor.packageRoot;

  try {
    return dirname(Bun.resolveSync(`${descriptor.packageName}/package.json`, process.cwd()));
  } catch {
    let dir = process.cwd();

    for (;;) {
      const manifest = join(dir, 'package.json');

      if (existsSync(manifest)) {
        try {
          const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown };

          if (parsed.name === descriptor.packageName) return dir;
        } catch {
          // An unreadable manifest is not the adapter's; keep walking up.
        }
      }

      const parent = dirname(dir);

      if (parent === dir) break;
      dir = parent;
    }
  }

  throw new Error(
    `Cannot locate the adapter package '${descriptor.packageName}' from ${process.cwd()}. ` +
      'Pass packageRoot: import.meta.dir in the descriptor given to runConformance().',
  );
}

export function mixedDescriptors(): readonly AdapterDescriptor[] {
  return maintainerMixed();
}

export function conformanceViolations(): readonly string[] {
  return [...violations, ...maintainerViolations()];
}
