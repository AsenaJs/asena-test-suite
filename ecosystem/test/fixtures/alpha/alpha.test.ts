import { expect, it } from 'bun:test';
import { getDescriptor } from '@asenajs/adapter-conformance';

it('alpha reports its process and the selected adapter factory', () => {
  console.log(`[fixture] alpha pid=${process.pid} createAdapter=${typeof getDescriptor().createAdapter}`);
  expect(typeof getDescriptor().createAdapter).toBe('function');
});
