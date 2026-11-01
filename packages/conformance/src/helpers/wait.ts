export interface WaitForOptions {
  timeout?: number;
  interval?: number;
  label?: string;
}

export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  { timeout = 2000, interval = 10, label = 'condition' }: WaitForOptions = {},
): Promise<NonNullable<T>> {
  const deadline = performance.now() + timeout;
  let lastError: unknown;

  for (;;) {
    try {
      const value = await predicate();

      if (value) return value;

      lastError = undefined;
    } catch (error) {
      lastError = error;
    }

    if (performance.now() >= deadline) {
      throw new Error(`waitFor: ${label} not met within ${timeout}ms`, { cause: lastError });
    }

    await Bun.sleep(interval);
  }
}

export function withTimeout<T>(promise: PromiseLike<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });

  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}
