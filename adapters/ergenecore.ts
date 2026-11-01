import { Context, CorsMiddleware, createErgenecoreAdapter, RateLimiterMiddleware } from '@asenajs/ergenecore';
import type { AdapterDescriptor, DivergenceFlag } from '../packages/conformance/src/descriptor.ts';

const descriptor: AdapterDescriptor = {
  id: 'ergenecore',
  packageName: '@asenajs/ergenecore',
  createAdapter: ({ logger }) => createErgenecoreAdapter({ logger }),
  defineContext: (schemas) => Context.define(schemas as never),
  cliTemplate: 'ergenecore',
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
  'middleware.codeAfterNextRuns': false,
};

export default descriptor;
