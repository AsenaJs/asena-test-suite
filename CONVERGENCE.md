# Convergence flags

One row per divergence flag (`packages/conformance/src/capabilities.ts`, kind `divergence`). A divergence flag is declared
only in a first-party `adapters/<name>.ts` `divergences` map and is honoured only on the maintainer path
(`tools/select-adapter.ts`). Citations are `origin/master` lines (hono-adapter `020d248` = 5.0.2, ergenecore `0a2cc6d` = 5.0.1).

| Flag | Off for | Justification | Convergence WP | State |
|---|---|---|---|---|
| `routing.trailingSlashAlias` | hono | Hono default `strict:true` 404s `/x/` on API routes (`HonoAdapter.ts:49,194`); Q2 requires the alias on every adapter | WP-51 | open |
| `ws.startAwaitsTransportInit` | hono | `HonoAdapter.ts:364` does not await `startWebsocket`; `start()` resolves before `transport.init` completes and an init failure escapes as an unhandled rejection | WP-50 | open |
