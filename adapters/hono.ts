import { Context, CorsMiddleware, createHonoAdapter, RateLimiterMiddleware } from '@asenajs/hono-adapter';
import type { AdapterDescriptor, DivergenceFlag } from '../packages/conformance/src/descriptor.ts';

const descriptor: AdapterDescriptor = {
  id: 'hono-adapter',
  packageName: '@asenajs/hono-adapter',
  createAdapter: ({ logger }) => {
    const [adapter] = createHonoAdapter({ logger });

    return adapter;
  },
  defineContext: (schemas) => Context.define(schemas as never),
  cliTemplate: 'hono',
  builtins: {
    cors: (options) =>
      class extends CorsMiddleware {
        public constructor() {
          super({ ...options });
        }
      },
    rateLimiter: ({ keyGenerator, ...rest }) =>
      class extends RateLimiterMiddleware {
        public constructor() {
          super({ ...rest, ...(keyGenerator ? { keyGenerator: (context) => keyGenerator(context) } : {}) });
        }
      },
  },
  capabilities: {
    'optional.notFoundHook': true,
    'optional.unixSocket': true,
    'optional.routePattern': true,
    'optional.requestIp': true,
    'optional.responseHeaders': true,
    'optional.zodValidator': true,
    'optional.builtinCors': true,
    'optional.builtinRateLimiter': true,
  },
};

export const divergences: Partial<Record<DivergenceFlag, false>> = {
  'routing.trailingSlashAlias': false,
  'ws.startAwaitsTransportInit': false,
  'routing.unmatchedRoutePatternUnset': false,
  'context.absentValuesMatchDeclaredTypes': false,
  'context.invalidJsonIsBadRequest': false,
  'streaming.sseErrorCallbackOwnsOutput': false,
  'streaming.sseWriterStateIsLive': false,
};

export default descriptor;
