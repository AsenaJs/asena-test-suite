# @asenajs/adapter-conformance

The adapter conformance suite for [AsenaJS](https://asena.sh). It boots real Asena applications on your `AsenaAdapter`
implementation and checks that routing, errors, the `AsenaContext` surface, middleware, validation, streaming, static files,
WebSockets, lifecycle, the core test harness and the optional built-ins behave the way Asena expects. Every scenario has a
stable ID such as `[P1.routing.040]`.

You run it inside your own adapter repository, against your adapter's own source or build. The suite needs no services, no
network and no configuration besides one descriptor file.

## Install

```bash
bun add -d @asenajs/adapter-conformance
```

Peers: `@asenajs/asena` (`^0.12.0`, which your adapter already peers) and, optionally, `zod`. Add `zod` only if your adapter
supports zod schemas as its legacy validator dialect (`optional.zodValidator: true` below); nothing else in the suite needs it.

Requires Bun `>= 1.4.0`.

## Two files

`test/conformance.adapter.ts` describes your adapter:

```ts
import type { AdapterDescriptor } from '@asenajs/adapter-conformance';
import { Context, CorsMiddleware, createMyAdapter, RateLimiterMiddleware } from '../index';

export const descriptor: AdapterDescriptor = {
  id: 'my-adapter',
  packageName: '@acme/my-adapter',
  createAdapter: ({ logger }) => createMyAdapter({ logger }),
  defineContext: (schemas) => Context.define(schemas as never),
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
```

`test/conformance.test.ts` is the one-file entry:

```ts
import { runConformance } from '@asenajs/adapter-conformance';
import { descriptor } from './conformance.adapter';

runConformance({ ...descriptor, packageRoot: import.meta.dir });
```

Run it:

```bash
bun test test/conformance.test.ts
```

Import your adapter from your own entry (source or build, whatever `main`/`exports` point at); do not install your own package
as a dependency. Annotated copies of both files are in `examples/` of the source repository.

If your build `tsconfig.json` compiles `test/` (an `exclude` of only `**/*.test.ts` does), `conformance.adapter.ts` ends up in
your published output. Exclude it, for example with `"exclude": ["test/**"]`.

`runConformance` registers every scenario synchronously while Bun loads the file, so call it once, at the top level of a test
file (not inside a test or after an `await`). `packageRoot` is the directory the single-core guard resolves `@asenajs/asena` from: in
your repo the package is not installed under `node_modules/<packageName>`, so the guard needs to be told where your adapter's
dependencies live. `import.meta.dir` of the entry file is enough; any directory inside the repo works.

## The descriptor

```ts
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
```

- `createAdapter` is called once per booted application. Return a new adapter built with your factory's defaults; if your
  factory returns more than the adapter (for example an `[adapter, logger]` tuple), return the adapter.
- `defineContext` is your `Context.define`; the route-context-contract scenarios declare their contracts through it with a
  plain Standard Schema object, never with zod.
- `cliTemplate` is not read by any scenario in this package.
- `builtins` (see below) is required only when the matching `optional.builtin*` flag is `true`.

`runConformance` throws `setDescriptor: ...` before any test runs when a required member is missing or has the wrong type, when
an optional flag is missing from `capabilities`, or when an `optional.builtin*` flag is `true` without its factory.

## Optional flags

A flag exists only where core declares the member optional or where the feature is outside the adapter contract. A required
contract member never has a flag: your adapter must implement it, and its scenarios always run. Set a flag to `false` only when
your adapter really does not provide the feature; its scenarios are then reported as skipped with `[cap:<flag>]` in the title.

| Flag | Why it is optional (core 0.12) | Scenarios it gates |
|---|---|---|
| `optional.notFoundHook` | `AsenaAdapter.onNotFound?` (`lib/adapter/AsenaAdapter.ts`) | P1.routing.050-051, P1.static.008 |
| `optional.unixSocket` | `AsenaStartOptions.unix?` (`lib/adapter/types/ServeOptions.ts`; adapters may ignore start options they do not support) | P1.lifecycle.004, P1.harness.020 |
| `optional.routePattern` | `AsenaContext.routePattern?` (`lib/adapter/AsenaContext.ts`) | P1.routing.070-071 |
| `optional.requestIp` | `AsenaContext.getRequestIp?` (`lib/adapter/AsenaContext.ts`) | P1.context.062 |
| `optional.responseHeaders` | `AsenaContext.setResponseHeader?` and `appendResponseHeader?` (`lib/adapter/AsenaContext.ts`) | P1.context.060-061, P1.streaming.020 |
| `optional.zodValidator` | not a member: the legacy validator dialect is the adapter's `VS` type parameter (`AsenaAdapter<C, VS>`), zod is one dialect | P1.validation.001-010, P1.smoke.002, P1.errors.042, P1.middleware.010, P1.harness.011 |
| `optional.builtinCors` | not a member: built-in middlewares are adapter extras | P1.builtins.001-007, P1.smoke.004 (also need `builtins.cors`) |
| `optional.builtinRateLimiter` | not a member: built-in middlewares are adapter extras | P1.builtins.010-013 (also need `builtins.rateLimiter`) |

Route context contracts (`Context.define`, P1.validation.020-031) are part of the contract and carry no flag.

## Built-ins

`builtins.cors` and `builtins.rateLimiter` receive exactly these neutral options. Translate the keys in the factory if your
classes name them differently; the scenarios never pass anything else.

```ts
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
```

The factory returns an undecorated class whose zero-argument constructor applies the options; the scenario subclasses it and
registers the subclass with `@Middleware()`.

## Reading the verdict

- Every scenario is always registered, so the collected ID set is the same for every adapter.
- A skip always carries its reason in the title: `[cap:optional.*]` for a flag you set to `false`, `[cap:member:*]` for a missing
  descriptor member, `[svc:<name>]` for a missing external service (no scenario in this package declares one). Anything else
  is a pass or a failure.
- There is no way to declare an expected failure. A scenario your adapter does not satisfy fails, and the failure message is the
  assertion that did not hold.
- `P1.resolution.010` fails with `NOT-CONFORMANT: descriptor declares divergence flags or unknown keys: ...` when the descriptor
  passed to `runConformance` carries a `divergences` property, a capability key that is not one of the optional flags above, or
  any other unknown key. Remove the key.
- Bun exits non-zero when anything failed. For a machine-readable report add `--reporter=junit --reporter-outfile=<file>`; if
  your `bunfig.toml` declares `[test.reporter] junit = "<path>"`, Bun writes the report to that path instead.

## Resolution guards

These run first and explain most broken setups:

| ID | Checks | When it fails |
|---|---|---|
| `P1.resolution.001` | one `@asenajs/asena` copy: the package's and your adapter's resolve to the same file | a second core (for example a nested `node_modules/@asenajs/asena` under a linked package); dedupe so that only your repo's peer copy remains, and check `packageRoot` |
| `P1.resolution.002` | a `@PostConstruct` hook runs in an app booted with your adapter | the DI container silently does nothing, almost always because of two core copies (see 001) |
| `P1.resolution.003` | the installed core satisfies this package's peer range (`^0.12.0`) | upgrade `@asenajs/asena` in your repo |
| `P1.resolution.004` | the package's own fixtures carry legacy decorator metadata | `NOT-CONFIGURED: ...` means this package was built without `experimentalDecorators`/`emitDecoratorMetadata`; that is a broken release of this package, not your setup - please report it |
| `P1.resolution.010` | the descriptor carries no divergence flags or unknown keys | `NOT-CONFORMANT: ...`, see above |

## TypeScript

The package ships compiled JavaScript and `.d.ts` files. Your `tsconfig.json` does not change how the suite's own fixtures are
compiled, and the suite runs with or without one. Your adapter's own decorators (if any) still need your own
`experimentalDecorators` and `emitDecoratorMetadata`, as always with Asena on Bun. The two entry files contain no decorators and
typecheck under `strict`.

## Helpers

`@asenajs/adapter-conformance/helpers` exports the client-side helpers the scenarios use (`openWs`, `readSse`, `collectSse`,
`readChunks`, `waitFor`, `withTimeout`, `bootApps`, `recordCalls`, `randomPort`, `isPortFree`, `TestSocket`). They are
optional for your own tests.

## License

MIT
