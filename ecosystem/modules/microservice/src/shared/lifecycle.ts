import type { AsenaServer } from '@asenajs/asena';

// The mains boot with `shutdown: { signals: false }` and own the signals here. stop(false) drains in-flight HTTP first,
// then destroys the transports (the order R5 asserts). A second signal while stopping forces exit(1).
export function installSignalHandlers(server: AsenaServer<any>): void {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) process.exit(1);

    shuttingDown = true;
    console.log(`[lifecycle] ${signal} received - stopping gracefully`);

    try {
      await server.stop(false);
      console.log('[lifecycle] stopped cleanly');
      process.exit(0);
    } catch (error) {
      console.error('[lifecycle] stop failed:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  installParentWatch();
}

// The harness holds this process's stdin pipe; EOF means the runner died (even by SIGKILL), so the child exits instead
// of living on as an orphan.
function installParentWatch(): void {
  if (Bun.env.E2E_PARENT_WATCH !== '1') return;

  void (async () => {
    try {
      const reader = Bun.stdin.stream().getReader();

      while (!(await reader.read()).done);
    } catch {
      // a read error means the pipe is gone too
    }

    console.error('[lifecycle] parent pipe closed - exiting');
    process.exit(1);
  })();
}
