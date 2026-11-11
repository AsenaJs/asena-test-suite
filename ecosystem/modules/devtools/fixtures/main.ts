import { AsenaServerFactory } from '@asenajs/asena';
import { silentLogger } from '@asenajs/asena/test';
import { getDescriptor } from '@asenajs/adapter-conformance';

// No `components`: the app is the build list the wrapper published, as under `asena console`.
const server = await AsenaServerFactory.create({
  adapter: getDescriptor().createAdapter({ logger: silentLogger }),
  logger: silentLogger,
  port: Number(process.env.DEVTOOLS_FIXTURE_PORT),
});

await server.start();
