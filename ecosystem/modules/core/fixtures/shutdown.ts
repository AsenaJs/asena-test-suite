import { type AsenaServer, AsenaServerFactory } from '@asenajs/asena';
import type { AsenaContext } from '@asenajs/asena/adapter';
import { Config, Controller, Service } from '@asenajs/asena/decorators';
import { Get } from '@asenajs/asena/decorators/http';
import { OnStop } from '@asenajs/asena/decorators/ioc';
import { InMemoryTransport } from '@asenajs/asena/microservice';
import type { AsenaConfig } from '@asenajs/asena/server/config';
import { silentLogger } from '@asenajs/asena/test';
import { getDescriptor } from '@asenajs/adapter-conformance';
import { isPortFree, randomPort } from '@asenajs/adapter-conformance/helpers';

type Ctx = AsenaContext<any, any>;

export interface ShutdownProbe {
  order: string[];
  newConnectionRefused?: boolean;
  readyStatusDuringStop?: number;
}

export interface ShutdownApp {
  server: AsenaServer<any>;
  port: number;
  healthPort: number;
  probe: ShutdownProbe;
}

async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = randomPort();

    if (await isPortFree(port)) return port;
  }

  throw new Error('no free port in 10000-31999');
}

export async function connectionRefused(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {} } });

    socket.end();

    return false;
  } catch {
    return true;
  }
}

export async function readyStatus(healthPort: number): Promise<number> {
  return (await fetch(`http://127.0.0.1:${healthPort}/healthz/ready`)).status;
}

export async function bootShutdownApp(): Promise<ShutdownApp> {
  const probe: ShutdownProbe = { order: [] };
  const port = await freePort();
  const healthPort = await freePort();

  class RecordingTransport extends InMemoryTransport {
    public override async destroy(...args: Parameters<InMemoryTransport['destroy']>): Promise<void> {
      probe.order.push('transport.destroy');

      return super.destroy(...args);
    }
  }

  const transport = new RecordingTransport();

  @Config()
  class ShutdownConfig implements AsenaConfig {
    public transport() {
      return { microservice: transport };
    }
  }

  @Service('ShutdownHookProbe')
  class ShutdownHookProbe {
    @OnStop()
    public async stopped() {
      probe.order.push('onStop');
      probe.newConnectionRefused = await connectionRefused(port);
      probe.readyStatusDuringStop = await readyStatus(healthPort);
    }
  }

  @Controller('/shutdown')
  class ShutdownController {
    @Get('/ping')
    public ping(context: Ctx) {
      return context.send({ ok: true });
    }
  }

  const server = await AsenaServerFactory.create({
    adapter: getDescriptor().createAdapter({ logger: silentLogger }),
    logger: silentLogger,
    port,
    health: { port: healthPort },
    shutdown: { signals: false },
    components: [ShutdownConfig, ShutdownHookProbe, ShutdownController],
  });

  await server.start();

  return { server, port, healthPort, probe };
}
