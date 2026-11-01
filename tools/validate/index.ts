import { BITS, type Finding, format, suiteRoot } from './common.ts';
import { checkFlags } from './flags.ts';
import { checkIdentity } from './identity.ts';
import { checkImports } from './imports.ts';
import { checkManifests } from './manifests.ts';
import { formatDifferences, resolveWorkspace, runPacked } from './packed/run.ts';
import { runParity } from './parity.ts';

const USAGE =
  'usage: bun run validate [-- --fast | --only <1|2|3|4|4b|5> | --packed] [--workspace <dir>] [--keep] (4b: --workspace, --keep)';
const CHECKS = ['1', '2', '3', '4', '4b', '5'] as const;

type Check = (typeof CHECKS)[number];

function parseArgs(argv: string[]): { checks: Set<Check>; workspace?: string; keep: boolean } {
  const rest = argv.filter((arg) => arg !== '--');
  let checks = new Set<Check>(['1', '2', '3', '5', '4', '4b']);
  let workspace: string | undefined;
  let keep = false;
  const only = new Set<Check>();

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];

    if (arg === '--fast') checks = new Set(['1', '2', '3', '5']);
    else if (arg === '--packed') only.add('4b');
    else if (arg === '--keep') keep = true;
    else if (arg === '--only' && CHECKS.includes(rest[index + 1] as Check)) only.add(rest[++index] as Check);
    else if (arg === '--workspace' && rest[index + 1]) workspace = rest[++index];
    else {
      console.error(`validate: unknown or incomplete argument '${arg}'; ${USAGE}`);
      process.exit(64);
    }
  }

  return { checks: only.size > 0 ? only : checks, workspace, keep };
}

const { checks, workspace: workspaceArg, keep } = parseArgs(process.argv.slice(2));
let exitCode = 0;

function emit(name: keyof typeof BITS, findings: Finding[], note = ''): void {
  for (const finding of findings) console.log(format(finding));

  const status = findings.length === 0 ? 'ok' : `FAIL (${findings.length})`;

  console.log(`validate: check ${name} (bit ${BITS[name]}): ${status}${note}`);

  if (findings.length > 0) exitCode |= BITS[name];
}

if (checks.has('1')) emit('imports', checkImports(suiteRoot));
if (checks.has('2')) emit('identity', checkIdentity(suiteRoot));
if (checks.has('3')) emit('manifests', checkManifests(suiteRoot));
if (checks.has('5')) emit('flags', await checkFlags(suiteRoot));

if (checks.has('4')) {
  const parity = await runParity(suiteRoot);

  emit('parity', parity.findings, `; other failing tests: ${parity.otherFailures}`);
}

if (checks.has('4b')) {
  const workspace = resolveWorkspace(suiteRoot, workspaceArg, process.env.ASENA_SUITE_WORKSPACE);
  const packed = await runPacked(suiteRoot, { workspace, keep, reuseP1: checks.has('4') });

  for (const leg of packed.legs) {
    console.log(
      `validate: packed ${leg.adapter} ${leg.variant} v${leg.version} (${leg.seconds.toFixed(1)} s): ` +
        `P1 ${leg.p1}, packed ${leg.packed}`,
    );
    console.log(`  expected divergence failures: ${leg.expectedFailures.join(', ') || '(none)'}`);
    for (const line of formatDifferences(leg.differences)) console.log(line);
  }

  if (keep) console.log(`validate: packed projects kept in ${packed.tmp}`);
  emit('packed', packed.findings, `; variant ${workspace ? `archive (${workspace})` : 'npm'}`);
}

console.log(`validate: exit ${exitCode}`);
process.exit(exitCode);
