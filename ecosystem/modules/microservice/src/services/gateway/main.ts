import { AsenaServerFactory } from '@asenajs/asena';
import { Config } from '@asenajs/asena/decorators';
import type { AsenaConfig } from '@asenajs/asena/server/config';
import { getDescriptor } from '@asenajs/adapter-conformance';
import { buildTransportConfig } from '../../shared/buildTransport.ts';
import { env } from '../../shared/env.ts';
import { installSignalHandlers } from '../../shared/lifecycle.ts';
import { logger } from '../../shared/logger.ts';
import { BookingGatewayController } from './BookingGatewayController.ts';

@Config()
class GatewayConfig implements AsenaConfig {
  public transport() {
    return { microservice: buildTransportConfig('gateway') };
  }
}

const server = await AsenaServerFactory.create({
  adapter: getDescriptor().createAdapter({ logger }),
  logger,
  shutdown: { signals: false },
  port: env.HTTP_PORT,
  components: [GatewayConfig, BookingGatewayController],
  health: { port: env.HEALTH_PORT },
});

await server.start();
installSignalHandlers(server);
console.log(`[gateway] ready pid=${process.pid} http=${env.HTTP_PORT} health=${env.HEALTH_PORT}`);
