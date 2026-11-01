import type { AsenaAdapter, AsenaContext } from '@asenajs/asena/adapter';
import type { ServerLogger } from '@asenajs/asena/logger';

/** Contract-optional members. The only flags a descriptor can carry. Each cites its core declaration (`capabilities`). */
export type OptionalFlag =
  | 'optional.notFoundHook'
  | 'optional.unixSocket'
  | 'optional.routePattern'
  | 'optional.requestIp'
  | 'optional.responseHeaders'
  | 'optional.zodValidator'
  | 'optional.builtinCors'
  | 'optional.builtinRateLimiter';

/** The exact keys the builtins scenarios pass. A descriptor translates them if its adapter names them differently. */
export interface ConformanceCorsOptions {
  origin?: '*' | string[];
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

export interface ConformanceRateLimiterOptions {
  capacity?: number;
  refillRate?: number;
  keyGenerator?: (context: AsenaContext<any, any>) => string;
}

/** Maintainer bookkeeping for first-party adapters. Not part of AdapterDescriptor; not exported from the package index. */
export type DivergenceFlag =
  | 'routing.trailingSlashAlias'
  | 'ws.startAwaitsTransportInit'
  | 'middleware.codeAfterNextRuns'
  | 'routing.unmatchedRoutePatternUnset'
  | 'context.absentValuesMatchDeclaredTypes'
  | 'context.invalidJsonIsBadRequest'
  | 'context.emptyBodyIsEmptyObject'
  | 'streaming.sseErrorCallbackOwnsOutput'
  | 'streaming.sseWriterStateIsLive'
  | 'static.overrideNotFoundContinuesToHandler'
  | 'static.encodedPathIsDecodedAndChecked'
  | 'static.encodedSlashInRootIsServed'
  | 'static.missKeepsRoutePattern'
  | 'static.missDoesNotFallThrough'
  | 'static.nulPathIsNotFound'
  | 'routing.userRootWildcardAnswers';

export type CapabilityFlag = OptionalFlag | DivergenceFlag;

export type DescriptorMember = 'cliTemplate' | 'builtins.cors' | 'builtins.rateLimiter';

export interface AdapterDescriptor {
  /** Context-adapter id, e.g. 'my-adapter' - the string assertContextAdapter checks. */
  readonly id: string;
  /** npm name of the adapter package. */
  readonly packageName: string;
  /** Directory the single-core guard resolves @asenajs/asena from (third parties: import.meta.dir of the entry file). */
  readonly packageRoot?: string;
  /** Fresh instance per app; adapters are single-use. Factory defaults only - no parity hacks. */
  createAdapter(options: { logger: ServerLogger }): AsenaAdapter<any, any>;
  /** The adapter's Context.define, for route-context-contract scenarios. */
  defineContext(schemas: object): new (...args: any[]) => unknown;
  /** `asena create --adapter=<cliTemplate>` value. Absent = the CLI has no template for this adapter. */
  readonly cliTemplate?: string;
  /**
   * Optional built-in middlewares. Each factory returns a class with a zero-argument constructor that already carries the
   * given options (typically `class extends AdapterCors { constructor() { super(mapped) } }`); the scenario extends it
   * and decorates its own subclass with `@Middleware()`. Never return a decorated class or an instance.
   */
  builtins?: {
    cors?(options: ConformanceCorsOptions): abstract new () => object;
    rateLimiter?(options: ConformanceRateLimiterOptions): abstract new () => object;
  };
  readonly capabilities: Readonly<Record<OptionalFlag, boolean>>;
}
