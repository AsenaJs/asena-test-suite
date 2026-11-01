import { expect } from 'bun:test';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { adapterPackageRoot, bootApp, scenario } from '@asenajs/adapter-conformance';
import { LOGGER_PROBE, type LoggerProbe, loggerProbeComponents } from './fixtures/loggerProbe.ts';

const ECOSYSTEM_PACKAGES = [
  '@asenajs/asena-logger',
  '@asenajs/asena-drizzle',
  '@asenajs/asena-redis',
  '@asenajs/asena-kafka',
  '@asenajs/asena-otel',
  '@asenajs/asena-openapi',
  '@asenajs/asena-cli',
];

function coreFrom(from: string): string {
  return realpathSync(Bun.resolveSync('@asenajs/asena/package.json', from));
}

function installedPackage(name: string, start: string): string {
  for (let dir = start; ; dir = dirname(dir)) {
    const manifest = join(dir, 'node_modules', name, 'package.json');

    if (existsSync(manifest)) return realpathSync(manifest);
    if (dirname(dir) === dir) throw new Error(`${name} is not installed above ${start}`);
  }
}

scenario('P2.resolution.001', 'every ecosystem package and the adapter resolve the same @asenajs/asena', () => {
  const ecosystemDir = dirname(import.meta.dir);
  const expected = coreFrom(ecosystemDir);
  const seen = new Map<string, string>([['ecosystem workspace', expected]]);

  for (const name of ECOSYSTEM_PACKAGES) {
    seen.set(name, coreFrom(installedPackage(name, ecosystemDir)));
  }

  seen.set('adapter', coreFrom(join(adapterPackageRoot(), 'package.json')));

  expect(Object.fromEntries(seen)).toEqual(Object.fromEntries([...seen.keys()].map((key) => [key, expected] as const)));
});

scenario('P2.resolution.002', '@PostConstruct runs on a component injecting an asena-logger service', async () => {
  await using app = await bootApp({ components: loggerProbeComponents() });
  const probe = await app.resolve<LoggerProbe>(LOGGER_PROBE);

  expect(probe.hookCalls).toBe(1);
  expect(probe.injectedIsAsenaLogger).toBe(true);
});
