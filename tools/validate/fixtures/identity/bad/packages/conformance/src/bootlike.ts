import type { AdapterDescriptor } from '@asenajs/adapter-conformance';

export function label(descriptor: AdapterDescriptor): string {
  return descriptor.packageName;
}
