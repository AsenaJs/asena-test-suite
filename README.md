# asena-test-suite

One test suite for every Asena HTTP adapter. The same scenarios run against `@asenajs/ergenecore`, `@asenajs/hono-adapter` and any
third-party adapter, and no scenario knows which adapter it is running on.

- **Part 1** - `packages/conformance`, published as [`@asenajs/adapter-conformance`](packages/conformance/README.md): the adapter
  contract (routing, errors, context, middleware, validation, streaming, static, WebSocket, lifecycle, test harness, built-ins).
  Adapter authors run it in their own repository; that README is their guide.
- **Part 2** - `ecosystem/`, private: the official ecosystem packages (logger, drizzle, redis, kafka, openapi, otel, CLI, ...)
  on top of each adapter. It reuses Part 1's runtime and helpers and never re-tests the adapter contract.

This file is the maintainer guide.

## Layout

```
package.json            workspaces packages/* and ecosystem; "overrides" pins one @asenajs/asena
tsconfig.base.json      experimentalDecorators + emitDecoratorMetadata; paths map the package to its src/
adapters/<name>.ts      first-party descriptors + divergence maps - the only files that import an adapter package
CONVERGENCE.md          one row per divergence flag -> convergence work package
compose.yaml            redis, kafka (KRaft), postgres for Part 2
tools/select-adapter.ts maintainer selector, preloaded by the workspace bunfig.toml files
tools/pack-local.ts     pack local refs into tarballs and install them (convergence / pre-release lines)
tools/validate/         the validator; tools/validate/packed/ is the packed-artifact leg
tools/helpers-test/     unit tests of the helpers against plain Bun.serve
packages/conformance/   src/ (scenarios, fixtures, runtime), test/<area>.test.ts (maintainer entries), dist/ (built)
ecosystem/              run.ts (Part 2 driver), src/services.ts, modules/<module>/, test/
reports/validator/      dated validator run reports
```

## Install and run

```bash
bun install                                   # published mode: npm releases of core and both adapters
ASENA_ADAPTER=ergenecore bun run test:p1      # Part 1, one adapter
ASENA_ADAPTER=hono bun run test:p1
ASENA_ADAPTER=hono bun run test:p2            # Part 2 driver (--module <name> to filter)
bun run test:helpers
bun run check && bun run build && bun run typecheck
bun run validate                              # every validator check, both adapters
```

`ASENA_ADAPTER` accepts `ergenecore`, `hono` or a path to a module whose default export is an `AdapterDescriptor`. The workspace
`bunfig.toml` files preload `tools/select-adapter.ts`, which loads the descriptor and hands it to the runtime; without
`ASENA_ADAPTER` nothing is selected and the scenarios fail with `No adapter descriptor is set. ...`. Inside the suite the package specifiers
resolve to `packages/conformance/src` through tsconfig `paths`, so no build is needed to run tests. `bun run build` compiles the
package to `dist/` (tsc with both decorator flags, then copies the non-TypeScript fixtures).

## Resolution modes

**Published (default).** The root devDepends on the released `@asenajs/asena`, `@asenajs/ergenecore`, `@asenajs/hono-adapter`,
`hono` and `zod`; `ecosystem/package.json` on the released ecosystem packages. The root `overrides` keeps exactly one core
copy (the CLI hard-depends on an older core); `P1.resolution.001-003` and `P2.resolution.*` fail when that breaks.

**Pack-local.** For convergence work and pre-release lines:

```bash
bun run pack:local -- --workspace /path/to/asena-monorepo                       # every repo at origin/master
bun run pack:local -- --workspace <dir> --ref Asena=<ref> --pkg @asenajs/ergenecore=<dir>
bun run pack:local -- --restore                                                 # back to published mode
```

Each repo is fetched, `git archive`d at its ref (default `origin/master`), installed, built and packed into `.local-packs/`;
the root manifests are rewritten to the `file:` tarballs. A default-ref pack is refused unless its version equals the npm
release, so a stale checkout cannot pass for the published line; `--ref`/`--pkg` packs skip that check and print `UNRELEASED`.
The tool also refuses a core that does not satisfy the conformance or adapter peer ranges, and prints version, ref, SHA and
released/UNRELEASED per package. Run it in a dedicated worktree and never commit the rewritten `package.json`/`bun.lock`.

## Divergences (maintainer only)

A divergence flag records that a first-party adapter does not yet do what a shared scenario expects. It lives only in
`adapters/<name>.ts` (`export const divergences = { '<flag>': false }`) and applies only on the maintainer path
(`ASENA_ADAPTER=ergenecore|hono`, or a path inside `adapters/`). The scenario stays shared and runs in divergence mode on that
adapter: an assertion failure is expected and passes with `[cap:<flag>]` in the title; a pass is reported as `STALE FLAG`, any
other error as `UNEXPECTED (flag ...)`. `ASENA_SUITE_FORCE_CAPS=<flag>[,...]` treats listed flags as on, to prove a convergence
fix. Everywhere else - `runConformance`, the published package, a descriptor path outside `adapters/` - every flag is on, and a
descriptor that carries `divergences` fails `P1.resolution.010` with `NOT-CONFORMANT`.

A flag is added only through the parity classification (WP-07) and its apply step (WP-07b), never to make a failing scenario
pass, and always together with:

1. the flag in `packages/conformance/src/capabilities.ts` (kind `divergence`, its `convergence` work package) and in the
   `DivergenceFlag` union in `src/descriptor.ts`;
2. the `false` entry in the adapter's `divergences` map;
3. a `CONVERGENCE.md` row with the flag, the adapter, the justification (`origin/master` citations) and the convergence work
   package;
4. `requires: ['<flag>']` on the scenario.

When the adapter fix is released, the flag is removed in all four places.

## External services (Part 2)

Part 1 needs no service. Part 2 scenarios that need one are registered and skipped with `[svc:<name>]` unless it is configured:

| Variable | Service |
|---|---|
| `ASENA_SUITE_REDIS_URL` | Redis |
| `ASENA_SUITE_POSTGRES_URL` | Postgres |
| `ASENA_SUITE_KAFKA_BROKERS` | Kafka |
| `ASENA_SUITE_SLOW=1` | slow scenarios (leak simulation, CLI install, minute-level cron) |
| `ASENA_SUITE_MIXED=ergenecore,hono` | pods of different adapters in one test |
| `ASENA_SUITE_REQUIRE_SERVICES=1` | an unset or unreachable service fails instead of skipping |

`docker compose up -d` or `podman compose up -d` starts redis, kafka and postgres from `compose.yaml`
(`ASENA_SUITE_REDIS_PORT`, `ASENA_SUITE_KAFKA_PORT` and `ASENA_SUITE_POSTGRES_PORT` move the host ports). Every run works in its
own namespace (Postgres schema, Redis key prefix, Kafka topic and group prefix), so both adapters can share the containers.

## Validator

`bun run validate` runs every check and exits with the OR of the failing checks' bits. `-- --fast` runs 1, 2, 3 and 5;
`-- --only <1|2|3|4|4b|5>` runs single checks.

| Check | Bit | What it enforces |
|---|---|---|
| 1 imports | 1 | no adapter or `hono` import outside `adapters/`; nothing imports `adapters/` or `src/maintainer.ts` except the selector; packaging: `packages/conformance/src` imports only itself, `@asenajs/asena*`, `bun:*`, node builtins and (in `fixtures/zod*.ts`, loaded by a literal `import()`) `zod`; no computed `import()`/`require()`; no raw `it`/`test` in scenario files |
| 2 identity | 2 | outside the exempt set (`adapters/`, `tools/`, `load.ts`, `maintainer.ts`, the resolution area, `examples/`): no adapter-name literals, no reads of descriptor identity members, `capabilities` or `divergences`, no `.name` on an adapter, no `ASENA_ADAPTER` read, no branching on `runTag()`/`adapterPackageRoot()`, no descriptor enumeration or `as any` casts |
| 3 manifests | 4 | no adapter in the package manifests; `zod` only as an optional peer; `files` is `dist` + `README.md`; `exports` only `.` and `./helpers` under `dist/`; bunfig preloads |
| 5 flags | 16 | every divergence flag has a convergence work package and a `CONVERGENCE.md` row; first-party descriptors set every optional flag `true`; every optional flag cites a core member that the installed core really declares optional |
| 4 parity | 8 | per adapter: Part 1, Part 2 and a generated `runConformance` entry; ID grammar and uniqueness; identical ID sets across adapters and between Part 1 and the entry; every skip tagged; no stale, wrong-cause or dead flags; both rogue entries fail with `NOT-CONFORMANT` |
| 4b packed | 32 | builds and packs the package, then for each first-party adapter makes an adapter-as-root project from the released adapter (`git archive v<installed version>` of a local workspace, or the npm tarball without a root tsconfig), installs the tarball, generates the descriptor, typechecks the generated files with a strict consumer tsconfig without decorator flags, runs the one-file entry and requires the Part 1 status for every ID - except the adapter's divergence IDs, which must fail there |

Check 4b uses `--workspace <dir>` (or `ASENA_SUITE_WORKSPACE`, or the suite's parent directory when it holds `ergenecore/.git`)
for the archive variant; `ASENA_SUITE_WORKSPACE=` (set and empty) selects the npm variant. `--keep` keeps the temporary projects.
`bun test tools/validate` runs the validator's own fixture tests.

## Adding a scenario

- Register it with `scenario(id, title, fn, { requires, members, services })` inside the area's `register()`; never raw
  `it`/`test`. IDs follow `^\[(P[12](?:\.[A-Za-z0-9-]+){2,})\]` and the second segment is the area (Part 1) or module (Part 2)
  directory: `P1.routing.072`, `P2.microservice.contract.memory.C01`. IDs are never renumbered.
- `requires` lists optional flags (`optional.*`) when the scenario uses a member core declares optional, and divergence flags
  only through the procedure above. `members` lists optional descriptor members the body reads (`cliTemplate`, `builtins.*`).
- Area modules have no top-level side effects: read the descriptor through `getDescriptor()` inside a test body or
  `register()`, boot apps with `bootApp()` and stop them with `await using` or in `afterEach`, wait with the helpers'
  conditions instead of fixed sleeps.
- Fixtures use core types only (`AsenaContext`, `AsenaMiddlewareService`, `AsenaConfig`, ...); route contracts use the
  hand-written Standard Schema fixture. Everything a Part 1 scenario reads at run time - pages, static files, fixtures - lives
  under `packages/conformance/src/`, is located with `import.meta.dir` and is imported with a literal specifier, so it ships
  in `dist/`.
- When a shared scenario fails on one adapter, the adapter is assumed wrong: do not weaken the assertion and do not branch on
  the adapter; record the failure for classification.
