import type {
  AdapterDescriptor,
  ConformanceCorsOptions,
  ConformanceRateLimiterOptions,
} from '@asenajs/adapter-conformance';
import type { AsenaAdapter } from '@asenajs/asena/adapter';
import type { ServerLogger } from '@asenajs/asena/logger';

// Placeholders for your adapter's own exports. In your repo, import them from your entry instead,
// e.g. `import { Context, CorsMiddleware, createMyAdapter, RateLimiterMiddleware } from '../index';`
declare function createMyAdapter(options: { logger: ServerLogger }): AsenaAdapter<any, any>;
declare const Context: { define(schemas: never): new (...args: any[]) => unknown };
declare class CorsMiddleware {
  public constructor(options: ConformanceCorsOptions);
}
declare class RateLimiterMiddleware {
  public constructor(options: ConformanceRateLimiterOptions);
}

export const descriptor: AdapterDescriptor = {
  // The id your context reports to core's assertContextAdapter.
  id: 'my-adapter',
  packageName: '@acme/my-adapter',

  // Called once per booted app: return a fresh adapter built with your factory defaults.
  createAdapter: ({ logger }) => createMyAdapter({ logger }),
  defineContext: (schemas) => Context.define(schemas as never),

  // Optional: the `asena create --adapter=<value>` template name. Leave it out if the CLI has none.
  // cliTemplate: 'my-adapter',

  // Optional: built-in middlewares. Map the neutral option keys if your classes name them differently.
  builtins: {
    cors: (options) =>
      class extends CorsMiddleware {
        public constructor() {
          super({ ...options });
        }
      },
    rateLimiter: (options) =>
      class extends RateLimiterMiddleware {
        public constructor() {
          super({ ...options });
        }
      },
  },

  // Every optional flag must be present. `false` reports the gated scenarios as skipped with [cap:<flag>].
  capabilities: {
    'optional.notFoundHook': true,
    'optional.unixSocket': true,
    'optional.routePattern': true,
    'optional.requestIp': true,
    'optional.responseHeaders': true,
    'optional.zodValidator': false,
    'optional.builtinCors': true,
    'optional.builtinRateLimiter': true,
  },
};
