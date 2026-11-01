import { realpathSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';
import type { AdapterDescriptor, DivergenceFlag } from '../packages/conformance/src/descriptor.ts';
import { setDescriptor } from '../packages/conformance/src/load.ts';
import { applyMaintainerSelection } from '../packages/conformance/src/maintainer.ts';

interface DescriptorModule {
  default?: AdapterDescriptor;
  descriptor?: AdapterDescriptor;
  divergences?: Partial<Record<DivergenceFlag, false>>;
}

interface Selected {
  tag: string;
  descriptor: AdapterDescriptor;
  divergences?: Partial<Record<DivergenceFlag, false>>;
  maintainer: boolean;
}

const adaptersDir = realpathSync(join(import.meta.dir, '..', 'adapters'));

async function select(name: string): Promise<Selected> {
  let mod: DescriptorModule;
  let tag: string;
  let maintainer: boolean;

  if (name === 'ergenecore') {
    mod = await import('../adapters/ergenecore.ts');
    tag = name;
    maintainer = true;
  } else if (name === 'hono') {
    mod = await import('../adapters/hono.ts');
    tag = name;
    maintainer = true;
  } else {
    const path = realpathSync(isAbsolute(name) ? name : resolve(process.cwd(), name));

    mod = (await import(path)) as DescriptorModule;
    tag = basename(path, extname(path));
    maintainer = path.startsWith(adaptersDir + sep);
  }

  const descriptor = mod.default ?? mod.descriptor;

  if (!descriptor) {
    throw new Error(`ASENA_ADAPTER=${name}: the module exports neither a default nor a 'descriptor' descriptor`);
  }

  return { tag, descriptor, divergences: mod.divergences, maintainer };
}

const selected = process.env.ASENA_ADAPTER?.trim();

if (selected) {
  const main = await select(selected);

  if (main.maintainer) {
    const mixedNames = (process.env.ASENA_SUITE_MIXED ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const mixed: AdapterDescriptor[] = [];

    for (const mixedName of mixedNames) mixed.push((await select(mixedName)).descriptor);

    setDescriptor(main.descriptor);
    applyMaintainerSelection({ tag: main.tag, divergences: main.divergences ?? {}, mixed });
  } else {
    setDescriptor({ ...main.descriptor, ...(main.divergences ? { divergences: main.divergences } : {}) });
    applyMaintainerSelection({ tag: main.tag, divergences: {}, mixed: [] });
  }
}
