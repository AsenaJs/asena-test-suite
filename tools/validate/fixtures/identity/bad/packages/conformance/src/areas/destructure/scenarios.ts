import { getDescriptor } from '@asenajs/adapter-conformance';

export function register(): unknown {
  const { capabilities } = getDescriptor();

  return capabilities;
}
