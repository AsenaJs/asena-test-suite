import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { type Finding, rel, sourceFiles, suiteRoot } from './common.ts';
import { type FlagInputs, judgeFlags, loadFlagInputs } from './flags.ts';
import { checkIdentity } from './identity.ts';
import { checkImports } from './imports.ts';
import { checkManifests } from './manifests.ts';
import { type Case, type ParityInputs, judgeParity, readJunit, runRogueEntries } from './parity.ts';

const fixtures = join(import.meta.dir, 'fixtures');

function rulesFor(findings: Finding[], file: string): string[] {
  return findings.filter((finding) => finding.file === file).map((finding) => finding.rule);
}

function expectRuleCases(check: (root: string) => Finding[], dir: string, cases: Record<string, string>): void {
  const bad = join(fixtures, dir, 'bad');
  const clean = join(fixtures, dir, 'clean');
  const findings = check(bad);

  for (const [file, rule] of Object.entries(cases)) {
    it(`${file} is reported as ${rule}`, () => {
      expect(rulesFor(findings, file)).toContain(rule);
    });
  }

  it('every negative fixture file has a case and is reported', () => {
    expect(
      sourceFiles(bad)
        .map((file) => rel(bad, file))
        .sort(),
    ).toEqual(Object.keys(cases).sort());
    expect([...new Set(findings.map((finding) => finding.file))].sort()).toEqual(Object.keys(cases).sort());
  });

  it('the clean twin passes', () => {
    expect(check(clean)).toEqual([]);
  });
}

describe('imports (bit 1)', () => {
  expectRuleCases(checkImports, 'imports', {
    'packages/conformance/src/areas/forbidden/scenarios.ts': 'forbidden-specifier',
    'packages/conformance/src/areas/typehono/scenarios.ts': 'forbidden-specifier',
    'packages/conformance/src/areas/outside/scenarios.ts': 'outside-root',
    'packages/conformance/src/areas/adapters/scenarios.ts': 'adapters-import',
    'ecosystem/modules/adapters/a.ts': 'adapters-import',
    'ecosystem/modules/computed/a.ts': 'computed-load',
    'ecosystem/modules/resolve/a.ts': 'computed-load',
    'packages/conformance/src/areas/rawit/scenarios.ts': 'raw-test-registration',
    'packages/conformance/test/rawtest.ts': 'raw-test-registration',
    'packages/conformance/src/areas/tools/scenarios.ts': 'packaging',
    'packages/conformance/src/areas/bare/scenarios.ts': 'packaging',
    'packages/conformance/src/areas/zodstatic/scenarios.ts': 'zod-static',
    'packages/conformance/src/areas/zodfixture/scenarios.ts': 'zod-fixture-static',
    'ecosystem/modules/deep/a.ts': 'ecosystem-deep-import',
    'ecosystem/modules/subpath/a.ts': 'ecosystem-deep-import',
    'packages/conformance/src/areas/maintainer/scenarios.ts': 'maintainer-import',
  });
});

describe('identity (bit 2)', () => {
  expectRuleCases(checkIdentity, 'identity', {
    'ecosystem/modules/lit-package/a.ts': 'identity-literal',
    'ecosystem/modules/lit-class/a.ts': 'identity-literal',
    'ecosystem/modules/lit-regex/a.ts': 'identity-literal',
    'ecosystem/modules/lit-template/a.ts': 'identity-literal',
    'ecosystem/src/env.ts': 'adapter-env-read',
    'packages/conformance/src/areas/descriptor-id/scenarios.ts': 'descriptor-identity-read',
    'packages/conformance/src/areas/destructure/scenarios.ts': 'descriptor-identity-read',
    'packages/conformance/src/bootlike.ts': 'descriptor-identity-read',
    'packages/conformance/src/areas/adapter-name/scenarios.ts': 'adapter-name-read',
    'packages/conformance/src/areas/adapter-ctor/scenarios.ts': 'adapter-name-read',
    'packages/conformance/src/areas/lifecycle/fixtures/nameProbe.ts': 'adapter-name-read',
    'packages/conformance/src/areas/tag-compare/scenarios.ts': 'tag-flow',
    'packages/conformance/src/areas/tag-variable/scenarios.ts': 'tag-flow',
    'packages/conformance/src/areas/tag-map/scenarios.ts': 'tag-flow',
    'packages/conformance/src/areas/root-includes/scenarios.ts': 'tag-flow',
    'packages/conformance/src/areas/enum-values/scenarios.ts': 'descriptor-enumeration',
    'packages/conformance/src/areas/enum-json/scenarios.ts': 'descriptor-enumeration',
    'packages/conformance/src/areas/cast-any/scenarios.ts': 'contract-cast',
    'packages/conformance/src/areas/cli-outside/scenarios.ts': 'optional-member-read',
  });
});

describe('manifests (bit 4)', () => {
  const cases: Record<string, string> = {
    'dev-adapter': 'adapter-dependency',
    'zod-hard-peer': 'zod-placement',
    'files-src': 'package-files',
    'exports-src': 'package-exports',
    'preload-adapters': 'preload-target',
    'root-preload': 'root-preload',
  };

  for (const [dir, rule] of Object.entries(cases)) {
    it(`${dir} is reported as ${rule}`, () => {
      expect(checkManifests(join(fixtures, 'manifests', dir)).map((finding) => finding.rule)).toEqual([rule]);
    });
  }

  it('the clean twin passes (selector preload relative to each bunfig, top-level and [test])', () => {
    expect(checkManifests(join(fixtures, 'manifests', 'clean'))).toEqual([]);
  });
});

describe('flags (bit 16)', () => {
  const root = join(fixtures, 'flags', 'clean');
  const plans = join(fixtures, 'flags', 'plans');
  const copy = <T>(value: T): T => {
    if (Array.isArray(value)) return value.map(copy) as T;
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) as T;
    }

    return value;
  };
  const load = async (): Promise<FlagInputs> => copy(await loadFlagInputs(root, plans));
  const rules = (inputs: FlagInputs): string[] => judgeFlags(inputs).map((finding) => finding.rule);

  it('the clean fixture passes, including the plans task lookup', async () => {
    expect(judgeFlags(await load())).toEqual([]);
  });

  it('an optional flag without a contract citation fails', async () => {
    const inputs = await load();

    delete inputs.registry['optional.builtinCors'].contract;
    expect(rules(inputs)).toEqual(['optional-contract']);
  });

  it('a citation of a required member (registerHTMLRoute) fails; onNotFound passes', async () => {
    const inputs = await load();

    inputs.registry['optional.notFoundHook'].contract = {
      kind: 'member',
      file: 'lib/adapter/AsenaAdapter.ts',
      member: 'AsenaAdapter.registerHTMLRoute',
    };
    expect(judgeFlags(inputs).map((finding) => finding.message)).toEqual([
      "optional.notFoundHook: AsenaAdapter.registerHTMLRoute is declared without '?' in lib/adapter/AsenaAdapter.ts (a required member cannot be an optional flag)",
    ]);
  });

  it('a divergence flag without a convergence WP fails', async () => {
    const inputs = await load();

    delete inputs.registry['routing.trailingSlashAlias'].convergence;
    expect(rules(inputs)).toEqual(['divergence-convergence']);
  });

  it('a missing convergence task file fails when a plans dir is given', async () => {
    const inputs = await load();

    inputs.plansDir = join(fixtures, 'flags', 'clean');
    expect(rules(inputs)).toEqual(['convergence-task']);
  });

  it('a first-party descriptor with an optional flag false fails', async () => {
    const inputs = await load();

    (inputs.descriptors.first.descriptor.capabilities as Record<string, boolean>)['optional.unixSocket'] = false;
    expect(rules(inputs)).toEqual(['first-party-optional']);
  });

  it('a divergence key in capabilities fails', async () => {
    const inputs = await load();

    (inputs.descriptors.second.descriptor.capabilities as Record<string, boolean>)['routing.trailingSlashAlias'] = true;
    expect(rules(inputs)).toEqual(['descriptor-shape']);
  });

  it('a missing optional key or an unknown descriptor key fails', async () => {
    const inputs = await load();

    delete (inputs.descriptors.second.descriptor.capabilities as Record<string, boolean>)['optional.unixSocket'];
    inputs.descriptors.first.descriptor.strict = false;
    expect(rules(inputs)).toEqual(['descriptor-shape', 'descriptor-shape']);
  });

  it('a divergences map naming an unknown flag or a non-false value fails', async () => {
    const inputs = await load();

    inputs.descriptors.second.divergences = { 'ws.unknownFlag': false, 'routing.trailingSlashAlias': true };
    expect(rules(inputs)).toEqual(['divergence-map', 'divergence-map']);
  });

  it('a CONVERGENCE.md row for a flag no divergences map declares fails', async () => {
    const inputs = await load();

    inputs.descriptors.first.divergences = {};
    expect(rules(inputs)).toEqual(['convergence-row']);
  });

  it('a declared divergence flag without a CONVERGENCE.md row or justification fails', async () => {
    const inputs = await load();
    const empty = { ...inputs, convergence: inputs.convergence.replace('the first adapter 404s `/x/`', '') };

    expect(rules({ ...inputs, convergence: '' })).toEqual(['convergence-row']);
    expect(rules(empty)).toEqual(['convergence-row']);
  });
});

describe('parity judge (bit 8)', () => {
  const parity = join(fixtures, 'parity');
  const fresh = (): ParityInputs => ({
    p1: { a: readJunit(join(parity, 'p1-a.xml')), b: readJunit(join(parity, 'p1-b.xml')) },
    p2: { a: readJunit(join(parity, 'p2.xml')), b: readJunit(join(parity, 'p2.xml')) },
    entry: { a: readJunit(join(parity, 'entry.xml')), b: readJunit(join(parity, 'entry.xml')) },
    rogue: [{ label: 'rogue', exitCode: 1, cases: readJunit(join(parity, 'rogue.xml')) }],
    divergences: { a: {}, b: { 'routing.trailingSlashAlias': false } },
  });
  const rules = (inputs: ParityInputs): string[] => judgeParity(inputs).findings.map((finding) => finding.rule);
  const find = (cases: Case[], id: string): Case => cases.find((testCase) => testCase.name.startsWith(`[${id}]`))!;

  it('parses bun junit: nested suites, skips, failures and entities', () => {
    const cases = readJunit(join(parity, 'p2.xml'));

    expect(cases.map((testCase) => testCase.status)).toEqual(['pass', 'skip', 'pass', 'pass']);
    expect(cases[3].name).toBe('[P2.openapi.001] the contract is honoured & <served>');
    expect(find(readJunit(join(parity, 'entry.xml')), 'P1.routing.040').message).toStartWith('expect(received)');
  });

  it('the clean fixture passes: nested P2 ID, declared divergence tag, [svc:] skip, real entry failure counted', () => {
    const result = judgeParity(fresh());

    expect(result.findings).toEqual([]);
    expect(result.otherFailures).toBe(2);
  });

  it('differing P1 ID sets fail', () => {
    const inputs = fresh();

    inputs.p1.b = inputs.p1.b.filter((testCase) => !testCase.name.startsWith('[P1.smoke.001]'));
    expect(rules(inputs)).toContain('id-set-mismatch');
  });

  it('an entry run missing an ID fails', () => {
    const inputs = fresh();

    inputs.entry.a = inputs.entry.a.slice(1);
    expect(rules(inputs)).toEqual(['entry-id-mismatch']);
  });

  it('a test name without an ID fails', () => {
    const inputs = fresh();

    inputs.p2.a.push({ ...inputs.p2.a[0], name: 'resolves one core' });
    expect(rules(inputs)).toEqual(['id-grammar']);
  });

  it('a second segment that does not match the area or module directory fails', () => {
    const inputs = fresh();

    find(inputs.p1.a, 'P1.smoke.001').classname = 'routing';
    find(inputs.p2.b, 'P2.microservice.contract.memory.C01').file = 'modules/redis/contract.test.ts';
    expect(rules(inputs)).toEqual(['id-segment', 'id-segment']);
  });

  it('a duplicate ID fails', () => {
    const inputs = fresh();

    inputs.p1.a.push({ ...find(inputs.p1.a, 'P1.smoke.001') });
    expect(rules(inputs)).toContain('id-duplicate');
  });

  it('a skipped test without a tag fails', () => {
    const inputs = fresh();

    find(inputs.p1.a, 'P1.smoke.001').status = 'skip';
    find(inputs.p1.b, 'P1.smoke.001').status = 'skip';
    expect(rules(inputs)).toEqual(['skip-untagged', 'skip-untagged']);
  });

  it('a skipped divergence-tagged test fails; with [svc:redis] it passes', () => {
    const inputs = fresh();
    const gated = find(inputs.p1.b, 'P1.routing.040');

    gated.status = 'skip';
    expect(rules(inputs)).toEqual(['skip-untagged', 'divergence-skipped']);

    gated.name += ' [svc:redis]';
    expect(rules(inputs)).toEqual([]);
  });

  it('a divergence tag the adapter does not declare fails', () => {
    const inputs = fresh();

    find(inputs.p1.a, 'P1.routing.040').name += ' [cap:routing.trailingSlashAlias]';
    expect(rules(inputs)).toEqual(['undeclared-divergence']);
  });

  it('[cap:optional.*] and [cap:member:*] in a first-party run fail; a member tag beside a declared divergence passes', () => {
    const inputs = fresh();

    find(inputs.p1.a, 'P1.lifecycle.004').name += ' [cap:optional.unixSocket]';
    find(inputs.p1.a, 'P1.smoke.001').name += ' [cap:member:builtins.cors]';
    find(inputs.p1.b, 'P1.routing.040').name += ' [cap:member:cliTemplate]';
    expect(rules(inputs).sort()).toEqual(['first-party-member-skip', 'first-party-optional-skip']);
  });

  it('a STALE FLAG failure and an UNEXPECTED (flag failure fail', () => {
    const inputs = fresh();
    const gated = find(inputs.p1.b, 'P1.routing.040');

    gated.status = 'fail';
    gated.message = 'STALE FLAG routing.trailingSlashAlias P1.routing.040: scenario passed';
    expect(rules(inputs)).toEqual(['stale-flag']);

    gated.message = 'UNEXPECTED (flag routing.trailingSlashAlias) P1.routing.040: x is not a function';
    expect(rules(inputs)).toEqual(['wrong-cause']);
  });

  it('a declared-false flag no test carries is a dead flag', () => {
    const inputs = fresh();

    find(inputs.p1.b, 'P1.routing.040').name = '[P1.routing.040] trailing slash alias';
    expect(rules(inputs)).toEqual(['dead-flag']);
  });

  it('a run that wrote no junit report fails instead of counting as an empty set', () => {
    const inputs = fresh();

    inputs.missingReports = ['out/p1-b.xml'];
    expect(rules(inputs)).toEqual(['missing-report']);
  });

  it('a rogue entry whose guard passed, or that exited 0, fails', () => {
    const inputs = fresh();

    find(inputs.rogue[0].cases, 'P1.resolution.010').status = 'pass';
    inputs.rogue[0].exitCode = 0;
    expect(rules(inputs)).toEqual(['rogue-exit', 'rogue-not-flagged']);
  });
});

describe('rogue entries (real runs)', () => {
  it('both rogue entries exit non-zero with P1.resolution.010 failing NOT-CONFORMANT', () => {
    const rogue = runRogueEntries(suiteRoot);

    expect(rogue.map(({ label, exitCode }) => [label, exitCode === 0 ? 'exit 0' : 'non-zero'])).toEqual([
      ['rogue-runConformance', 'non-zero'],
      ['rogue-selector-path', 'non-zero'],
    ]);
    expect(judgeParity({ p1: {}, p2: {}, entry: {}, rogue, divergences: {} }).findings).toEqual([]);
  }, 120_000);
});
