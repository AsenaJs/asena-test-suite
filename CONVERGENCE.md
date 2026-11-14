# Convergence flags

One row per divergence flag (`packages/conformance/src/capabilities.ts`, kind `divergence`). A divergence flag is declared
only in a first-party `adapters/<name>.ts` `divergences` map and is honoured only on the maintainer path
(`tools/select-adapter.ts`). Justifications cite `origin/master` lines of the adapter repo, with its version and SHA.

| Flag | Off for | Justification | Convergence WP | State |
|---|---|---|---|---|
| `routing.unslashedPathIsServed` | ergenecore | Core joins a controller prefix written without its leading slash into a relative route path (`@Controller('plain')` + `@Get('y')` -> `plain/y`, core 0.12.4 `2a7dbd1` `AsenaServer.ts:672`). Ergenecore (5.0.3, `afb15ac`) keys Bun's route table by that path as is (`Ergenecore.ts:557-564`) and `Bun.serve` refuses it (`:425`, `Invalid route "plain/y". Path must start with '/'`), so the app never boots; it already adds the slash to a WebSocket path (`:693`). The other adapter serves the route at `/plain/y` (Hono's `mergePath`). Found by `P2.auth.034` | WP-66 (ergenecore HTTP route path normalization) | open |
| `routing.undeclaredParamIsEmpty` | hono | Core declares `getParam: (s: string) => string` (core 0.13.0 `b52bfd6` `AsenaContext.ts:91`). Hono-adapter (5.2.0, `e284d50`) returns Hono's `req.param(s)` as is (`HonoContextWrapper.ts:278-280`), which is `undefined` for a name the matched route does not declare, so a handler that echoes it drops the key from its JSON body. Ergenecore (5.1.0, `564e5ce`) returns `''` for such a name (`ErgenecoreContextWrapper.ts:376-384`). Decided 2026-11-14: `''` on every adapter. Pinned by `P1.routing.013` | WP-67 (hono-adapter `getParam` for an undeclared name, carried out as WP-HONO-CONTRACT) | open |
