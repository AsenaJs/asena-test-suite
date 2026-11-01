import { type AsenaServer, AsenaServerFactory } from '@asenajs/asena';
import { Config } from '@asenajs/asena/decorators';
import type { AsenaConfig } from '@asenajs/asena/server/config';
import { getDescriptor } from '@asenajs/adapter-conformance';
import { BookingMessageController } from './services/booking/BookingMessageController.ts';
import { BookingStore } from './services/booking/BookingStore.ts';
import { BookingGatewayController } from './services/gateway/BookingGatewayController.ts';
import { InventoryController } from './services/inventory/InventoryController.ts';
import { NotificationController } from './services/notification/NotificationController.ts';
import { buildTransportConfig } from './shared/buildTransport.ts';
import { env } from './shared/env.ts';
import { logger } from './shared/logger.ts';

// One hybrid server hosts the HTTP gateway and every message controller on one shared InMemoryTransport; the same
// component classes run as separate processes on the broker beds.
export async function createMemoryApp(options?: { httpPort?: number; healthPort?: number }): Promise<AsenaServer<any>> {
  @Config()
  class MemoryConfig implements AsenaConfig {
    public transport() {
      return { microservice: buildTransportConfig('all-in-one') };
    }
  }

  const server = await AsenaServerFactory.create({
    adapter: getDescriptor().createAdapter({ logger }),
    logger,
    shutdown: { signals: false },
    port: options?.httpPort ?? env.HTTP_PORT,
    components: [
      MemoryConfig,
      BookingStore,
      BookingMessageController,
      NotificationController,
      InventoryController,
      BookingGatewayController,
    ],
    ...(options?.healthPort ? { health: { port: options.healthPort } } : {}),
  });

  await server.start();

  return server;
}
