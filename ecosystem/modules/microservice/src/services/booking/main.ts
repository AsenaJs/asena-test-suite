import { AsenaServerFactory } from '@asenajs/asena';
import { Config } from '@asenajs/asena/decorators';
import { env } from '../../shared/env';
import { logger } from '../../shared/logger';
import { buildTransportConfig } from '../../shared/buildTransport';
import { installSignalHandlers } from '../../shared/lifecycle';
import { BookingStore } from './BookingStore';
import { BookingMessageController } from './BookingMessageController';

@Config()
class BookingConfig {
  public transport() {
    return { microservice: buildTransportConfig('booking-service') };
  }
}

const server = await AsenaServerFactory.create({
  headless: true,
  logger,
  shutdown: { signals: false },
  components: [BookingConfig, BookingStore, BookingMessageController],
  health: { port: env.HEALTH_PORT },
});

await server.start();
installSignalHandlers(server);
console.log(`[booking-service] ready pid=${process.pid} health=${env.HEALTH_PORT}`);
