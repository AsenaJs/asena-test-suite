import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

export interface SecondHttpException {
  HttpException: new (status: number, body?: string | object, options?: ResponseInit) => Error & { status: number };
  dispose(): void;
}

function packageRootOf(file: string): string {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dirname(dir) === dir) throw new Error(`No package.json above ${file}`);
  }
}

function copyWithRelativeImports(file: string, root: string, target: string, done: Set<string>): void {
  if (done.has(file)) return;
  done.add(file);

  const destination = join(target, relative(root, file));

  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(file, destination);

  const transpiler = new Bun.Transpiler({ loader: 'js' });

  for (const { path } of transpiler.scanImports(readFileSync(file, 'utf8'))) {
    if (!path.startsWith('.')) continue;

    const dependency = resolve(dirname(file), path);
    const candidates = [dependency, `${dependency}.js`, join(dependency, 'index.js')];
    const found = candidates.find((candidate) => existsSync(candidate) && candidate.endsWith('.js'));

    if (!found) throw new Error(`Cannot resolve relative import '${path}' of ${file}`);
    copyWithRelativeImports(found, root, target, done);
  }
}

export async function loadSecondHttpException(): Promise<SecondHttpException> {
  const adapterEntry = Bun.resolveSync('@asenajs/asena/adapter', import.meta.dir);
  const source = join(dirname(adapterEntry), 'types', 'HttpException.js');
  const root = packageRootOf(adapterEntry);
  const target = mkdtempSync(join(tmpdir(), 'asena-second-core-'));

  try {
    copyWithRelativeImports(source, root, target, new Set());

    const copy = join(target, relative(root, source));
    const module = (await import(copy)) as Pick<SecondHttpException, 'HttpException'>;

    return { HttpException: module.HttpException, dispose: () => rmSync(target, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}
