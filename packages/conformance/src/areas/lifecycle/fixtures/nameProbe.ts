import type { AsenaAdapter } from '@asenajs/asena/adapter';

export function isNonEmptyName(adapter: AsenaAdapter<any, any>): boolean {
  return typeof adapter.name === 'string' && adapter.name.length > 0;
}
