import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { type Finding, suiteRoot } from './common.ts';

type Contract = { kind: 'member'; file: string; member: string | string[] } | { kind: 'non-member'; reason: string };

export interface RegistryEntry {
  kind: 'divergence' | 'optional';
  convergence?: string;
  contract?: Contract;
}

export interface DescriptorModule {
  descriptor: Record<string, unknown>;
  divergences: Record<string, unknown>;
}

export interface FlagInputs {
  registry: Record<string, RegistryEntry>;
  descriptors: Record<string, DescriptorModule>;
  convergence: string;
  coreDist: string;
  plansDir?: string;
}

const DESCRIPTOR_KEYS = new Set([
  'id',
  'packageName',
  'packageRoot',
  'createAdapter',
  'defineContext',
  'cliTemplate',
  'builtins',
  'capabilities',
]);

function convergenceRows(markdown: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();

  for (const line of markdown.split('\n')) {
    const cells = line
      .trim()
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const flag = /^`([^`]+)`$/.exec(cells[0] ?? '')?.[1];

    if (flag) rows.set(flag, cells);
  }

  return rows;
}

function optionalMemberDeclared(coreDist: string, file: string, member: string): string | undefined {
  const dts = join(coreDist, file.replace(/\.ts$/, '.d.ts'));

  if (!existsSync(dts)) return `${dts} does not exist in the installed core`;

  const dot = member.lastIndexOf('.');
  const container = member.slice(0, dot);
  const name = member.slice(dot + 1);
  const source = ts.createSourceFile(dts, readFileSync(dts, 'utf8'), ts.ScriptTarget.Latest, true);
  let members: ts.NodeArray<ts.ClassElement | ts.TypeElement> | undefined;

  for (const statement of source.statements) {
    if (
      (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
      statement.name?.text === container
    ) {
      members = statement.members;
    } else if (
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === container &&
      ts.isTypeLiteralNode(statement.type)
    ) {
      members = statement.type.members;
    }
  }

  if (!members) return `${container} is not declared in ${file}`;

  const declarations = members.filter(
    (element) =>
      element.name && (ts.isIdentifier(element.name) || ts.isStringLiteral(element.name)) && element.name.text === name,
  );

  if (declarations.length === 0) return `${member} is not declared in ${file}`;
  if (!declarations.every((element) => 'questionToken' in element && element.questionToken)) {
    return `${member} is declared without '?' in ${file} (a required member cannot be an optional flag)`;
  }

  return undefined;
}

export function judgeFlags(inputs: FlagInputs): Finding[] {
  const findings: Finding[] = [];
  const report = (rule: string, file: string, message: string): void => {
    findings.push({ check: 'flags', rule, file, message });
  };
  const registryFile = 'packages/conformance/src/capabilities.ts';
  const optional = Object.keys(inputs.registry).filter((flag) => inputs.registry[flag].kind === 'optional');
  const divergence = Object.keys(inputs.registry).filter((flag) => inputs.registry[flag].kind === 'divergence');
  const rows = convergenceRows(inputs.convergence);

  for (const flag of optional) {
    const contract = inputs.registry[flag].contract;

    if (!contract) {
      report('optional-contract', registryFile, `${flag} has no contract citation`);
      continue;
    }

    if (contract.kind === 'member') {
      for (const member of Array.isArray(contract.member) ? contract.member : [contract.member]) {
        const problem = optionalMemberDeclared(inputs.coreDist, contract.file, member);

        if (problem) report('optional-contract', registryFile, `${flag}: ${problem}`);
      }
    } else if (!contract.reason) {
      report('optional-contract', registryFile, `${flag}: non-member citation without a reason`);
    }
  }

  for (const flag of divergence) {
    const convergence = inputs.registry[flag].convergence;

    if (!convergence) {
      report('divergence-convergence', registryFile, `${flag} has no convergence WP`);
      continue;
    }

    const row = rows.get(flag);

    if (!row) report('convergence-row', 'CONVERGENCE.md', `${flag} has no row`);
    else if (!row[2]) report('convergence-row', 'CONVERGENCE.md', `${flag} has an empty justification`);

    if (inputs.plansDir && !existsSync(join(inputs.plansDir, 'tasks', `${convergence}.md`))) {
      report(
        'convergence-task',
        registryFile,
        `${flag}: ${join(inputs.plansDir, 'tasks', `${convergence}.md`)} is missing`,
      );
    }
  }

  const declared = new Set<string>();

  for (const [name, { descriptor, divergences }] of Object.entries(inputs.descriptors)) {
    const file = `adapters/${name}.ts`;
    const capabilities = (descriptor.capabilities ?? {}) as Record<string, unknown>;

    for (const key of Object.keys(descriptor)) {
      if (key === 'divergences') report('descriptor-shape', file, 'the descriptor carries divergences');
      else if (!DESCRIPTOR_KEYS.has(key)) report('descriptor-shape', file, `unknown descriptor key '${key}'`);
    }

    for (const flag of optional) {
      if (!(flag in capabilities)) report('descriptor-shape', file, `capabilities lacks '${flag}'`);
      else if (capabilities[flag] !== true) report('first-party-optional', file, `${flag} is not true`);
    }

    for (const key of Object.keys(capabilities)) {
      if (divergence.includes(key)) report('descriptor-shape', file, `capabilities carries divergence flag '${key}'`);
      else if (!optional.includes(key)) report('descriptor-shape', file, `unknown capability '${key}'`);
    }

    for (const [flag, value] of Object.entries(divergences)) {
      if (!divergence.includes(flag)) report('divergence-map', file, `divergences names unknown flag '${flag}'`);
      else if (value !== false) report('divergence-map', file, `divergences['${flag}'] is ${String(value)}, not false`);
      else declared.add(flag);
    }
  }

  for (const flag of rows.keys()) {
    if (!declared.has(flag))
      report('convergence-row', 'CONVERGENCE.md', `row for '${flag}' but no divergences map declares it`);
  }

  return findings;
}

export function installedCoreDist(root: string): string {
  for (let dir = root; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', '@asenajs', 'asena', 'dist');

    if (existsSync(candidate)) return realpathSync(candidate);
    if (dirname(dir) === dir) break;
  }

  if (root !== suiteRoot) return installedCoreDist(suiteRoot);

  throw new Error('flags: @asenajs/asena is not installed');
}

export async function loadFlagInputs(root: string, plansDir = process.env.ASENA_SUITE_PLANS_DIR): Promise<FlagInputs> {
  const registryModule = (await import(join(root, 'packages/conformance/src/capabilities.ts'))) as {
    capabilities: Record<string, RegistryEntry>;
  };
  const adaptersDir = join(root, 'adapters');
  const descriptors: Record<string, DescriptorModule> = {};

  for (const file of existsSync(adaptersDir) ? readdirSync(adaptersDir).sort() : []) {
    if (!file.endsWith('.ts')) continue;

    const mod = (await import(join(adaptersDir, file))) as {
      default: Record<string, unknown>;
      divergences?: Record<string, unknown>;
    };

    descriptors[file.replace(/\.ts$/, '')] = { descriptor: mod.default, divergences: mod.divergences ?? {} };
  }

  const convergencePath = join(root, 'CONVERGENCE.md');

  return {
    registry: registryModule.capabilities,
    descriptors,
    convergence: existsSync(convergencePath) ? readFileSync(convergencePath, 'utf8') : '',
    coreDist: installedCoreDist(root),
    plansDir: plansDir === '' ? undefined : plansDir,
  };
}

export async function checkFlags(root: string, plansDir?: string): Promise<Finding[]> {
  return judgeFlags(await loadFlagInputs(root, plansDir));
}
