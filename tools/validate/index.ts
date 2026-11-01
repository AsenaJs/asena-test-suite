import { BITS, type Finding, format, suiteRoot } from './common.ts';
import { checkFlags } from './flags.ts';
import { checkIdentity } from './identity.ts';
import { checkImports } from './imports.ts';
import { checkManifests } from './manifests.ts';
import { runParity } from './parity.ts';

const args = new Set(process.argv.slice(2).filter((arg) => arg !== '--'));
const unknown = [...args].filter((arg) => !['--fast', '--packed'].includes(arg));

if (unknown.length > 0) {
  console.error(`validate: unknown argument(s) ${unknown.join(' ')}; usage: bun run validate [-- --fast | --packed]`);
  process.exit(64);
}

if (args.has('--packed')) {
  console.log('validate: --packed (check 4b, bit 32) is not wired yet');
  process.exit(0);
}

let exitCode = 0;

function emit(name: keyof typeof BITS, findings: Finding[], note = ''): void {
  for (const finding of findings) console.log(format(finding));

  const status = findings.length === 0 ? 'ok' : `FAIL (${findings.length})`;

  console.log(`validate: check ${name} (bit ${BITS[name]}): ${status}${note}`);

  if (findings.length > 0) exitCode |= BITS[name];
}

emit('imports', checkImports(suiteRoot));
emit('identity', checkIdentity(suiteRoot));
emit('manifests', checkManifests(suiteRoot));
emit('flags', await checkFlags(suiteRoot));

if (!args.has('--fast')) {
  const parity = await runParity(suiteRoot);

  emit('parity', parity.findings, `; other failing tests: ${parity.otherFailures}`);
}

console.log(`validate: exit ${exitCode}`);
process.exit(exitCode);
