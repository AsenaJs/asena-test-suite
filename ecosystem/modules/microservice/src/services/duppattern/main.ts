import { AsenaServerFactory } from '@asenajs/asena';
import { Config } from '@asenajs/asena/decorators';
import { env } from '../../shared/env';
import { logger } from '../../shared/logger';
import { buildTransportConfig } from '../../shared/buildTransport';
import { DuplicatePatternController } from './DuplicatePatternController';

@Config()
class DuplicatePatternConfig {
  public transport() {
    return { microservice: buildTransportConfig('duppattern-service') };
  }
}

// Boot MUST fail (two handlers on the same final pattern). Explicit exit(1) keeps the
// assertion deterministic instead of relying on unhandled-rejection codes.
try {
  const server = await AsenaServerFactory.create({
    headless: true,
    logger,
    components: [DuplicatePatternConfig, DuplicatePatternController],
    health: { port: env.HEALTH_PORT },
  });

  await server.start();
  console.log(`[duppattern-service] ready pid=${process.pid} - THIS SHOULD NEVER PRINT`);
} catch (error) {
  console.error('[duppattern-service] boot failed:', (error as Error).message);
  process.exit(1);
}
