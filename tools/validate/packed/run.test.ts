import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Case, readJunit } from '../parity.ts';
import { comparePacked, entryOf, resolveWorkspace } from './run.ts';

const parity = join(import.meta.dir, '..', 'fixtures', 'parity');
const declared = new Set(['routing.trailingSlashAlias']);

function testCase(name: string, status: Case['status'], message = ''): Case {
  return { name, classname: 'x', file: 'test/conformance.test.ts', status, message };
}

function p1(): Case[] {
  return readJunit(join(parity, 'p1-b.xml'));
}

function packed(): Case[] {
  return readJunit(join(parity, 'entry.xml'));
}

function rules(p1Cases: Case[], packedCases: Case[]): string[] {
  return comparePacked('packed-b-npm', p1Cases, packedCases, declared).findings.map((finding) => finding.rule);
}

describe('packed comparison (bit 32)', () => {
  it('equal ID sets and statuses pass; the declared divergence fails as expected', () => {
    const result = comparePacked('packed-b-npm', p1(), packed(), declared);

    expect(result.findings).toEqual([]);
    expect(result.differences).toEqual([]);
    expect(result.expectedFailures).toEqual(['P1.routing.040']);
  });

  it('an ID missing from the packed run fails', () => {
    const cases = packed().filter((entry) => !entry.name.startsWith('[P1.smoke.001]'));

    expect(rules(p1(), cases)).toEqual(['packed-id-set']);
  });

  it('an ID only the packed run has fails', () => {
    expect(rules(p1(), [...packed(), testCase('[P1.smoke.009] extra', 'pass')])).toEqual(['packed-id-set']);
  });

  it('a status that differs fails and lands in the difference table', () => {
    const cases = packed().map((entry) =>
      entry.name.startsWith('[P1.smoke.001]')
        ? { ...entry, status: 'fail' as const, message: 'expect(x)\nmore' }
        : entry,
    );
    const result = comparePacked('packed-b-npm', p1(), cases, declared);

    expect(result.findings.map((finding) => finding.rule)).toEqual(['packed-status']);
    expect(result.differences).toEqual([
      { id: 'P1.smoke.001', p1: 'pass', expected: 'pass', packed: 'fail', note: 'expect(x)' },
    ]);
  });

  it('a skip in the packed run where P1 passed fails', () => {
    const cases = packed().map((entry) =>
      entry.name.startsWith('[P1.lifecycle.004]') ? { ...entry, status: 'skip' as const } : entry,
    );

    expect(rules(p1(), cases)).toEqual(['packed-status']);
  });

  it('a divergence-tagged ID that passes in the packed run fails', () => {
    const cases = packed().map((entry) =>
      entry.name.startsWith('[P1.routing.040]') ? { ...entry, status: 'pass' as const, message: '' } : entry,
    );

    expect(rules(p1(), cases)).toEqual(['packed-divergence-passed']);
  });

  it('a divergence tag the adapter does not declare false keeps the P1 status', () => {
    const result = comparePacked('packed-b-npm', p1(), packed(), new Set());

    expect(result.findings.map((finding) => finding.rule)).toEqual(['packed-status']);
  });

  it('a failing decorator-mode guard is reported as such', () => {
    const guardP1 = [...p1(), testCase('[P1.resolution.004] decorator mode', 'pass')];
    const guardPacked = [...packed(), testCase('[P1.resolution.004] decorator mode', 'fail', 'NOT-CONFIGURED: x')];

    expect(rules(guardP1, guardPacked)).toEqual(['packed-guard']);
  });

  it('a packed test without an ID fails', () => {
    expect(rules(p1(), [...packed(), testCase('no id here', 'pass')])).toEqual(['packed-id-grammar']);
  });
});

describe('packed project helpers', () => {
  it('entryOf follows exports, then main', () => {
    expect(entryOf({ main: 'dist/index.js', module: 'index.ts' })).toBe('../dist/index.js');
    expect(entryOf({ exports: { '.': { import: './dist/esm/index.js' } }, main: 'x.js' })).toBe('../dist/esm/index.js');
    expect(entryOf({ exports: './lib/index.js' })).toBe('../lib/index.js');
  });

  it('resolveWorkspace: flag, then a set env (empty = none), then a parent holding ergenecore/.git', () => {
    const base = mkdtempSync(join(tmpdir(), 'asena-ws-'));
    const root = join(base, 'suite');

    try {
      mkdirSync(root);
      expect(resolveWorkspace(root, undefined, undefined)).toBeUndefined();
      mkdirSync(join(base, 'ergenecore', '.git'), { recursive: true });
      expect(resolveWorkspace(root, undefined, undefined)).toBe(base);
      expect(resolveWorkspace(root, undefined, '')).toBeUndefined();
      expect(resolveWorkspace(root, undefined, '/elsewhere')).toBe('/elsewhere');
      expect(resolveWorkspace(root, '/flag', '')).toBe('/flag');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
