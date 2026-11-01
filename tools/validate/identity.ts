import { join } from 'node:path';
import ts from 'typescript';
import { type Finding, isExempt, rel, sourceFiles, suiteRoot } from './common.ts';

const IDENTITY = /ergenecore|hono(?!u?r)/i;
const IDENTITY_MEMBERS = new Set(['id', 'packageName', 'packageRoot', 'divergences', 'capabilities']);
const OPTIONAL_MEMBERS: Record<string, string[]> = {
  cliTemplate: ['cliTemplate'],
  builtins: ['builtins.cors', 'builtins.rateLimiter'],
};
const TAG_CALLS = new Set(['runTag', 'adapterPackageRoot']);
const PATH_JOINERS = new Set(['join', 'resolve']);
const PATH_MODULES = new Set(['path', 'posix', 'win32', 'nodePath']);
const ENUMERATORS: Record<string, Set<string>> = {
  Object: new Set(['keys', 'values', 'entries', 'getOwnPropertyNames']),
  Reflect: new Set(['ownKeys']),
  JSON: new Set(['stringify']),
};
const NAME_PROBE = 'packages/conformance/src/areas/lifecycle/fixtures/nameProbe.ts';
const PROBE_FILE = join(suiteRoot, 'tools', 'validate', '__identity_probe__.ts');
const PROBE_SOURCE = `import type { AsenaAdapter, AsenaWebsocketAdapter } from '@asenajs/asena/adapter';
import type { AdapterDescriptor } from '@asenajs/adapter-conformance';
export declare const descriptor: AdapterDescriptor;
export declare const adapter: AsenaAdapter<any, any>;
export declare const wsAdapter: AsenaWebsocketAdapter;
`;

interface Targets {
  descriptor: ts.Type;
  adapter: ts.Type;
  wsAdapter: ts.Type;
}

function compilerOptions(): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(suiteRoot, 'tsconfig.base.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    },
  );

  if (!parsed) throw new Error('identity: cannot parse tsconfig.base.json');

  return { ...parsed.options, noEmit: true, skipLibCheck: true };
}

function createProgram(files: string[]): ts.Program {
  const options = compilerOptions();
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);

  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
    fileName === PROBE_FILE
      ? ts.createSourceFile(fileName, PROBE_SOURCE, languageVersion, true)
      : getSourceFile(fileName, languageVersion, onError, shouldCreate);
  host.fileExists = (fileName) => fileName === PROBE_FILE || fileExists(fileName);
  host.readFile = (fileName) => (fileName === PROBE_FILE ? PROBE_SOURCE : readFile(fileName));

  return ts.createProgram({ rootNames: [...files, PROBE_FILE], options, host });
}

function targets(program: ts.Program, checker: ts.TypeChecker): Targets {
  const probe = program.getSourceFile(PROBE_FILE);

  if (!probe) throw new Error('identity: probe file missing from the program');

  const declared = new Map<string, ts.Type>();

  for (const statement of probe.statements) {
    if (!ts.isVariableStatement(statement)) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        declared.set(declaration.name.text, checker.getTypeAtLocation(declaration.name));
      }
    }
  }

  const get = (name: string): ts.Type => {
    const type = declared.get(name);

    if (!type || type.flags & ts.TypeFlags.Any) throw new Error(`identity: cannot resolve the ${name} contract type`);

    return type;
  };

  return { descriptor: get('descriptor'), adapter: get('adapter'), wsAdapter: get('wsAdapter') };
}

class FileChecker {
  public readonly findings: Finding[] = [];

  public constructor(
    private readonly source: ts.SourceFile,
    private readonly relPath: string,
    private readonly checker: ts.TypeChecker,
    private readonly target: Targets,
  ) {}

  public run(): Finding[] {
    const visit = (node: ts.Node): void => {
      this.visit(node);
      ts.forEachChild(node, visit);
    };

    visit(this.source);

    return this.findings;
  }

  private report(node: ts.Node, rule: string, message: string): void {
    this.findings.push({
      check: 'identity',
      rule,
      file: this.relPath,
      line: this.source.getLineAndCharacterOfPosition(node.getStart(this.source)).line + 1,
      message,
    });
  }

  private snippet(node: ts.Node): string {
    const text = node.getText(this.source).replace(/\s+/g, ' ');

    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  }

  private matches(node: ts.Node, target: ts.Type): boolean {
    const type = this.checker.getNonNullableType(this.checker.getTypeAtLocation(node));
    const candidates = type.isUnion() ? type.types : [type];

    return candidates.some(
      (candidate) =>
        !(candidate.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) &&
        this.checker.isTypeAssignableTo(candidate, target),
    );
  }

  private isDescriptor(node: ts.Node): boolean {
    return this.matches(node, this.target.descriptor);
  }

  private isAdapter(node: ts.Node): boolean {
    return this.matches(node, this.target.adapter) || this.matches(node, this.target.wsAdapter);
  }

  private visit(node: ts.Node): void {
    this.literal(node);
    this.memberRead(node);
    this.adapterName(node);
    this.adapterEnv(node);
    this.tagFlow(node);
    this.enumeration(node);
    this.cast(node);
  }

  private literal(node: ts.Node): void {
    let text: string | undefined;

    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isRegularExpressionLiteral(node)
    ) {
      text = node.text;
    }

    if (text !== undefined && IDENTITY.test(text)) {
      this.report(node, 'identity-literal', `literal names an adapter: ${this.snippet(node)}`);
    }
  }

  private memberName(node: ts.Node): { receiver: ts.Expression; name: string } | undefined {
    if (ts.isPropertyAccessExpression(node)) return { receiver: node.expression, name: node.name.text };

    if (ts.isElementAccessExpression(node)) {
      const argument = node.argumentExpression;

      if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
        return { receiver: node.expression, name: argument.text };
      }
    }

    return undefined;
  }

  private memberRead(node: ts.Node): void {
    const access = this.memberName(node);

    if (access && this.isDescriptor(access.receiver)) {
      this.checkDescriptorMember(node, access.name);
    }

    if (ts.isObjectBindingPattern(node)) {
      const parent = node.parent;
      const source =
        ts.isVariableDeclaration(parent) && parent.initializer
          ? parent.initializer
          : ts.isParameter(parent)
            ? parent
            : undefined;

      if (source && this.isDescriptor(source)) {
        for (const element of node.elements) {
          const key = element.propertyName ?? element.name;
          const name = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;

          if (name !== undefined) this.checkDescriptorMember(element, name);
        }
      }
    }
  }

  private checkDescriptorMember(node: ts.Node, name: string): void {
    if (IDENTITY_MEMBERS.has(name)) {
      this.report(node, 'descriptor-identity-read', `reads '${name}' of an AdapterDescriptor`);

      return;
    }

    const needed = OPTIONAL_MEMBERS[name];

    if (needed && !this.insideMembersScenario(node, needed)) {
      this.report(
        node,
        'optional-member-read',
        `reads optional '${name}' outside a scenario declaring members: [${needed.map((m) => `'${m}'`).join(' | ')}]`,
      );
    }
  }

  private insideMembersScenario(node: ts.Node, needed: string[]): boolean {
    for (let current: ts.Node = node; current.parent; current = current.parent) {
      const parent = current.parent;

      if (
        ts.isCallExpression(parent) &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === 'scenario' &&
        parent.arguments[2] === current
      ) {
        const options = parent.arguments[3];

        if (!options || !ts.isObjectLiteralExpression(options)) return false;

        for (const property of options.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === 'members' &&
            ts.isArrayLiteralExpression(property.initializer)
          ) {
            return property.initializer.elements.some(
              (element) => ts.isStringLiteral(element) && needed.includes(element.text),
            );
          }
        }

        return false;
      }
    }

    return false;
  }

  private adapterName(node: ts.Node): void {
    if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'name') return;

    const receiver = node.expression;
    const constructorName =
      ts.isPropertyAccessExpression(receiver) &&
      receiver.name.text === 'constructor' &&
      this.isAdapter(receiver.expression);

    if (!constructorName && !this.isAdapter(receiver)) return;

    if (!constructorName && this.relPath === NAME_PROBE && this.nameProbeForm(node)) return;

    this.report(
      node,
      'adapter-name-read',
      `${constructorName ? '.constructor.name' : '.name'} read on an adapter: ${this.snippet(node)}`,
    );
  }

  private nameProbeForm(node: ts.PropertyAccessExpression): boolean {
    const parent = node.parent;

    if (ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === 'length') {
      return true;
    }

    if (ts.isTypeOfExpression(parent)) {
      const comparison = parent.parent;

      if (
        ts.isBinaryExpression(comparison) &&
        comparison.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      ) {
        const other = comparison.left === parent ? comparison.right : comparison.left;

        return ts.isStringLiteral(other) && other.text === 'string';
      }
    }

    return false;
  }

  private isProcessEnv(node: ts.Node): boolean {
    return (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'env' &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'process'
    );
  }

  private adapterEnv(node: ts.Node): void {
    const access = this.memberName(node);

    if (access?.name === 'ASENA_ADAPTER' && this.isProcessEnv(access.receiver)) {
      this.report(node, 'adapter-env-read', 'reads process.env.ASENA_ADAPTER');
    }

    if (
      ts.isObjectBindingPattern(node) &&
      ts.isVariableDeclaration(node.parent) &&
      node.parent.initializer &&
      this.isProcessEnv(node.parent.initializer)
    ) {
      for (const element of node.elements) {
        const key = element.propertyName ?? element.name;

        if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === 'ASENA_ADAPTER') {
          this.report(element, 'adapter-env-read', 'destructures ASENA_ADAPTER from process.env');
        }
      }
    }
  }

  private tagCallName(node: ts.Node): string | undefined {
    if (!ts.isCallExpression(node)) return undefined;

    const callee = node.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined;

    return name && TAG_CALLS.has(name) ? name : undefined;
  }

  private tagFlow(node: ts.Node): void {
    const name = this.tagCallName(node);

    if (name) this.checkTagUse(node as ts.Expression, name, 0, new Set());
  }

  private isPathJoin(call: ts.CallExpression): boolean {
    const callee = call.expression;

    if (ts.isIdentifier(callee)) return PATH_JOINERS.has(callee.text);

    return (
      ts.isPropertyAccessExpression(callee) &&
      PATH_JOINERS.has(callee.name.text) &&
      ts.isIdentifier(callee.expression) &&
      PATH_MODULES.has(callee.expression.text)
    );
  }

  private references(symbol: ts.Symbol, scope: ts.Node, declarationName: ts.Node): ts.Identifier[] {
    const found: ts.Identifier[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node !== declarationName && this.checker.getSymbolAtLocation(node) === symbol) {
        found.push(node);
      }

      ts.forEachChild(node, visit);
    };

    visit(scope);

    return found;
  }

  private checkTagUse(expression: ts.Expression, name: string, depth: number, seen: Set<ts.Node>): void {
    if (seen.has(expression)) return;
    seen.add(expression);

    let node: ts.Node = expression;

    while (ts.isParenthesizedExpression(node.parent) || ts.isNonNullExpression(node.parent)) node = node.parent;

    const parent = node.parent;

    if (ts.isTemplateSpan(parent) && parent.expression === node) return;

    if (
      ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.PlusToken ||
        (parent.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken && parent.right === node))
    ) {
      return;
    }

    if (ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression)) {
      if (this.isPathJoin(parent)) return;

      if (depth === 0 && this.checkParameterUse(parent, node as ts.Expression, name, seen)) return;
    }

    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === node &&
      ts.isIdentifier(parent.name) &&
      ts.isVariableDeclarationList(parent.parent) &&
      parent.parent.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)
    ) {
      const symbol = this.checker.getSymbolAtLocation(parent.name);
      const scope = ts.findAncestor(parent, (n) => ts.isFunctionLike(n) || ts.isSourceFile(n)) ?? this.source;

      if (symbol) {
        for (const reference of this.references(symbol, scope, parent.name)) {
          this.checkTagUse(reference, name, depth, seen);
        }

        return;
      }
    }

    this.report(
      node,
      'tag-flow',
      `${name}() result used as ${ts.SyntaxKind[parent.kind]} (only template, string +, join/resolve allowed): ${this.snippet(parent)}`,
    );
  }

  private checkParameterUse(call: ts.CallExpression, argument: ts.Expression, name: string, seen: Set<ts.Node>) {
    const signature = this.checker.getResolvedSignature(call);
    const declaration = signature?.getDeclaration();
    const index = call.arguments.indexOf(argument);

    if (!declaration || !('body' in declaration) || !declaration.body) return false;

    const parameter = declaration.parameters[index];

    if (!parameter || parameter.dotDotDotToken || !ts.isIdentifier(parameter.name)) return false;

    const symbol = this.checker.getSymbolAtLocation(parameter.name);

    if (!symbol || declaration.getSourceFile() !== this.source) return false;

    const before = this.findings.length;

    for (const reference of this.references(symbol, declaration.body, parameter.name)) {
      this.checkTagUse(reference, name, 1, seen);
    }

    return this.findings.length === before;
  }

  private enumeration(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const object = node.expression.expression;
      const method = node.expression.name.text;
      const argument = node.arguments[0];

      if (ts.isIdentifier(object) && ENUMERATORS[object.text]?.has(method) && argument && this.isDescriptor(argument)) {
        this.report(node, 'descriptor-enumeration', `${object.text}.${method}() on an AdapterDescriptor`);
      }
    }

    if (ts.isForInStatement(node) && this.isDescriptor(node.expression)) {
      this.report(node, 'descriptor-enumeration', 'for...in over an AdapterDescriptor');
    }

    if (ts.isSpreadAssignment(node) && this.isDescriptor(node.expression)) {
      this.report(node, 'descriptor-enumeration', 'object spread of an AdapterDescriptor');
    }
  }

  private cast(node: ts.Node): void {
    if (!ts.isAsExpression(node) && !ts.isTypeAssertionExpression(node)) return;

    const kind = node.type.kind;

    if (kind !== ts.SyntaxKind.AnyKeyword && kind !== ts.SyntaxKind.UnknownKeyword) return;

    if (this.isDescriptor(node.expression) || this.isAdapter(node.expression)) {
      this.report(node, 'contract-cast', `cast to ${ts.tokenToString(kind)}: ${this.snippet(node)}`);
    }
  }
}

export function checkIdentityFiles(root: string, files: string[]): Finding[] {
  if (files.length === 0) return [];

  const program = createProgram(files);
  const checker = program.getTypeChecker();
  const target = targets(program, checker);

  return files.flatMap((file) => {
    const source = program.getSourceFile(file);

    if (!source) throw new Error(`identity: ${file} is not in the program`);

    return new FileChecker(source, rel(root, file), checker, target).run();
  });
}

export function checkIdentity(root: string): Finding[] {
  return checkIdentityFiles(
    root,
    sourceFiles(root).filter((file) => !isExempt(rel(root, file))),
  );
}
