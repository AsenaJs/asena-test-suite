import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectedCoreRange, localSpecs, portableOverrides } from '../../ecosystem/modules/cli/specs.ts';

const root = mkdtempSync(join(tmpdir(), 'asena-cli-specs-'));
const manifestPath = join(root, 'package.json');

writeFileSync(
  manifestPath,
  JSON.stringify({
    devDependencies: { '@asenajs/asena': 'file:./.local-packs/core.tgz', zod: '^4.3.6' },
    overrides: { '@asenajs/asena': 'file:./.local-packs/core.tgz', hono: '/abs/hono.tgz', zod: '^4.3.6' },
  }),
);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('cli project specs', () => {
  it('resolves relative file: dependencies against the manifest directory', () => {
    expect(localSpecs(manifestPath)).toEqual(
      new Map([['@asenajs/asena', `file:${join(root, '.local-packs/core.tgz')}`]]),
    );
  });

  it('resolves relative file: overrides against the manifest directory and keeps the rest', () => {
    expect(portableOverrides(manifestPath)).toEqual({
      '@asenajs/asena': `file:${join(root, '.local-packs/core.tgz')}`,
      hono: '/abs/hono.tgz',
      zod: '^4.3.6',
    });
  });

  it('expects the installed suite core version when the core override is a file: spec', () => {
    const range = expectedCoreRange('file:./.local-packs/core.tgz', '0.12.1');

    expect(range).toBe('0.12.1');
    expect(Bun.semver.satisfies('0.12.1', range)).toBe(true);
  });

  it('keeps a semver core override as the expected range', () => {
    expect(expectedCoreRange('^0.12.1', '0.12.1')).toBe('^0.12.1');
  });
});
