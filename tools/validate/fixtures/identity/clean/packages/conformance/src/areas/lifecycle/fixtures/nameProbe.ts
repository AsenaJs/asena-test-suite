import type { AsenaAdapter } from '@asenajs/asena/adapter';

export function probe(adapter: AsenaAdapter<any, any>): boolean {
  return typeof adapter.name === 'string' && adapter.name.length > 0;
}
