import { getDescriptor } from '@asenajs/adapter-conformance';

export const dump = (): string => JSON.stringify(getDescriptor());
