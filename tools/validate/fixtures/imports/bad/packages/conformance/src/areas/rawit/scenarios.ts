import { expect, it } from 'bun:test';

export function register(): void {
  it('raw', () => expect(1).toBe(1));
}
