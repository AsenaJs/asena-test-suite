import { AsenaServerFactory } from '@asenajs/asena';
import { Config } from '@asenajs/asena/decorators';
import { env } from '../../shared/env';
import { logger } from '../../shared/logger';
import { buildTransportConfig } from '../../shared/buildTransport';
import { BadPatternController } from './BadPatternController';

@Config()
class BadPatternConfig {
  public transport() {
    return { microservice: buildTransportConfig('badpattern-service') };
  }
}

// C11 fixture: boot MUST fail (empty final pattern). Explicit exit(1) keeps
// the assertion deterministic instead of relying on unhandled-rejection codes.
try {
  const server = await AsenaServerFactory.create({
    headless: true,
    logger,
    components: [BadPatternConfig, BadPatternController],
    health: { port: env.HEALTH_PORT },
  });

  await server.start();
  console.log(`[badpattern-service] ready pid=${process.pid} - THIS SHOULD NEVER PRINT`);
} catch (error) {
  console.error('[badpattern-service] boot failed:', (error as Error).message);
  process.exit(1);
}
