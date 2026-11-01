import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import ts from 'typescript';
import { type Finding, rel, sourceFiles, under } from './common.ts';

interface Reference {
  specifier: string;
  line: number;
  kind: 'static' | 'type' | 'dynamic' | 'require';
}

const FORBIDDEN = /^(?:@asenajs\/ergenecore|@asenajs\/hono-adapter|hono|@hono\/[^/]+)(?:\/.*)?$/;
const BUILTINS = new Set(builtinModules);
const COMPUTED_EXEMPT = ['tools/', 'packages/conformance/src/areas/errors/secondCore.ts'];
const REGISTRATION_SCOPE = [
  'packages/conformance/src/areas/',
  'packages/conformance/test/',
  'ecosystem/modules/',
  'ecosystem/test/',
];
const ZOD_FIXTURE = /^packages\/conformance\/src\/areas\/[^/]+\/fixtures\/zod[^/]*\.ts$/;

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function literalText(node: ts.Node | undefined): string | undefined {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;

  return undefined;
}

function isPropertyCall(node: ts.CallExpression, object: string, name: string): boolean {
  const callee = node.expression;

  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === name &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === object
  );
}

function isImportMetaResolve(node: ts.CallExpression): boolean {
  const callee = node.expression;

  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'resolve' &&
    ts.isMetaProperty(callee.expression) &&
    callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

function collect(source: ts.SourceFile, relPath: string, findings: Finding[]): Reference[] {
  const refs: Reference[] = [];
  const computedAllowed = COMPUTED_EXEMPT.some((prefix) => under(relPath, prefix));
  const computed = (node: ts.Node, what: string): void => {
    if (computedAllowed) return;
    findings.push({
      check: 'imports',
      rule: 'computed-load',
      file: relPath,
      line: lineOf(source, node),
      message: `${what} with a non-literal argument`,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier ? literalText(node.moduleSpecifier) : undefined;

      if (specifier !== undefined) {
        const typeOnly = ts.isImportDeclaration(node) ? Boolean(node.importClause?.isTypeOnly) : node.isTypeOnly;

        refs.push({ specifier, line: lineOf(source, node), kind: typeOnly ? 'type' : 'static' });
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = literalText(node.moduleReference.expression);

      if (specifier !== undefined) refs.push({ specifier, line: lineOf(source, node), kind: 'require' });
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      const specifier =
        ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal) ? argument.literal.text : undefined;

      if (specifier !== undefined) refs.push({ specifier, line: lineOf(source, node), kind: 'type' });
    } else if (ts.isCallExpression(node)) {
      const first = node.arguments[0];
      const text = literalText(first);

      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (text === undefined) computed(node, 'import()');
        else refs.push({ specifier: text, line: lineOf(source, node), kind: 'dynamic' });
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        if (text === undefined) computed(node, 'require()');
        else refs.push({ specifier: text, line: lineOf(source, node), kind: 'require' });
      } else if (isPropertyCall(node, 'Bun', 'resolveSync') || isPropertyCall(node, 'Bun', 'resolve')) {
        if (text === undefined) computed(node, 'Bun.resolveSync()');
      } else if (isPropertyCall(node, 'require', 'resolve')) {
        if (text === undefined) computed(node, 'require.resolve()');
      } else if (isImportMetaResolve(node)) {
        if (text === undefined) computed(node, 'import.meta.resolve()');
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return refs;
}

function resolveTarget(root: string, file: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.') && !isAbsolute(specifier)) return undefined;

  const absolute = resolve(dirname(file), specifier);
  const relPath = rel(root, absolute);

  return relPath.replace(/\.([mc]?)js$/, '.$1ts');
}

function bareName(specifier: string): string {
  const parts = specifier.split('/');

  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function registrationViolations(source: ts.SourceFile, relPath: string, findings: Finding[]): void {
  const inScope =
    REGISTRATION_SCOPE.some((prefix) => under(relPath, prefix)) && !under(relPath, 'ecosystem/test/fixtures/');

  if (!inScope) return;

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || literalText(statement.moduleSpecifier) !== 'bun:test') continue;

    const bindings = statement.importClause?.namedBindings;

    if (!bindings) continue;

    if (ts.isNamespaceImport(bindings)) {
      findings.push({
        check: 'imports',
        rule: 'raw-test-registration',
        file: relPath,
        line: lineOf(source, statement),
        message: 'namespace import of bun:test exposes it/test; register through scenario()',
      });
      continue;
    }

    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;

      if (imported === 'it' || imported === 'test') {
        findings.push({
          check: 'imports',
          rule: 'raw-test-registration',
          file: relPath,
          line: lineOf(source, statement),
          message: `'${imported}' imported from bun:test; register through scenario()`,
        });
      }
    }
  }
}

export function checkImportsInFile(root: string, file: string): Finding[] {
  const relPath = rel(root, file);
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  const refs = collect(source, relPath, findings);
  const inPackage = under(relPath, 'packages/conformance/src/');
  const inEcosystem = under(relPath, 'ecosystem/');
  const report = (rule: string, line: number, message: string): void => {
    findings.push({ check: 'imports', rule, file: relPath, line, message });
  };

  for (const { specifier, line, kind } of refs) {
    if (FORBIDDEN.test(specifier)) report('forbidden-specifier', line, `imports '${specifier}'`);

    const target = resolveTarget(root, file, specifier);

    if (target !== undefined) {
      if (target.startsWith('../') || target === '..') {
        report('outside-root', line, `'${specifier}' resolves outside the repository`);
        continue;
      }

      if (
        under(target, 'adapters/') &&
        !under(relPath, 'tools/select-adapter.ts') &&
        !under(relPath, 'tools/validate/')
      ) {
        report('adapters-import', line, `'${specifier}' imports a first-party descriptor module`);
      }

      if (
        target === 'packages/conformance/src/maintainer.ts' &&
        relPath !== 'packages/conformance/src/load.ts' &&
        relPath !== 'tools/select-adapter.ts' &&
        !(under(relPath, 'tools/') && relPath.endsWith('.test.ts'))
      ) {
        report('maintainer-import', line, `'${specifier}' imports the internal maintainer state`);
      }

      if (inPackage) {
        if (!under(target, 'packages/conformance/src/')) {
          report('packaging', line, `'${specifier}' leaves packages/conformance/src`);
        } else if (ZOD_FIXTURE.test(target) && kind !== 'dynamic') {
          report('zod-fixture-static', line, `'${specifier}' is a zod fixture; load it with a literal import()`);
        }
      }

      if (inEcosystem && under(target, 'packages/conformance/')) {
        report('ecosystem-deep-import', line, `'${specifier}' reaches into packages/conformance`);
      }

      continue;
    }

    if (inPackage) {
      const name = bareName(specifier);
      const allowed =
        name === '@asenajs/asena' ||
        specifier.startsWith('bun:') ||
        specifier === 'bun' ||
        specifier.startsWith('node:') ||
        BUILTINS.has(specifier) ||
        name === 'zod';

      if (!allowed) report('packaging', line, `'${specifier}' is not allowed inside packages/conformance/src`);
      if (name === 'zod' && !ZOD_FIXTURE.test(relPath)) {
        report('zod-static', line, `'${specifier}' outside src/areas/*/fixtures/zod*.ts`);
      }
    }

    if (
      inEcosystem &&
      bareName(specifier) === '@asenajs/adapter-conformance' &&
      specifier !== '@asenajs/adapter-conformance' &&
      specifier !== '@asenajs/adapter-conformance/helpers'
    ) {
      report('ecosystem-deep-import', line, `'${specifier}' is not a public entry of the conformance package`);
    }
  }

  registrationViolations(source, relPath, findings);

  return findings;
}

export function checkImports(root: string): Finding[] {
  return sourceFiles(root)
    .filter((file) => !under(rel(root, file), 'adapters/'))
    .flatMap((file) => checkImportsInFile(root, file));
}
