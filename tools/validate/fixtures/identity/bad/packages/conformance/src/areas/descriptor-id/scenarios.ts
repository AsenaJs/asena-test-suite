import { getDescriptor } from '@asenajs/adapter-conformance';

export function register(): void {
  if (getDescriptor().id === 'x') return;
}
