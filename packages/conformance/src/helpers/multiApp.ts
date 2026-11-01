import type { TestApp } from '@asenajs/asena/test';

export interface StoppableApp {
  stop(): Promise<void>;
}

export interface BootedApps<A extends StoppableApp = TestApp> {
  readonly apps: A[];
  stopAll(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

async function stopEach(apps: StoppableApp[]): Promise<void> {
  const results = await Promise.allSettled(apps.map((app) => app.stop()));
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason as unknown] : []));

  if (errors.length > 0) throw new AggregateError(errors, `bootApps: ${errors.length} app(s) failed to stop`);
}

export async function bootApps<A extends StoppableApp = TestApp>(
  n: number,
  makeApp: (index: number) => Promise<A>,
): Promise<BootedApps<A>> {
  const results = await Promise.allSettled(Array.from({ length: n }, (_, index) => makeApp(index)));
  const apps = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');

  if (failure) {
    await stopEach(apps).catch(() => undefined);

    throw failure.reason;
  }

  let stopping: Promise<void> | undefined;
  const stopAll = (): Promise<void> => (stopping ??= stopEach(apps));

  return { apps, stopAll, [Symbol.asyncDispose]: stopAll };
}
