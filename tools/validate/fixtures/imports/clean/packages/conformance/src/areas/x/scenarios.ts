import { describe, expect } from 'bun:test';
import { join } from 'node:path';
import { readFileSync } from 'fs';
import type { AsenaContext } from '@asenajs/asena/adapter';
import { Controller } from '@asenajs/asena/decorators';
import { bootApp } from '../../boot.ts';
import { scenario } from '../../scenario.ts';

export type Ctx = AsenaContext<any, any>;

export function register(): void {
  describe('x', () => {
    scenario('P1.x.001', 'zod fixture through a literal import()', async () => {
      const { zodFixture } = await import('./fixtures/zod.ts');
      const core = Bun.resolveSync('@asenajs/asena/package.json', import.meta.dir);

      expect([zodFixture, core, join, readFileSync, Controller, bootApp]).toHaveLength(6);
    });
  });
}
