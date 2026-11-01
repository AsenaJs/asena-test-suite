import { AsenaServerFactory } from '@asenajs/asena';
import { Config } from '@asenajs/asena/decorators';
import { env } from '../../shared/env';
import { logger } from '../../shared/logger';
import { buildTransportConfig } from '../../shared/buildTransport';
import { installSignalHandlers } from '../../shared/lifecycle';
import { BridgeController } from './BridgeController';

// Only meaningful under TRANSPORT=mixed: in single-transport modes the
// controller's `transport: 'kafka'` binding has no named transport to attach
// to and core validation rejects the boot - which is expected
@Config()
class BridgeConfig {
  public transport() {
    return { microservice: buildTransportConfig('bridge-service') };
  }
}

const server = await AsenaServerFactory.create({
  headless: true,
  logger,
  shutdown: { signals: false },
  components: [BridgeConfig, BridgeController],
  health: { port: env.HEALTH_PORT },
});

await server.start();
installSignalHandlers(server);
console.log(`[bridge-service] ready pid=${process.pid} health=${env.HEALTH_PORT}`);
