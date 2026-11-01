import { adapterPackageRoot } from '@asenajs/adapter-conformance';

export const inside = (x: string): boolean => adapterPackageRoot().includes(x);
