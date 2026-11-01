import { expect } from 'bun:test';
import { bootApp } from '../../boot.ts';
import { collectSse, readSse } from '../../helpers/sse.ts';
import { readChunks } from '../../helpers/stream.ts';
import { waitFor, withTimeout } from '../../helpers/wait.ts';
import { area, scenario } from '../../scenario.ts';
import {
  ABORT_PROBE,
  type AbortProbeState,
  abortFixture,
  ACTIVITY,
  BINARY_CHUNKS,
  CONCURRENT_STREAMS,
  CONCURRENT_WRITES,
  concurrencyFixture,
  CSV_DISPOSITION,
  CSV_ROWS,
  LOG_LINES,
  MULTILINE_DATA,
  PROGRESS_RETRY,
  PROGRESS_STEPS,
  SSE_ERROR_MESSAGE,
  STREAM_ERROR_MESSAGE,
  streamingFixture,
  TEXT_CHUNKS,
} from './fixtures/streaming.ts';

type App = Awaited<ReturnType<typeof bootApp>>;

function open(app: App, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${app.baseUrl}${path}`, init);
}

export function register(): void {
  area('streaming', () => {
    scenario('P1.streaming.001', 'streamSSE sets text/event-stream and no-cache', async () => {
      await using app = await bootApp({ components: streamingFixture().components });
      const response = await open(app, '/streaming/sse/activity');

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(response.headers.get('cache-control')).toBe('no-cache');

      await collectSse(response);
    });

    scenario('P1.streaming.002', 'five JSON events keep their event, id and order', async () => {
      await using app = await bootApp({ components: streamingFixture().components });
      const response = await open(app, '/streaming/sse/activity');

      expect(response.status).toBe(200);

      const events = [];

      for await (const event of readSse(response)) events.push(event);

      expect(events).toEqual(
        ACTIVITY.map((entry) => ({ event: entry.action, id: String(entry.id), data: JSON.stringify(entry) })),
      );
    });

    scenario('P1.streaming.003', 'the retry field is written and the last event completes', async () => {
      await using app = await bootApp({ components: streamingFixture().components });
      const response = await open(app, '/streaming/sse/progress');

      expect(response.status).toBe(200);

      const events = await collectSse(response);
      const total = PROGRESS_STEPS.length;

      expect(events).toEqual(
        PROGRESS_STEPS.map((message, i) => ({
          event: i < total - 1 ? 'progress' : 'complete',
          id: String(i + 1),
          retry: PROGRESS_RETRY,
          data: JSON.stringify({ step: i + 1, total, message }),
        })),
      );
    });

    scenario('P1.streaming.004', 'multi-line data is split into data: lines that rejoin with \\n', async () => {
      await using app = await bootApp({ components: streamingFixture().components });
      const response = await open(app, '/streaming/sse/multiline');

      expect(response.status).toBe(200);
      expect(await collectSse(response)).toEqual([{ event: 'log', data: MULTILINE_DATA }]);
    });

    scenario('P1.streaming.005', 'a comment-only frame is written as comment lines', async () => {
      await using app = await bootApp({ components: streamingFixture().components });
      const response = await open(app, '/streaming/sse/comment');

      expect(response.status).toBe(200);
      expect(await collectSse(response)).toEqual([
        { data: '', comment: 'keep-alive' },
        { data: '', comment: 'line-a\nline-b' },
        { event: 'tick', data: 'after' },
      ]);
    });

    scenario(
      'P1.streaming.006',
      'a frame with neither data nor comment rejects into the error callback and writes nothing',
      async () => {
        const fixture = streamingFixture();
        await using app = await bootApp({ components: fixture.components });
        const response = await open(app, '/streaming/sse/empty-frame');

        expect(response.status).toBe(200);

        const events = await collectSse(response);

        expect(fixture.emptyFrame.errors.length).toBe(1);

        const [error] = fixture.emptyFrame.errors;

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message.length > 0).toBe(true);
        expect(fixture.emptyFrame.continuedAfterThrow).toBe(false);
        expect(events).toEqual([{ data: 'before' }, { event: 'error', data: (error as Error).message }]);
      },
    );

    scenario(
      'P1.streaming.007',
      'the streamSSE error callback writes an error event with the exact payload',
      async () => {
        await using app = await bootApp({ components: streamingFixture().components });
        const response = await open(app, '/streaming/sse/error');

        expect(response.status).toBe(200);
        expect(await collectSse(response)).toEqual([
          { event: 'error', data: JSON.stringify({ error: SSE_ERROR_MESSAGE }) },
        ]);
      },
    );

    scenario('P1.streaming.008', 'a client abort on a long-lived SSE fires onAbort on the server', async () => {
      await using app = await bootApp({ components: abortFixture() });
      const probe = await app.resolve<AbortProbeState>(ABORT_PROBE);
      const controller = new AbortController();
      const response = await open(app, '/streaming-abort/sse/long-lived', { signal: controller.signal });

      expect(response.status).toBe(200);

      const events = readSse(response);
      const first = await withTimeout(events.next(), 2000, 'first SSE event');

      expect(first.value).toEqual({ event: 'status', data: 'connected' });
      expect(probe.connected).toBe(1);
      expect(probe.aborted).toBe(0);

      const abortedAt = performance.now();

      controller.abort();
      await events.return(undefined).catch(() => undefined);

      await waitFor(() => probe.aborted > 0, { timeout: 2000, label: 'server-side onAbort' });

      expect(probe.aborted).toBe(1);
      expect(probe.abortedAt! - abortedAt < 2000).toBe(true);

      await waitFor(() => probe.finished, { timeout: 2000, label: 'long-lived handler returns after abort' });

      expect(probe.writerAborted).toBe(true);
    });

    scenario('P1.streaming.010', 'streamText sets text/plain, nosniff and delivers the exact text', async () => {
      await using app = await bootApp({ components: streamingFixture().components });
      const response = await open(app, '/streaming/text/generate');

      expect(response.status).toBe(200);

      const contentType = response.headers.get('content-type');

      expect(contentType).not.toBeNull();
      expect(contentType!).toContain('text/plain');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');

      const { text } = await readChunks(response);

      expect(text).toBe(TEXT_CHUNKS.join(''));
    });

    scenario('P1.streaming.011', 'writeln terminates every line with \\n', async () => {
      await using app = await bootApp({ components: streamingFixture().components });
      const response = await open(app, '/streaming/text/lines');

      expect(response.status).toBe(200);

      const { text } = await readChunks(response);

      expect(text).toBe(LOG_LINES.map((line) => `${line}\n`).join(''));
    });

    scenario('P1.streaming.012', 'the first chunk arrives before the handler finishes', async () => {
      const fixture = streamingFixture();
      await using app = await bootApp({ components: fixture.components });

      try {
        const response = await open(app, '/streaming/text/progressive');

        expect(response.status).toBe(200);

        const reader = response.body!.getReader();
        const first = await withTimeout(reader.read(), 2000, 'first text chunk');

        expect(first.done).toBe(false);
        expect(new TextDecoder().decode(first.value)).toBe('first|');
        expect(fixture.progressive.firstWritten).toBe(true);
        expect(fixture.progressive.finished).toBe(false);

        reader.releaseLock();
        fixture.progressive.release();

        const { text } = await readChunks(response);

        expect(text).toBe('second');
        expect(fixture.progressive.finished).toBe(true);
      } finally {
        fixture.progressive.release();
      }
    });

    scenario(
      'P1.streaming.020',
      'stream keeps a content-disposition set through setResponseHeader and writes the exact CSV',
      async () => {
        await using app = await bootApp({ components: streamingFixture().components });
        const response = await open(app, '/streaming/download/csv');

        expect(response.status).toBe(200);
        expect(response.headers.get('content-disposition')).toBe(CSV_DISPOSITION);

        const { text } = await readChunks(response);

        expect(text).toBe(CSV_ROWS.map((row) => `${row}\n`).join(''));
      },
      { requires: ['optional.responseHeaders'] },
    );

    scenario('P1.streaming.021', 'binary Uint8Array chunks arrive byte-exact', async () => {
      await using app = await bootApp({ components: streamingFixture().components });
      const response = await open(app, '/streaming/download/binary');

      expect(response.status).toBe(200);

      const { chunks } = await readChunks(response);
      const received = chunks.flatMap((chunk) => Array.from(chunk.bytes));

      expect(received).toEqual(BINARY_CHUNKS.flatMap((chunk) => [...chunk]));
    });

    scenario('P1.streaming.022', 'pipe forwards a ReadableStream and the writer stays usable', async () => {
      await using app = await bootApp({ components: streamingFixture().components });
      const response = await open(app, '/streaming/download/pipe');

      expect(response.status).toBe(200);

      const { text } = await readChunks(response);

      expect(text).toBe('head|piped-content|tail');
    });

    scenario('P1.streaming.023', 'a mid-stream error keeps the partial body and appends the error marker', async () => {
      await using app = await bootApp({ components: streamingFixture().components });
      const response = await open(app, '/streaming/download/error');

      expect(response.status).toBe(200);

      const { text } = await readChunks(response);

      expect(text).toBe(`partial-ERROR:${STREAM_ERROR_MESSAGE}`);
    });

    scenario('P1.streaming.024', 'the streamText error callback owns the output and text/plain is kept', async () => {
      await using app = await bootApp({ components: streamingFixture().components });
      const response = await open(app, '/streaming/text/error');

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/plain');

      const { text } = await readChunks(response);

      expect(text).toBe(`partial-ERROR:${STREAM_ERROR_MESSAGE}`);
    });

    scenario(
      'P1.streaming.025',
      'a silent stream or streamText error callback adds nothing to the output',
      async () => {
        await using app = await bootApp({ components: streamingFixture().components });

        for (const path of ['/streaming/download/silent-error', '/streaming/text/silent-error']) {
          const response = await open(app, path);
          const { text } = await readChunks(response);

          expect([path, response.status, text]).toEqual([path, 200, 'only']);
        }
      },
    );

    scenario('P1.streaming.030', 'concurrent SSE and text streams stay complete and never interleave', async () => {
      await using app = await bootApp({ components: concurrencyFixture() });
      const sseTokens = Array.from({ length: CONCURRENT_STREAMS }, (_, i) => `sse${i}x`);
      const textTokens = Array.from({ length: CONCURRENT_STREAMS }, (_, i) => `txt${i}x`);

      const [sseResults, textResults] = await Promise.all([
        Promise.all(
          sseTokens.map(async (token) => {
            const response = await open(app, `/streaming-concurrency/sse/${token}`);

            return { token, status: response.status, events: await collectSse(response) };
          }),
        ),
        Promise.all(
          textTokens.map(async (token) => {
            const response = await open(app, `/streaming-concurrency/text/${token}`);

            return { token, status: response.status, text: (await readChunks(response)).text };
          }),
        ),
      ]);

      const writes = Array.from({ length: CONCURRENT_WRITES }, (_, i) => i);

      for (const result of sseResults) {
        expect(result.status).toBe(200);
        expect(result.events).toEqual(
          writes.map((i) => ({ event: 'tick', id: `${result.token}-${i}`, data: `${result.token}:${i}` })),
        );
      }

      for (const result of textResults) {
        expect(result.status).toBe(200);
        expect(result.text).toBe(writes.map((i) => `${result.token}-${i};`).join(''));
      }
    });
  });
}
