import { expect } from 'bun:test';
import { join } from 'node:path';
import { adapterPackageRoot, getDescriptor, runTag, scenario } from '@asenajs/adapter-conformance';

const honoured = 'the contract is honoured; honour it; Honouring';

function hasMember(member: string): boolean {
  return member.length > 0;
}

function label(tag: string): string {
  return `label-${tag}`;
}

interface User {
  id: string;
}

export function register(user: User): void {
  scenario(
    'P1.x.001',
    'members-gated optional read',
    () => {
      expect(typeof getDescriptor().cliTemplate).toBe('string');
      expect(getDescriptor().builtins!.cors).toBeDefined();
    },
    { members: ['cliTemplate', 'builtins.cors'] },
  );

  scenario('P1.x.002', 'tags only inside strings and paths', () => {
    const namespace = `asena_${runTag()}_${process.pid}`;
    const manifest = join(adapterPackageRoot(), 'package.json');
    const prefix = 'p-' + runTag();

    expect([namespace, manifest, prefix, label(runTag()), honoured, hasMember('cliTemplate'), user.id]).toHaveLength(7);
  });
}
