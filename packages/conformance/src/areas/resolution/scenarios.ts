import { expect } from 'bun:test';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { bootApp } from '../../boot.ts';
import { adapterPackageRoot, conformanceViolations } from '../../load.ts';
import { area, scenario } from '../../scenario.ts';
import { runDecoratorProbe } from './fixtures/decoratorProbe.ts';
import {
  POST_CONSTRUCT_PROBE,
  type PostConstructProbe,
  postConstructProbeClass,
} from './fixtures/postConstructProbe.ts';

const packageRoot = join(import.meta.dir, '..', '..', '..');

function coreManifestFrom(dir: string): string {
  return realpathSync(Bun.resolveSync('@asenajs/asena/package.json', dir));
}

export function register(): void {
  area('resolution', () => {
    scenario('P1.resolution.001', 'one @asenajs/asena copy for the conformance package and the adapter', () => {
      const fromConformance = coreManifestFrom(import.meta.dir);
      const fromAdapter = coreManifestFrom(adapterPackageRoot());

      expect(fromAdapter).toBe(fromConformance);
    });

    scenario('P1.resolution.002', '@PostConstruct runs in an app booted with the adapter', async () => {
      await using app = await bootApp({ components: [postConstructProbeClass()] });
      const probe = await app.resolve<PostConstructProbe>(POST_CONSTRUCT_PROBE);

      expect(probe.hookCalls).toBe(1);
    });

    scenario('P1.resolution.003', 'installed core satisfies the conformance peer range', async () => {
      const manifest = (await Bun.file(join(packageRoot, 'package.json')).json()) as {
        peerDependencies?: Record<string, string>;
      };
      const range = manifest.peerDependencies?.['@asenajs/asena'];
      const core = (await Bun.file(coreManifestFrom(import.meta.dir)).json()) as { version: string };

      expect(range).toBeString();
      expect(`${core.version} satisfies ${range}: ${Bun.semver.satisfies(core.version, range!)}`).toBe(
        `${core.version} satisfies ${range}: true`,
      );
    });

    scenario('P1.resolution.004', 'conformance fixtures carry legacy decorator metadata', () => {
      const probe = runDecoratorProbe();

      if (probe.methodDecoratorArgs !== 3 || !Array.isArray(probe.paramTypes)) {
        throw new Error(
          'NOT-CONFIGURED: conformance fixtures were compiled without experimentalDecorators/emitDecoratorMetadata ' +
            `(method decorator arguments: ${probe.methodDecoratorArgs}, design:paramtypes: ${String(probe.paramTypes)})`,
        );
      }

      expect(probe.methodDecoratorArgs).toBe(3);
      expect(probe.paramTypes).toBeArrayOfSize(1);
    });

    scenario('P1.resolution.010', 'the descriptor declares no divergence flags or unknown keys', () => {
      const violations = conformanceViolations();

      if (violations.length > 0) {
        throw new Error(
          `NOT-CONFORMANT: descriptor declares divergence flags or unknown keys: ${violations.join('; ')}`,
        );
      }
    });
  });
}
