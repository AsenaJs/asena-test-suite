import type { AsenaAdapter } from '@asenajs/asena/adapter';

export function probe(adapter: AsenaAdapter<any, any>): boolean {
  return adapter.name === 'x';
}
