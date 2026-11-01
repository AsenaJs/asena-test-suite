import { runConformance } from '@asenajs/adapter-conformance';
import descriptor from '../../../../adapters/ergenecore.ts';

runConformance({ ...descriptor, divergences: { 'ws.startAwaitsTransportInit': false } } as never);
