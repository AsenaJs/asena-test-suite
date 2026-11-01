import { runTag } from '@asenajs/adapter-conformance';

export const isX = (x: string): boolean => runTag() === x;
