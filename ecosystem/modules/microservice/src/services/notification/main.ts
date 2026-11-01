import { AsenaServerFactory } from '@asenajs/asena';
import { Config } from '@asenajs/asena/decorators';
import { env } from '../../shared/env';
import { logger } from '../../shared/logger';
import { buildTransportConfig } from '../../shared/buildTransport';
import { installSignalHandlers } from '../../shared/lifecycle';
import { NotificationController } from './NotificationController';

@Config()
class NotificationConfig {
  public transport() {
    return { microservice: buildTransportConfig('notification-service') };
  }
}

const server = await AsenaServerFactory.create({
  headless: true,
  logger,
  shutdown: { signals: false },
  components: [NotificationConfig, NotificationController],
  health: { port: env.HEALTH_PORT },
});

await server.start();
installSignalHandlers(server);
console.log(`[notification-service] ready pid=${process.pid} health=${env.HEALTH_PORT}`);
