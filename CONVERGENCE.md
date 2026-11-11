# Convergence flags

One row per divergence flag (`packages/conformance/src/capabilities.ts`, kind `divergence`). A divergence flag is declared
only in a first-party `adapters/<name>.ts` `divergences` map and is honoured only on the maintainer path
(`tools/select-adapter.ts`). Justifications cite `origin/master` lines of the adapter repo, with its version and SHA.

| Flag | Off for | Justification | Convergence WP | State |
|---|---|---|---|---|
| `routing.unslashedPathIsServed` | ergenecore | Core joins a controller prefix written without its leading slash into a relative route path (`@Controller('plain')` + `@Get('y')` -> `plain/y`, core 0.12.4 `2a7dbd1` `AsenaServer.ts:672`). Ergenecore (5.0.3, `afb15ac`) keys Bun's route table by that path as is (`Ergenecore.ts:557-564`) and `Bun.serve` refuses it (`:425`, `Invalid route "plain/y". Path must start with '/'`), so the app never boots; it already adds the slash to a WebSocket path (`:693`). The other adapter serves the route at `/plain/y` (Hono's `mergePath`). Found by `P2.auth.034` | WP-66 (ergenecore HTTP route path normalization) | open |
