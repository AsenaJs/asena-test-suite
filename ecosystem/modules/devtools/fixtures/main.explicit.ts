import { AsenaServerFactory } from '@asenajs/asena';
import { silentLogger } from '@asenajs/asena/test';
import { getDescriptor } from '@asenajs/adapter-conformance';
import { explicitComponents } from './app.ts';

const server = await AsenaServerFactory.create({
  adapter: getDescriptor().createAdapter({ logger: silentLogger }),
  logger: silentLogger,
  port: Number(process.env.DEVTOOLS_FIXTURE_PORT),
  components: explicitComponents,
});

await server.start();
