import { getDescriptor } from '@asenajs/adapter-conformance';

export const hasTemplate = (): boolean => typeof getDescriptor().cliTemplate === 'string';
