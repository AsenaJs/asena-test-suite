# Applied findings 2026-11-01 (WP-07b)

One line per `FINDINGS.md` entry. Suite paths are relative to `asena-test-suite/`; plan paths to
`/home/libir/Desktop/asena/plans/test-suite/` (outside this repo, not committed here).

## Per entry

| ID | Proposal | Applied |
|---|---|---|
| P1.routing.070 | new-flag | flag `middleware.codeAfterNextRuns` already in the suite (stage 2: `capabilities.ts`, `descriptor.ts`, `adapters/ergenecore.ts`, `CONVERGENCE.md:11`); task file `tasks/WP-55.md` written (base: head of WP-52, else `origin/master`; dependsOn WP-07b, WP-52); STATUS row; PLAN section 7 row (:481) and section 8 row (:512) |
| P1.middleware.022 | new-flag | same flag and WP-55 as P1.routing.070 |
| P1.context.045 | new-flag | same flag and WP-55 |
| P1.errors.014 | new-flag | same flag and WP-55 |
| P2.otel.003 | new-flag | same flag and WP-55 (its acceptance re-runs P2.otel.003) |
| P1.routing.040 | none | `routing.trailingSlashAlias` / WP-51 unchanged |
| P1.websocket.040 | none | `ws.startAwaitsTransportInit` / WP-50 unchanged |
| P1.websocket.041 | none | as P1.websocket.040 |
| P2.redis-ws.010 | none | as P1.websocket.040 |
| P2.redis-ws.011 | none | as P1.websocket.040 |
| P1.routing.071 | new-flag | flag `routing.unmatchedRoutePatternUnset` already in the suite (stage 2, `CONVERGENCE.md:12`); `tasks/WP-56.md` (base `origin/master`; first of the `HonoContextWrapper.ts` chain); STATUS row; PLAN :482, :513 |
| P1.context.013 | new-flag | flag `context.absentValuesMatchDeclaredTypes` (stage 2, `CONVERGENCE.md:13`); `tasks/WP-57.md` (after WP-56); STATUS row; PLAN :483, :514 |
| P1.context.030 | new-flag | same flag and WP-57 |
| P1.context.006 | new-flag | flag `context.invalidJsonIsBadRequest` (stage 2, `CONVERGENCE.md:14`); `tasks/WP-58.md` (after WP-57, maintainer decision noted); STATUS row; PLAN :484, :515 |
| P1.streaming.006 | new-flag | flag `streaming.sseErrorCallbackOwnsOutput` (stage 3, `CONVERGENCE.md:15`); `tasks/WP-59.md` (after WP-58, maintainer decision); STATUS row; PLAN :485, :516 |
| P1.streaming.007 | new-flag | same flag and WP-59 |
| P1.streaming.008 | new-flag | flag `streaming.sseWriterStateIsLive` (stage 3, `CONVERGENCE.md:16`); `tasks/WP-60.md` (after WP-59); STATUS row; PLAN :486, :517 |
| P1.static.006 | new-flag | flag `static.overrideNotFoundContinuesToHandler` (stage 3, `CONVERGENCE.md:17`); `tasks/WP-61.md` (after WP-51, `HonoAdapter.ts` chain WP-50 -> WP-51 -> WP-61; maintainer decision); STATUS row; PLAN :487, :518 |
| P1.static.010 | pin | `packages/conformance/src/areas/static/scenarios.ts:19-35` targets split into `NOT_FOUND_TRAVERSAL` (6) and `ESCAPING_TRAVERSAL` (3); P1.static.010 (:157) asserts no leak for all nine targets and pins `404` for the six agreed ones; ungated. The disagreeing encoded-slash statuses moved to P1.static.011 |
| P1.static.011 | pin -> new-flag (adapters disagree) | P1.static.011 (:176-193) pins `400` for `MALFORMED` and `403` for `ESCAPING_TRAVERSAL` (title: "a static path is decoded once: a malformed escape answers 400, a path escaping the root 403"), `requires: ['static.encodedPathIsDecodedAndChecked']` (:192). New flag: `descriptor.ts:42` (`DivergenceFlag`), `capabilities.ts:24` (`convergence: 'WP-62'`), `adapters/hono.ts:49` (`divergences`), `CONVERGENCE.md:18`; `tasks/WP-62.md` (after WP-61, `HonoAdapter.ts`; maintainer decision); STATUS row; PLAN section 7 row (:480, replaces the "unmeasured" row) and section 8 row (:519) |

## Other plan edits

- PLAN section 8 `optional.zodValidator` row (:535): gated scenarios now list P1.middleware.010 and P1.harness.011 (noted in stages
  2-4).
- PLAN section 7 gained rows for all seven stage-2/3 flags plus the new one (:480-487); section 8 divergence table rows :512-519.
- STATUS.md: rows WP-55..WP-62 (wave 7) appended to the WP table; the ledger is untouched.
- Chain decisions (WP-07b template, file based): `Ergenecore.ts` WP-52 -> WP-55; `HonoContextWrapper.ts` WP-56 -> WP-57 -> WP-58
  -> WP-59 -> WP-60 (no earlier convergence WP owns it, so WP-56 needs only WP-07b; the stage-2 note "chain after WP-51" is
  superseded); `HonoAdapter.ts` WP-50 -> WP-51 -> WP-61 -> WP-62.

## Deferred to WP-09

Nothing: no flag is stale (`REPORT.md`, forced runs).

## Red / green proof (P1.static.011, `static.encodedPathIsDecodedAndChecked`)

- Pinned values without the flag: ergenecore `static.test.ts` 15 pass / 0 fail; hono 14 pass / 1 fail (P1.static.011: six statuses
  `404` where `400` x3 and `403` x3 were expected).
- With the flag: both 15 pass / 0 fail (hono runs P1.static.011 in divergence mode).
- Forced (`ASENA_SUITE_FORCE_CAPS=static.encodedPathIsDecodedAndChecked`, `-t 'P1\.static\.011\]'`): hono 0 pass / 1 fail (the same
  `expect(received).toEqual(expected)` diff), ergenecore 1 pass / 0 fail.
