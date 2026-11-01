import type { CapabilityFlag } from './descriptor.ts';

export type CapabilityContract =
  { kind: 'member'; file: string; member: string | string[] } | { kind: 'non-member'; reason: string };

export interface CapabilityEntry {
  kind: 'divergence' | 'optional';
  convergence?: string;
  expectedFailure?: RegExp;
  description?: string;
  contract?: CapabilityContract;
}

export const capabilities: Readonly<Record<CapabilityFlag, Readonly<CapabilityEntry>>> = Object.freeze({
  'routing.trailingSlashAlias': { kind: 'divergence', convergence: 'WP-51' },
  'ws.startAwaitsTransportInit': { kind: 'divergence', convergence: 'WP-50' },
  'middleware.codeAfterNextRuns': { kind: 'divergence', convergence: 'WP-55' },
  'routing.unmatchedRoutePatternUnset': { kind: 'divergence', convergence: 'WP-56' },
  'context.absentValuesMatchDeclaredTypes': { kind: 'divergence', convergence: 'WP-57' },
  'context.invalidJsonIsBadRequest': { kind: 'divergence', convergence: 'WP-58' },
  'context.emptyBodyIsEmptyObject': { kind: 'divergence', convergence: 'WP-58' },
  'streaming.sseErrorCallbackOwnsOutput': { kind: 'divergence', convergence: 'WP-59' },
  'streaming.sseWriterStateIsLive': { kind: 'divergence', convergence: 'WP-60' },
  'static.overrideNotFoundContinuesToHandler': { kind: 'divergence', convergence: 'WP-61' },
  'static.encodedPathIsDecodedAndChecked': { kind: 'divergence', convergence: 'WP-62' },
  'optional.notFoundHook': {
    kind: 'optional',
    description: 'AsenaAdapter.onNotFound is optional; without it a config onNotFound hook is never called.',
    contract: { kind: 'member', file: 'lib/adapter/AsenaAdapter.ts', member: 'AsenaAdapter.onNotFound' },
  },
  'optional.unixSocket': {
    kind: 'optional',
    description: 'AsenaStartOptions.unix is optional; adapters may ignore start options they do not support.',
    contract: { kind: 'member', file: 'lib/adapter/types/ServeOptions.ts', member: 'AsenaStartOptions.unix' },
  },
  'optional.routePattern': {
    kind: 'optional',
    description: 'AsenaContext.routePattern is optional.',
    contract: { kind: 'member', file: 'lib/adapter/AsenaContext.ts', member: 'AsenaContext.routePattern' },
  },
  'optional.requestIp': {
    kind: 'optional',
    description: 'AsenaContext.getRequestIp is optional.',
    contract: { kind: 'member', file: 'lib/adapter/AsenaContext.ts', member: 'AsenaContext.getRequestIp' },
  },
  'optional.responseHeaders': {
    kind: 'optional',
    description: 'AsenaContext.setResponseHeader and AsenaContext.appendResponseHeader are optional.',
    contract: {
      kind: 'member',
      file: 'lib/adapter/AsenaContext.ts',
      member: ['AsenaContext.setResponseHeader', 'AsenaContext.appendResponseHeader'],
    },
  },
  'optional.zodValidator': {
    kind: 'optional',
    description: 'The legacy validator dialect is the adapter type parameter VS; zod is one dialect.',
    contract: {
      kind: 'non-member',
      reason: 'AsenaAdapter<C, VS> leaves the validator schema dialect to the adapter (lib/adapter/AsenaAdapter.ts)',
    },
  },
  'optional.builtinCors': {
    kind: 'optional',
    description: 'A built-in CORS middleware is an adapter extra, exposed through descriptor.builtins.cors.',
    contract: { kind: 'non-member', reason: 'built-in middlewares are adapter extras, not contract members' },
  },
  'optional.builtinRateLimiter': {
    kind: 'optional',
    description:
      'A built-in rate limiter middleware is an adapter extra, exposed through descriptor.builtins.rateLimiter.',
    contract: { kind: 'non-member', reason: 'built-in middlewares are adapter extras, not contract members' },
  },
});

export const divergenceFlags = Object.freeze(
  (Object.keys(capabilities) as CapabilityFlag[]).filter((flag) => capabilities[flag].kind === 'divergence'),
);

export const optionalFlags = Object.freeze(
  (Object.keys(capabilities) as CapabilityFlag[]).filter((flag) => capabilities[flag].kind === 'optional'),
);
