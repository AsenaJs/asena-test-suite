# Parity report 2026-11-01 (WP-07)

Suite commit `f0c3309` (branch `feat/adapter-conformance`), published mode (root `package.json` / `bun.lock` unmodified), Bun 1.4.4.
Junit of run 1 is in `junit/`; runs 2 and 3 and the forced runs were kept in `out/parity/` (gitignored). The table was derived
from the junit files by a throwaway script (status per `[ID]`, `[cap:*]` / `[svc:*]` title tags, forced-run failure messages).

## Versions

| Package | Version |
|---|---|
| `@asenajs/asena` | 0.12.1 (one copy; `P1.resolution.001` / `P2.resolution.001` pass) |
| `@asenajs/ergenecore` | 5.0.1 (`origin/master` `0a2cc6d`) |
| `@asenajs/hono-adapter` | 5.0.2 (`origin/master` `020d248`) |
| `hono` / `zod` | 4.13.14 / 4.6.7 |
| `@asenajs/adapter-conformance` | 0.12.0-dev.0 (workspace) |
| `@asenajs/asena-cli` | 0.11.1 |
| `@asenajs/asena-drizzle` | 4.0.1 |
| `@asenajs/asena-kafka` | 4.0.1 |
| `@asenajs/asena-logger` | 3.0.1 |
| `@asenajs/asena-openapi` | 3.2.0 |
| `@asenajs/asena-otel` | 3.0.1 |
| `@asenajs/asena-redis` | 4.0.1 |

## Setup

Services: the local containers `asena-redis` (redis:7-alpine, :6379), `asena-kafka` (apache/kafka:3.9.1, :9092) and `postgres`
(postgres:latest, :5432). `podman compose up -d --wait` was not used: those containers already bind the compose ports.

```bash
export ASENA_SUITE_REDIS_URL=redis://localhost:6379
export ASENA_SUITE_POSTGRES_URL=postgres://postgres:postgres@localhost:5432/postgres
export ASENA_SUITE_KAFKA_BROKERS=localhost:9092
export ASENA_SUITE_REQUIRE_SERVICES=1 ASENA_SUITE_MIXED=ergenecore,hono ASENA_SUITE_SLOW=1
export ASENA_SUITE_KAFKA_RESTART_CMD="docker restart asena-kafka"
for a in ergenecore hono; do
  ASENA_ADAPTER=$a bun run test:p1 --reporter=junit --reporter-outfile=$PWD/out/parity/runN/p1-$a.xml
  ASENA_ADAPTER=$a bun run test:p2 --reporter=junit --out out/parity/runN/p2-$a.xml
done
```

## Results

Three full runs, adapters one after the other (kafka R9 and MX4 restart the shared broker), nothing else running on the machine.

| Run | P1 ergenecore | P2 ergenecore | P1 hono | P2 hono |
|---|---|---|---|---|
| 1 | 207 pass / 0 fail / 0 skip (3 s) | 179 / 0 / 0 (255 s) | 207 / 0 / 0 (4 s) | 179 / 0 / 0 (237 s) |
| 2 | 207 / 0 / 0 (4 s) | 179 / 0 / 0 (274 s) | 207 / 0 / 0 (3 s) | 179 / 0 / 0 (233 s) |
| 3 | 207 / 0 / 0 (3 s) | 179 / 0 / 0 (239 s) | 207 / 0 / 0 (3 s) | 179 / 0 / 0 (237 s) |

Collected IDs: 386 (207 P1 + 179 P2), the same set on both adapters; no ID is missing on either side.

Verdicts: **ok 366, flag-correct 18, measure 2**; flag-stale 0, flag-wrong-cause 0, adapter-bug 0, suite-bug 0.

### Flaky

None: every ID has the same status in all three runs on both adapters. Slowest scenarios (min-max over the three runs):
ergenecore P2.core.011 11.0-47.1 s (waits for the next minute boundary), P2.microservice.resilience.kafka.R9 18.0-19.9 s,
P2.microservice.mixed.MX4 17.3-18.6 s (both restart the broker); hono P2.microservice.resilience.kafka.R9 18.4-19.1 s,
P2.microservice.mixed.MX4 17.5-17.6 s, P2.core.011 11.0-14.0 s. Every other scenario stays under 7.3 s.

## Forced runs (`ASENA_SUITE_FORCE_CAPS=<flag>`)

Each flag forced on, gated IDs only (`-t`), on the adapter that declares it off and, as control, on the other adapter. Every
forced failure is an `expect(` assertion naming the documented cause; every control passes.

| Flag | Off for | Gated IDs | Forced failure on the off adapter | Control |
|---|---|---|---|---|
| `middleware.codeAfterNextRuns` (WP-55) | ergenecore | P1.routing.070 | `Expected: "/items/:id" Received: undefined` | hono 4/4 pass |
| | | P1.middleware.022 | `Expected: "added" Received: null` | |
| | | P1.context.045 | records `[]` instead of 4 `{method, status, url}` | |
| | | P1.errors.014 | `Expected: 503 Received: 200` | |
| | | P2.otel.003 | status attributes `[200, 201, undefined, undefined, 404]` vs `[200, 201, 403, 400, 404]` | hono 1/1 pass |
| `routing.trailingSlashAlias` (WP-51) | hono | P1.routing.040 | `Expected: 200 Received: 404` | ergenecore 1/1 |
| `routing.unmatchedRoutePatternUnset` (WP-56) | hono | P1.routing.071 | `toBeUndefined()` `Received: "/*"` | ergenecore 1/1 |
| `context.absentValuesMatchDeclaredTypes` (WP-57) | hono | P1.context.013 | `getQueryAll` `Expected: [] Received: undefined` | ergenecore 2/2 |
| | | P1.context.030 | `getCookie` `Expected: false Received: undefined` | |
| `context.invalidJsonIsBadRequest` (WP-58) | hono | P1.context.006 | onError `{httpException: false, name: 'SyntaxError'}` vs `{httpException: true, status: 400}` | ergenecore 1/1 |
| `streaming.sseErrorCallbackOwnsOutput` (WP-59) | hono | P1.streaming.006 | extra frame `{event:'error', data:'writeSSE: message needs data or comment'}` | ergenecore 2/2 |
| | | P1.streaming.007 | extra frame `{event:'error', data:'Database connection lost'}` | |
| `streaming.sseWriterStateIsLive` (WP-60) | hono | P1.streaming.008 | `stream.aborted` `Expected: true Received: false` (after `onAbort` fired) | ergenecore 1/1 |
| `static.overrideNotFoundContinuesToHandler` (WP-61) | hono | P1.static.006 | `Expected: 200 Received: 404` (hook ran once) | ergenecore 1/1 |
| `ws.startAwaitsTransportInit` (WP-50) | hono | P1.websocket.040 | `initCompleted` `Expected: true Received: false` | ergenecore 2/2 |
| | | P1.websocket.041 | `initPendingAfterStart` `Expected: false Received: true` | |
| | | P2.redis-ws.010 | `initPendingAfterStart` `Expected: false Received: true` | ergenecore 2/2 |
| | | P2.redis-ws.011 | server set on pod A, pod B `Expected: [true, true] Received: [false, false]` | |

The P2 forced runs exit 1 only because `-t` matches nothing in the driver prelude (`regex ... matched 0 tests`); the module results
are as listed.

## Measured scenarios (WP-07 step 5)

Both adapters' behaviour, measured by the shared assertion (exact values) or, for gated / range scenarios, by the forced run and a
raw-socket probe. "Recommend" is the expected value the suite should pin.

| ID | ergenecore | hono | Recommend | Verdict |
|---|---|---|---|---|
| P1.routing.023 | OPTIONS on a GET-only route 404 `{error:'Not Found'}`; `@All` 200 | same | as pinned (no CORS means no implicit OPTIONS) | ok |
| P1.routing.024 | raw TRACE: `@Trace` 200, GET-only path 404, next GET 200 | same | as pinned | ok |
| P1.routing.025 | raw CONNECT: `@Connect` 200, GET-only path 404, next GET 200 | same | as pinned | ok |
| P1.routing.071 | `routePattern` unset on an unmatched request | `"/*"` | unset (`AsenaContext.ts:45`: set after matching) | flag-correct (WP-56) |
| P1.context.006 | invalid JSON -> `HttpException(400)` in `onError` | raw `SyntaxError` (500 by default) | 400; maintainer decision | flag-correct (WP-58) |
| P1.context.013 | absent key: `getQuery` undefined, `getAllQueries` `{}`, `getQueryAll` `[]` | `getQueryAll` undefined | `[]` (declared `Promise<string[]>`) | flag-correct (WP-57) |
| P1.errors.041 | contract failure without `onError`: 400, `application/json`, `{error:'Validation failed', target:'body', issues:[{message, path:['name']}]}` | identical | as pinned | ok |
| P1.static.006 | `@Override` static `onNotFound`: hook once, handler answers 200 | hook once, 404 | 200; maintainer decision | flag-correct (WP-61) |
| P1.static.008 | static `onNotFound` hook once, then config `onNotFound` 404 `{shaped:true}` | same | as pinned | ok |
| P1.static.010 | `..%2f` / `%2e%2e%2f` / `..%2fpublic-private%2f` -> **403** `Forbidden`; six other targets 404; no leak | encoded-slash targets **404** `{error:'Not Found'}`; six others 404; no leak | 403 for the encoded-slash targets; maintainer decision (`FINDINGS.md`) | measure |
| P1.static.011 | `%zz`, `100%`, `%e0%a4%a` -> **400** `{error:'Bad Request'}` | **404** `{error:'Not Found'}` | 400; maintainer decision | measure |
| P1.static.024 | boot rejected, "HTML route collision" naming `/collide` | same | as pinned | ok |
| P1.validation.008 | hook returning a Response: 422 `{hooked:true}`, handler not run; valid body 200 | same | as pinned | ok |
| P1.validation.009 | `validatorCache: true`: 3 x (200 / 400), schema factory called once | same | as pinned | ok |
| P1.middleware.003 | unmatched `/api/protected/missing` 401 without auth, 404 with; other unmatched paths 404; pattern stamps exact | same | as pinned | ok |
| P1.middleware.013 | undecorated subclass of a decorated guard: boot fails with core's "is not a component" | same | as pinned | ok |
| P1.middleware.021 | short-circuit Response: 299 + `x-short-circuit: yes`, handler not run | same | as pinned | ok |
| P1.streaming.006 | frame without data or comment rejects into the error callback, nothing written | one extra `event: error` frame from Hono's helper | nothing written; maintainer decision | flag-correct (WP-59) |
| P1.websocket.033 | `sendBinary` returns -1 at `backpressureLimit`, `onDrain` fires, every frame arrives | same | as pinned | ok |
| P1.lifecycle.010 | sync `serveOptions()` `maxRequestBodySize`: small body 200, large 413 | same | as pinned | ok |
| P1.lifecycle.041 | `stop(false)` lets the in-flight request finish 200; `stop()` closes it | same | as pinned | ok |
| P1.builtins.001 | CORS preflight 204, `access-control-allow-origin: *`, methods include PUT | same | as pinned | ok |

Raw-socket probe for P1.static.010/011 (both adapters, all other targets): `/static/../secret/secret.txt`,
`/static/%2e%2e/secret/secret.txt`, `/static/%252e%252e%252fsecret%252fsecret.txt`, `/static/..\secret\secret.txt`,
`/static/..%5csecret%5csecret.txt` and `/static/../../../../../../../../etc/passwd` answer 404 `{error:'Not Found'}` on both (the
first two are normalised before routing). `/static/hello%2etxt` serves the file (200) on both.

## All IDs

| ID | ergenecore | hono | declared flag | verdict |
|---|---|---|---|---|
| P1.builtins.001 | pass | pass | - | ok |
| P1.builtins.002 | pass | pass | - | ok |
| P1.builtins.003 | pass | pass | - | ok |
| P1.builtins.004 | pass | pass | - | ok |
| P1.builtins.005 | pass | pass | - | ok |
| P1.builtins.006 | pass | pass | - | ok |
| P1.builtins.007 | pass | pass | - | ok |
| P1.builtins.010 | pass | pass | - | ok |
| P1.builtins.011 | pass | pass | - | ok |
| P1.builtins.012 | pass | pass | - | ok |
| P1.builtins.013 | pass | pass | - | ok |
| P1.context.001 | pass | pass | - | ok |
| P1.context.002 | pass | pass | - | ok |
| P1.context.003 | pass | pass | - | ok |
| P1.context.004 | pass | pass | - | ok |
| P1.context.005 | pass | pass | - | ok |
| P1.context.006 | pass | pass (divergence mode) | `context.invalidJsonIsBadRequest` | flag-correct |
| P1.context.007 | pass | pass | - | ok |
| P1.context.010 | pass | pass | - | ok |
| P1.context.011 | pass | pass | - | ok |
| P1.context.012 | pass | pass | - | ok |
| P1.context.013 | pass | pass (divergence mode) | `context.absentValuesMatchDeclaredTypes` | flag-correct |
| P1.context.020 | pass | pass | - | ok |
| P1.context.021 | pass | pass | - | ok |
| P1.context.030 | pass | pass (divergence mode) | `context.absentValuesMatchDeclaredTypes` | flag-correct |
| P1.context.031 | pass | pass | - | ok |
| P1.context.032 | pass | pass | - | ok |
| P1.context.033 | pass | pass | - | ok |
| P1.context.034 | pass | pass | - | ok |
| P1.context.040 | pass | pass | - | ok |
| P1.context.041 | pass | pass | - | ok |
| P1.context.045 | pass (divergence mode) | pass | `middleware.codeAfterNextRuns` | flag-correct |
| P1.context.050 | pass | pass | - | ok |
| P1.context.051 | pass | pass | - | ok |
| P1.context.052 | pass | pass | - | ok |
| P1.context.053 | pass | pass | - | ok |
| P1.context.054 | pass | pass | - | ok |
| P1.context.055 | pass | pass | - | ok |
| P1.context.060 | pass | pass | - | ok |
| P1.context.061 | pass | pass | - | ok |
| P1.context.062 | pass | pass | - | ok |
| P1.errors.001 | pass | pass | - | ok |
| P1.errors.002 | pass | pass | - | ok |
| P1.errors.003 | pass | pass | - | ok |
| P1.errors.010 | pass | pass | - | ok |
| P1.errors.011 | pass | pass | - | ok |
| P1.errors.012 | pass | pass | - | ok |
| P1.errors.013 | pass | pass | - | ok |
| P1.errors.014 | pass (divergence mode) | pass | `middleware.codeAfterNextRuns` | flag-correct |
| P1.errors.015 | pass | pass | - | ok |
| P1.errors.020 | pass | pass | - | ok |
| P1.errors.021 | pass | pass | - | ok |
| P1.errors.022 | pass | pass | - | ok |
| P1.errors.030 | pass | pass | - | ok |
| P1.errors.040 | pass | pass | - | ok |
| P1.errors.041 | pass | pass | - | ok |
| P1.errors.042 | pass | pass | - | ok |
| P1.harness.001 | pass | pass | - | ok |
| P1.harness.002 | pass | pass | - | ok |
| P1.harness.003 | pass | pass | - | ok |
| P1.harness.004 | pass | pass | - | ok |
| P1.harness.010 | pass | pass | - | ok |
| P1.harness.011 | pass | pass | - | ok |
| P1.harness.012 | pass | pass | - | ok |
| P1.harness.013 | pass | pass | - | ok |
| P1.harness.020 | pass | pass | - | ok |
| P1.harness.030 | pass | pass | - | ok |
| P1.lifecycle.001 | pass | pass | - | ok |
| P1.lifecycle.002 | pass | pass | - | ok |
| P1.lifecycle.003 | pass | pass | - | ok |
| P1.lifecycle.004 | pass | pass | - | ok |
| P1.lifecycle.005 | pass | pass | - | ok |
| P1.lifecycle.006 | pass | pass | - | ok |
| P1.lifecycle.010 | pass | pass | - | ok |
| P1.lifecycle.011 | pass | pass | - | ok |
| P1.lifecycle.020 | pass | pass | - | ok |
| P1.lifecycle.030 | pass | pass | - | ok |
| P1.lifecycle.031 | pass | pass | - | ok |
| P1.lifecycle.032 | pass | pass | - | ok |
| P1.lifecycle.040 | pass | pass | - | ok |
| P1.lifecycle.041 | pass | pass | - | ok |
| P1.lifecycle.042 | pass | pass | - | ok |
| P1.lifecycle.043 | pass | pass | - | ok |
| P1.lifecycle.050 | pass | pass | - | ok |
| P1.middleware.001 | pass | pass | - | ok |
| P1.middleware.002 | pass | pass | - | ok |
| P1.middleware.003 | pass | pass | - | ok |
| P1.middleware.010 | pass | pass | - | ok |
| P1.middleware.011 | pass | pass | - | ok |
| P1.middleware.012 | pass | pass | - | ok |
| P1.middleware.013 | pass | pass | - | ok |
| P1.middleware.014 | pass | pass | - | ok |
| P1.middleware.020 | pass | pass | - | ok |
| P1.middleware.021 | pass | pass | - | ok |
| P1.middleware.022 | pass (divergence mode) | pass | `middleware.codeAfterNextRuns` | flag-correct |
| P1.middleware.030 | pass | pass | - | ok |
| P1.resolution.001 | pass | pass | - | ok |
| P1.resolution.002 | pass | pass | - | ok |
| P1.resolution.003 | pass | pass | - | ok |
| P1.resolution.004 | pass | pass | - | ok |
| P1.resolution.010 | pass | pass | - | ok |
| P1.routing.001 | pass | pass | - | ok |
| P1.routing.002 | pass | pass | - | ok |
| P1.routing.003 | pass | pass | - | ok |
| P1.routing.004 | pass | pass | - | ok |
| P1.routing.005 | pass | pass | - | ok |
| P1.routing.006 | pass | pass | - | ok |
| P1.routing.007 | pass | pass | - | ok |
| P1.routing.010 | pass | pass | - | ok |
| P1.routing.011 | pass | pass | - | ok |
| P1.routing.012 | pass | pass | - | ok |
| P1.routing.020 | pass | pass | - | ok |
| P1.routing.021 | pass | pass | - | ok |
| P1.routing.022 | pass | pass | - | ok |
| P1.routing.023 | pass | pass | - | ok |
| P1.routing.024 | pass | pass | - | ok |
| P1.routing.025 | pass | pass | - | ok |
| P1.routing.030 | pass | pass | - | ok |
| P1.routing.040 | pass | pass (divergence mode) | `routing.trailingSlashAlias` | flag-correct |
| P1.routing.050 | pass | pass | - | ok |
| P1.routing.051 | pass | pass | - | ok |
| P1.routing.052 | pass | pass | - | ok |
| P1.routing.060 | pass | pass | - | ok |
| P1.routing.061 | pass | pass | - | ok |
| P1.routing.070 | pass (divergence mode) | pass | `middleware.codeAfterNextRuns` | flag-correct |
| P1.routing.071 | pass | pass (divergence mode) | `routing.unmatchedRoutePatternUnset` | flag-correct |
| P1.smoke.001 | pass | pass | - | ok |
| P1.smoke.002 | pass | pass | - | ok |
| P1.smoke.003 | pass | pass | - | ok |
| P1.smoke.004 | pass | pass | - | ok |
| P1.static.001 | pass | pass | - | ok |
| P1.static.002 | pass | pass | - | ok |
| P1.static.003 | pass | pass | - | ok |
| P1.static.004 | pass | pass | - | ok |
| P1.static.005 | pass | pass | - | ok |
| P1.static.006 | pass | pass (divergence mode) | `static.overrideNotFoundContinuesToHandler` | flag-correct |
| P1.static.007 | pass | pass | - | ok |
| P1.static.008 | pass | pass | - | ok |
| P1.static.010 | pass | pass | - | measure |
| P1.static.011 | pass | pass | - | measure |
| P1.static.020 | pass | pass | - | ok |
| P1.static.021 | pass | pass | - | ok |
| P1.static.022 | pass | pass | - | ok |
| P1.static.023 | pass | pass | - | ok |
| P1.static.024 | pass | pass | - | ok |
| P1.streaming.001 | pass | pass | - | ok |
| P1.streaming.002 | pass | pass | - | ok |
| P1.streaming.003 | pass | pass | - | ok |
| P1.streaming.004 | pass | pass | - | ok |
| P1.streaming.005 | pass | pass | - | ok |
| P1.streaming.006 | pass | pass (divergence mode) | `streaming.sseErrorCallbackOwnsOutput` | flag-correct |
| P1.streaming.007 | pass | pass (divergence mode) | `streaming.sseErrorCallbackOwnsOutput` | flag-correct |
| P1.streaming.008 | pass | pass (divergence mode) | `streaming.sseWriterStateIsLive` | flag-correct |
| P1.streaming.010 | pass | pass | - | ok |
| P1.streaming.011 | pass | pass | - | ok |
| P1.streaming.012 | pass | pass | - | ok |
| P1.streaming.020 | pass | pass | - | ok |
| P1.streaming.021 | pass | pass | - | ok |
| P1.streaming.022 | pass | pass | - | ok |
| P1.streaming.023 | pass | pass | - | ok |
| P1.streaming.030 | pass | pass | - | ok |
| P1.validation.001 | pass | pass | - | ok |
| P1.validation.002 | pass | pass | - | ok |
| P1.validation.003 | pass | pass | - | ok |
| P1.validation.004 | pass | pass | - | ok |
| P1.validation.005 | pass | pass | - | ok |
| P1.validation.006 | pass | pass | - | ok |
| P1.validation.007 | pass | pass | - | ok |
| P1.validation.008 | pass | pass | - | ok |
| P1.validation.009 | pass | pass | - | ok |
| P1.validation.010 | pass | pass | - | ok |
| P1.validation.020 | pass | pass | - | ok |
| P1.validation.021 | pass | pass | - | ok |
| P1.validation.022 | pass | pass | - | ok |
| P1.validation.023 | pass | pass | - | ok |
| P1.validation.024 | pass | pass | - | ok |
| P1.validation.025 | pass | pass | - | ok |
| P1.validation.026 | pass | pass | - | ok |
| P1.validation.027 | pass | pass | - | ok |
| P1.validation.028 | pass | pass | - | ok |
| P1.validation.029 | pass | pass | - | ok |
| P1.validation.030 | pass | pass | - | ok |
| P1.validation.031 | pass | pass | - | ok |
| P1.websocket.001 | pass | pass | - | ok |
| P1.websocket.002 | pass | pass | - | ok |
| P1.websocket.003 | pass | pass | - | ok |
| P1.websocket.004 | pass | pass | - | ok |
| P1.websocket.005 | pass | pass | - | ok |
| P1.websocket.006 | pass | pass | - | ok |
| P1.websocket.007 | pass | pass | - | ok |
| P1.websocket.010 | pass | pass | - | ok |
| P1.websocket.011 | pass | pass | - | ok |
| P1.websocket.020 | pass | pass | - | ok |
| P1.websocket.021 | pass | pass | - | ok |
| P1.websocket.022 | pass | pass | - | ok |
| P1.websocket.023 | pass | pass | - | ok |
| P1.websocket.024 | pass | pass | - | ok |
| P1.websocket.025 | pass | pass | - | ok |
| P1.websocket.030 | pass | pass | - | ok |
| P1.websocket.031 | pass | pass | - | ok |
| P1.websocket.032 | pass | pass | - | ok |
| P1.websocket.033 | pass | pass | - | ok |
| P1.websocket.040 | pass | pass (divergence mode) | `ws.startAwaitsTransportInit` | flag-correct |
| P1.websocket.041 | pass | pass (divergence mode) | `ws.startAwaitsTransportInit` | flag-correct |
| P1.websocket.042 | pass | pass | - | ok |
| P1.websocket.043 | pass | pass | - | ok |
| P1.websocket.050 | pass | pass | - | ok |
| P2.cli.001 | pass | pass | - | ok |
| P2.cli.002 | pass | pass | - | ok |
| P2.cli.003 | pass | pass | - | ok |
| P2.core.001 | pass | pass | - | ok |
| P2.core.002 | pass | pass | - | ok |
| P2.core.003 | pass | pass | - | ok |
| P2.core.010 | pass | pass | - | ok |
| P2.core.011 | pass | pass | - | ok |
| P2.core.020 | pass | pass | - | ok |
| P2.core.021 | pass | pass | - | ok |
| P2.core.030 | pass | pass | - | ok |
| P2.core.031 | pass | pass | - | ok |
| P2.core.032 | pass | pass | - | ok |
| P2.core.040 | pass | pass | - | ok |
| P2.core.041 | pass | pass | - | ok |
| P2.drizzle.001 | pass | pass | - | ok |
| P2.drizzle.002 | pass | pass | - | ok |
| P2.drizzle.003 | pass | pass | - | ok |
| P2.drizzle.004 | pass | pass | - | ok |
| P2.drizzle.005 | pass | pass | - | ok |
| P2.drizzle.006 | pass | pass | - | ok |
| P2.drizzle.007 | pass | pass | - | ok |
| P2.drizzle.008 | pass | pass | - | ok |
| P2.drizzle.020 | pass | pass | - | ok |
| P2.drizzle.021 | pass | pass | - | ok |
| P2.drizzle.022 | pass | pass | - | ok |
| P2.drizzle.023 | pass | pass | - | ok |
| P2.drizzle.024 | pass | pass | - | ok |
| P2.drizzle.025 | pass | pass | - | ok |
| P2.drizzle.026 | pass | pass | - | ok |
| P2.drizzle.027 | pass | pass | - | ok |
| P2.drizzle.030 | pass | pass | - | ok |
| P2.drizzle.031 | pass | pass | - | ok |
| P2.logger.001 | pass | pass | - | ok |
| P2.logger.002 | pass | pass | - | ok |
| P2.logger.003 | pass | pass | - | ok |
| P2.logger.004 | pass | pass | - | ok |
| P2.microservice.contract.kafka.C01 | pass | pass | - | ok |
| P2.microservice.contract.kafka.C02 | pass | pass | - | ok |
| P2.microservice.contract.kafka.C03 | pass | pass | - | ok |
| P2.microservice.contract.kafka.C04 | pass | pass | - | ok |
| P2.microservice.contract.kafka.C05 | pass | pass | - | ok |
| P2.microservice.contract.kafka.C06 | pass | pass | - | ok |
| P2.microservice.contract.kafka.C07 | pass | pass | - | ok |
| P2.microservice.contract.kafka.C08 | pass | pass | - | ok |
| P2.microservice.contract.kafka.C09 | pass | pass | - | ok |
| P2.microservice.contract.kafka.C10 | pass | pass | - | ok |
| P2.microservice.contract.kafka.C11 | pass | pass | - | ok |
| P2.microservice.contract.kafka.C12 | pass | pass | - | ok |
| P2.microservice.contract.memory.C01 | pass | pass | - | ok |
| P2.microservice.contract.memory.C02 | pass | pass | - | ok |
| P2.microservice.contract.memory.C03 | pass | pass | - | ok |
| P2.microservice.contract.memory.C04 | pass | pass | - | ok |
| P2.microservice.contract.memory.C05 | pass | pass | - | ok |
| P2.microservice.contract.memory.C06 | pass | pass | - | ok |
| P2.microservice.contract.memory.C07 | pass | pass | - | ok |
| P2.microservice.contract.memory.C08 | pass | pass | - | ok |
| P2.microservice.contract.memory.C09 | pass | pass | - | ok |
| P2.microservice.contract.memory.C10 | pass | pass | - | ok |
| P2.microservice.contract.memory.C11 | pass | pass | - | ok |
| P2.microservice.contract.memory.C12 | pass | pass | - | ok |
| P2.microservice.contract.memory.C13 | pass | pass | - | ok |
| P2.microservice.contract.redis.C01 | pass | pass | - | ok |
| P2.microservice.contract.redis.C02 | pass | pass | - | ok |
| P2.microservice.contract.redis.C03 | pass | pass | - | ok |
| P2.microservice.contract.redis.C04 | pass | pass | - | ok |
| P2.microservice.contract.redis.C05 | pass | pass | - | ok |
| P2.microservice.contract.redis.C06 | pass | pass | - | ok |
| P2.microservice.contract.redis.C07 | pass | pass | - | ok |
| P2.microservice.contract.redis.C08 | pass | pass | - | ok |
| P2.microservice.contract.redis.C09 | pass | pass | - | ok |
| P2.microservice.contract.redis.C10 | pass | pass | - | ok |
| P2.microservice.contract.redis.C11 | pass | pass | - | ok |
| P2.microservice.contract.redis.C12 | pass | pass | - | ok |
| P2.microservice.inheritance.kafka.I01 | pass | pass | - | ok |
| P2.microservice.inheritance.kafka.I02 | pass | pass | - | ok |
| P2.microservice.inheritance.kafka.I03 | pass | pass | - | ok |
| P2.microservice.inheritance.kafka.I04 | pass | pass | - | ok |
| P2.microservice.inheritance.kafka.I05 | pass | pass | - | ok |
| P2.microservice.inheritance.kafka.I06 | pass | pass | - | ok |
| P2.microservice.inheritance.kafka.I07 | pass | pass | - | ok |
| P2.microservice.inheritance.memory.I01 | pass | pass | - | ok |
| P2.microservice.inheritance.memory.I02 | pass | pass | - | ok |
| P2.microservice.inheritance.memory.I03 | pass | pass | - | ok |
| P2.microservice.inheritance.memory.I04 | pass | pass | - | ok |
| P2.microservice.inheritance.memory.I05 | pass | pass | - | ok |
| P2.microservice.inheritance.memory.I06 | pass | pass | - | ok |
| P2.microservice.inheritance.memory.I07 | pass | pass | - | ok |
| P2.microservice.inheritance.redis.I01 | pass | pass | - | ok |
| P2.microservice.inheritance.redis.I02 | pass | pass | - | ok |
| P2.microservice.inheritance.redis.I03 | pass | pass | - | ok |
| P2.microservice.inheritance.redis.I04 | pass | pass | - | ok |
| P2.microservice.inheritance.redis.I05 | pass | pass | - | ok |
| P2.microservice.inheritance.redis.I06 | pass | pass | - | ok |
| P2.microservice.inheritance.redis.I07 | pass | pass | - | ok |
| P2.microservice.mixed.MX1 | pass | pass | - | ok |
| P2.microservice.mixed.MX2 | pass | pass | - | ok |
| P2.microservice.mixed.MX3 | pass | pass | - | ok |
| P2.microservice.mixed.MX4 | pass | pass | - | ok |
| P2.microservice.mixed.MX5 | pass | pass | - | ok |
| P2.microservice.resilience.kafka.R1 | pass | pass | - | ok |
| P2.microservice.resilience.kafka.R1b | pass | pass | - | ok |
| P2.microservice.resilience.kafka.R2 | pass | pass | - | ok |
| P2.microservice.resilience.kafka.R3 | pass | pass | - | ok |
| P2.microservice.resilience.kafka.R4 | pass | pass | - | ok |
| P2.microservice.resilience.kafka.R5 | pass | pass | - | ok |
| P2.microservice.resilience.kafka.R6 | pass | pass | - | ok |
| P2.microservice.resilience.kafka.R7a | pass | pass | - | ok |
| P2.microservice.resilience.kafka.R7b | pass | pass | - | ok |
| P2.microservice.resilience.kafka.R8 | pass | pass | - | ok |
| P2.microservice.resilience.kafka.R9 | pass | pass | - | ok |
| P2.microservice.resilience.memory.R5 | pass | pass | - | ok |
| P2.microservice.resilience.redis.R1 | pass | pass | - | ok |
| P2.microservice.resilience.redis.R1b | pass | pass | - | ok |
| P2.microservice.resilience.redis.R2 | pass | pass | - | ok |
| P2.microservice.resilience.redis.R3 | pass | pass | - | ok |
| P2.microservice.resilience.redis.R4 | pass | pass | - | ok |
| P2.microservice.resilience.redis.R5 | pass | pass | - | ok |
| P2.microservice.resilience.redis.R6 | pass | pass | - | ok |
| P2.microservice.resilience.redis.R7a | pass | pass | - | ok |
| P2.microservice.resilience.redis.R7b | pass | pass | - | ok |
| P2.microservice.resilience.redis.R8 | pass | pass | - | ok |
| P2.microservice.resilience.redis.R9 | pass | pass | - | ok |
| P2.openapi.001 | pass | pass | - | ok |
| P2.openapi.002 | pass | pass | - | ok |
| P2.openapi.010 | pass | pass | - | ok |
| P2.openapi.011 | pass | pass | - | ok |
| P2.openapi.012 | pass | pass | - | ok |
| P2.openapi.013 | pass | pass | - | ok |
| P2.openapi.014 | pass | pass | - | ok |
| P2.openapi.015 | pass | pass | - | ok |
| P2.openapi.020 | pass | pass | - | ok |
| P2.openapi.030 | pass | pass | - | ok |
| P2.openapi.040 | pass | pass | - | ok |
| P2.otel-leak-sim.001 | pass | pass | - | ok |
| P2.otel-leak-sim.002 | pass | pass | - | ok |
| P2.otel-leak-sim.003 | pass | pass | - | ok |
| P2.otel.001 | pass | pass | - | ok |
| P2.otel.002 | pass | pass | - | ok |
| P2.otel.003 | pass (divergence mode) | pass | `middleware.codeAfterNextRuns` | flag-correct |
| P2.otel.004 | pass | pass | - | ok |
| P2.otel.005 | pass | pass | - | ok |
| P2.otel.006 | pass | pass | - | ok |
| P2.otel.010 | pass | pass | - | ok |
| P2.otel.011 | pass | pass | - | ok |
| P2.otel.012 | pass | pass | - | ok |
| P2.otel.020 | pass | pass | - | ok |
| P2.otel.030 | pass | pass | - | ok |
| P2.otel.031 | pass | pass | - | ok |
| P2.otel.032 | pass | pass | - | ok |
| P2.otel.033 | pass | pass | - | ok |
| P2.redis-ws.001 | pass | pass | - | ok |
| P2.redis-ws.002 | pass | pass | - | ok |
| P2.redis-ws.003 | pass | pass | - | ok |
| P2.redis-ws.004 | pass | pass | - | ok |
| P2.redis-ws.005 | pass | pass | - | ok |
| P2.redis-ws.006 | pass | pass | - | ok |
| P2.redis-ws.010 | pass | pass (divergence mode) | `ws.startAwaitsTransportInit` | flag-correct |
| P2.redis-ws.011 | pass | pass (divergence mode) | `ws.startAwaitsTransportInit` | flag-correct |
| P2.redis-ws.020 | pass | pass | - | ok |
| P2.redis.001 | pass | pass | - | ok |
| P2.redis.002 | pass | pass | - | ok |
| P2.redis.003 | pass | pass | - | ok |
| P2.redis.004 | pass | pass | - | ok |
| P2.redis.005 | pass | pass | - | ok |
| P2.redis.010 | pass | pass | - | ok |
| P2.redis.011 | pass | pass | - | ok |
| P2.redis.012 | pass | pass | - | ok |
| P2.redis.020 | pass | pass | - | ok |
| P2.resolution.001 | pass | pass | - | ok |
| P2.resolution.002 | pass | pass | - | ok |
| P2.services.001 | pass | pass | - | ok |
| P2.services.002 | pass | pass | - | ok |
| P2.services.003 | pass | pass | - | ok |
| P2.services.004 | pass | pass | - | ok |
| P2.services.005 | pass | pass | - | ok |
| P2.services.006 | pass | pass | - | ok |
| P2.services.007 | pass | pass | - | ok |
| P2.services.008 | pass | pass | - | ok |
