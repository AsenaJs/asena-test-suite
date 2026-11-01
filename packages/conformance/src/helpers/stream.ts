export interface ReadChunksOptions {
  timeout?: number;
}

export interface StreamChunk {
  bytes: Uint8Array;
  text: string;
  at: number;
}

export interface ReadChunksResult {
  chunks: StreamChunk[];
  text: string;
}

export async function readChunks(
  response: Response,
  { timeout = 5000 }: ReadChunksOptions = {},
): Promise<ReadChunksResult> {
  const chunks: StreamChunk[] = [];
  const reader = response.body?.getReader();

  if (!reader) return { chunks, text: '' };

  const decoder = new TextDecoder();
  const started = performance.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, timeout);

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (timedOut) {
        throw new Error(`readChunks: stream still open after ${timeout}ms (${chunks.length} chunk(s) read)`, {
          cause: chunks,
        });
      }

      if (done) break;

      chunks.push({ bytes: value, text: decoder.decode(value, { stream: true }), at: performance.now() - started });
    }

    const tail = decoder.decode();

    const last = chunks.at(-1);

    if (tail && last) last.text += tail;

    return { chunks, text: chunks.map((chunk) => chunk.text).join('') };
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
