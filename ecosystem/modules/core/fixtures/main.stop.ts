import { AsenaServerFactory } from '@asenajs/asena';
import type { AsenaContext } from '@asenajs/asena/adapter';
import { Controller, Service } from '@asenajs/asena/decorators';
import { Get } from '@asenajs/asena/decorators/http';
import { OnStop } from '@asenajs/asena/decorators/ioc';
import { silentLogger } from '@asenajs/asena/test';
import { getDescriptor } from '@asenajs/adapter-conformance';
import { STOP_HOOK_MARKER } from './stopChild.ts';

@Service('StopHookProbe')
class StopHookProbe {
  @OnStop()
  public stopped() {
    console.log(STOP_HOOK_MARKER);

    if (process.env.SUITE_STOP_HOOK === 'throws') throw new Error('suite: the stop hook failed');
  }
}

@Controller('/stop')
class StopController {
  @Get('/ping')
  public ping(context: AsenaContext<any, any>) {
    return context.send({ ok: true });
  }
}

const server = await AsenaServerFactory.create({
  adapter: getDescriptor().createAdapter({ logger: silentLogger }),
  logger: silentLogger,
  port: Number(process.env.SUITE_STOP_PORT),
  components: [StopHookProbe, StopController],
});

await server.start();

if (process.env.SUITE_STOP_BY === 'call') await server.stop();
