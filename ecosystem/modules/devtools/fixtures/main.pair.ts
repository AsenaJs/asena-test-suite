import { AsenaServerFactory } from '@asenajs/asena';
import { silentLogger } from '@asenajs/asena/test';
import { getDescriptor } from '@asenajs/adapter-conformance';
import { explicitComponents } from './app.ts';
import { draftComponents } from './drafts.ts';

async function serve(port: string | undefined, components: (new (...args: any[]) => unknown)[]) {
  const server = await AsenaServerFactory.create({
    adapter: getDescriptor().createAdapter({ logger: silentLogger }),
    logger: silentLogger,
    port: Number(port),
    components,
  });

  await server.start();
}

await serve(process.env.DEVTOOLS_FIXTURE_PORT, explicitComponents);
await serve(process.env.DEVTOOLS_FIXTURE_SECOND_PORT, draftComponents);
