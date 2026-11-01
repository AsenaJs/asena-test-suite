import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const pkgRoot = join(import.meta.dir, '..');
const srcDir = join(pkgRoot, 'src');
const distDir = join(pkgRoot, 'dist');

rmSync(distDir, { recursive: true, force: true });

const tscBin = createRequire(join(pkgRoot, 'package.json')).resolve('typescript/bin/tsc');
const tsc = Bun.spawnSync([process.execPath, tscBin, '-p', join(pkgRoot, 'tsconfig.build.json')], {
  cwd: pkgRoot,
  stdout: 'inherit',
  stderr: 'inherit',
});

if (tsc.exitCode !== 0) {
  console.error(`build: tsc exited with ${tsc.exitCode}`);
  process.exit(1);
}

// tsc applies rewriteRelativeImportExtensions to .js output only; declarations keep the .ts specifiers.
const tsSpecifier = /((?:\bfrom|\bimport|\bimport\s*\()\s*)(['"])(\.{1,2}\/[^'"]*?)(?<!\.d)\.([mc]?)ts\2/g;

for (const rel of new Bun.Glob('**/*.d.ts').scanSync({ cwd: distDir })) {
  const file = join(distDir, rel);
  const text = await Bun.file(file).text();
  const rewritten = text.replace(tsSpecifier, '$1$2$3.$4js$2');

  if (rewritten !== text) await Bun.write(file, rewritten);
}

let copied = 0;

for (const rel of new Bun.Glob('**/*').scanSync({ cwd: srcDir, dot: true })) {
  if (rel.endsWith('.ts') && !rel.endsWith('.d.ts')) continue;

  const target = join(distDir, rel);

  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(srcDir, rel), target);
  copied++;
}

console.log(`build: dist/ written, ${copied} asset file(s) copied`);
