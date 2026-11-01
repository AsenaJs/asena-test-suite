export async function errorOf(promise: PromiseLike<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;

    throw new Error(`rejected with a non-Error value: ${String(error)}`, { cause: error });
  }

  throw new Error('expected a rejection, the promise resolved');
}
