import { getDescriptor } from '@asenajs/adapter-conformance';
import type { ServerLogger } from '@asenajs/asena/logger';

export const strict = (logger: ServerLogger): unknown => (getDescriptor().createAdapter({ logger }) as any).strict;
