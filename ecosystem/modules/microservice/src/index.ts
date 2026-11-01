import { createMemoryApp } from './main.memory.ts';
import { env } from './shared/env.ts';
import { installSignalHandlers } from './shared/lifecycle.ts';

const server = await createMemoryApp({ httpPort: env.HTTP_PORT, healthPort: env.HEALTH_PORT });

installSignalHandlers(server);
console.log(`[all-in-one] ready pid=${process.pid} http=${env.HTTP_PORT} health=${env.HEALTH_PORT}`);
