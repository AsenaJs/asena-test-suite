import type { ServerLogger } from '@asenajs/asena/logger';
import { silentLogger } from '@asenajs/asena/test';
import { AsenaLogger } from '@asenajs/asena-logger';
import { env } from './env.ts';

// QUIET=1 (set by the harness for spawned processes) silences framework logs only; the `[e2e]` markers and lifecycle
// lines go through console and stay visible, because scenarios key off them.
export const logger: ServerLogger = env.QUIET ? silentLogger : new AsenaLogger();
