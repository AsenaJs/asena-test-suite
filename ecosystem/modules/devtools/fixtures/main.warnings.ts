import { AsenaServerFactory } from '@asenajs/asena';
import type { ServerLogger } from '@asenajs/asena/logger';
import { silentLogger } from '@asenajs/asena/test';
import { getDescriptor } from '@asenajs/adapter-conformance';
import { WARNING_PREFIX } from './app.ts';

const logger: ServerLogger = {
  ...silentLogger,
  warn: (message: string) => {
    console.error(`${WARNING_PREFIX}${message}`);
  },
};

const server = await AsenaServerFactory.create({
  adapter: getDescriptor().createAdapter({ logger: silentLogger }),
  logger,
  port: Number(process.env.DEVTOOLS_FIXTURE_PORT),
});

await server.start();
