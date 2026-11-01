import { realpathSync } from 'node:fs';
import { divergenceFlags } from './capabilities.ts';
import type { AdapterDescriptor, DivergenceFlag } from './descriptor.ts';

export interface MaintainerSelection {
  tag: string;
  divergences: Partial<Record<DivergenceFlag, false>>;
  mixed: AdapterDescriptor[];
}

const off = new Set<DivergenceFlag>();
let tag: string | undefined;
let mixed: AdapterDescriptor[] = [];
const violations: string[] = [];

function installedCopy(): boolean {
  try {
    return realpathSync(import.meta.path)
      .split(/[\\/]/)
      .includes('node_modules');
  } catch {
    return true;
  }
}

export function applyMaintainerSelection(selection: MaintainerSelection): void {
  if (installedCopy()) {
    violations.push('maintainer selection from an installed package');

    return;
  }

  off.clear();

  for (const [flag, value] of Object.entries(selection.divergences)) {
    if (!(divergenceFlags as readonly string[]).includes(flag)) {
      violations.push(`divergences map names unknown flag '${flag}'`);
      continue;
    }

    if (value !== false) {
      violations.push(`divergences map sets '${flag}' to ${String(value)} (only false is allowed)`);
      continue;
    }

    off.add(flag as DivergenceFlag);
  }

  tag = selection.tag;
  mixed = [...selection.mixed];
}

export function divergenceOff(flag: DivergenceFlag): boolean {
  return off.has(flag);
}

export function maintainerTag(): string | undefined {
  return tag;
}

export function maintainerMixed(): readonly AdapterDescriptor[] {
  return mixed;
}

export function maintainerViolations(): readonly string[] {
  return violations;
}
