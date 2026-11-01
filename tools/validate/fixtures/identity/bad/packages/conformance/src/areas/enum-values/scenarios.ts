import { getDescriptor } from '@asenajs/adapter-conformance';

export const values = (): unknown[] => Object.values(getDescriptor());
