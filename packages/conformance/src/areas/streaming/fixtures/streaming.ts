import type { AsenaContext, AsenaSSEStreamWriter, AsenaStreamWriter } from '@asenajs/asena/adapter';
import { Controller, Service } from '@asenajs/asena/decorators';
import { Get } from '@asenajs/asena/decorators/http';
import { Inject } from '@asenajs/asena/decorators/ioc';

type Component = new (...args: any[]) => unknown;

export const ACTIVITY = [
  { id: 1, action: 'user.login' },
  { id: 2, action: 'order.created' },
  { id: 3, action: 'payment.processed' },
  { id: 4, action: 'order.shipped' },
  { id: 5, action: 'user.logout' },
] as const;

export const PROGRESS_STEPS = ['Validating input', 'Loading data', 'Processing', 'Saving', 'Done'] as const;
export const PROGRESS_RETRY = 3000;
export const MULTILINE_DATA = 'Line 1: Starting\nLine 2: Processing\nLine 3: Complete';
export const SSE_ERROR_MESSAGE = 'Database connection lost';
export const TEXT_CHUNKS = ['The ', 'quick ', 'brown ', 'fox ', 'jumps ', 'over ', 'the ', 'lazy ', 'dog.'] as const;
export const LOG_LINES = ['alpha', 'beta', 'gamma'] as const;
export const CSV_DISPOSITION = 'attachment; filename="export.csv"';
export const CSV_ROWS = [
  'id,name,status',
  '1,User 1,inactive',
  '2,User 2,active',
  '3,User 3,inactive',
  '4,User 4,active',
] as const;
export const BINARY_CHUNKS = [
  [0x00, 0xff, 0x80, 0x7f],
  [0x0d, 0x0a, 0x00],
  [0xc3, 0x28, 0xfe, 0x01],
] as const;
export const STREAM_ERROR_MESSAGE = 'Stream interrupted';

export const CONCURRENT_STREAMS = 5;
export const CONCURRENT_WRITES = 5;

export interface EmptyFrameRecord {
  errors: unknown[];
  continuedAfterThrow: boolean;
}

export interface ProgressiveRecord {
  firstWritten: boolean;
  finished: boolean;
  release: () => void;
}

export interface StreamingFixture {
  components: Component[];
  emptyFrame: EmptyFrameRecord;
  progressive: ProgressiveRecord;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

export function streamingFixture(): StreamingFixture {
  const emptyFrame: EmptyFrameRecord = { errors: [], continuedAfterThrow: false };
  const latch = deferred();
  const progressive: ProgressiveRecord = { firstWritten: false, finished: false, release: latch.resolve };

  @Controller('/streaming')
  class StreamingController {
    @Get('/sse/activity')
    public activity(context: AsenaContext<any, any>) {
      return context.streamSSE(async (stream) => {
        for (const entry of ACTIVITY) {
          await stream.writeSSE({ data: JSON.stringify(entry), event: entry.action, id: String(entry.id) });
        }
      });
    }

    @Get('/sse/progress')
    public progress(context: AsenaContext<any, any>) {
      return context.streamSSE(async (stream) => {
        const total = PROGRESS_STEPS.length;

        for (let i = 0; i < total; i++) {
          await stream.writeSSE({
            data: JSON.stringify({ step: i + 1, total, message: PROGRESS_STEPS[i] }),
            event: i < total - 1 ? 'progress' : 'complete',
            id: String(i + 1),
            retry: PROGRESS_RETRY,
          });
        }
      });
    }

    @Get('/sse/multiline')
    public multiline(context: AsenaContext<any, any>) {
      return context.streamSSE(async (stream) => {
        await stream.writeSSE({ data: MULTILINE_DATA, event: 'log' });
      });
    }

    @Get('/sse/comment')
    public comment(context: AsenaContext<any, any>) {
      return context.streamSSE(async (stream) => {
        await stream.writeSSE({ comment: 'keep-alive' });
        await stream.writeSSE({ comment: 'line-a\nline-b' });
        await stream.writeSSE({ data: 'after', event: 'tick' });
      });
    }

    @Get('/sse/empty-frame')
    public emptyFrameRoute(context: AsenaContext<any, any>) {
      return context.streamSSE(
        async (stream) => {
          await stream.writeSSE({ data: 'before' });
          await stream.writeSSE({ event: 'empty' });
          emptyFrame.continuedAfterThrow = true;
          await stream.writeSSE({ data: 'unreachable' });
        },
        async (error, stream) => {
          emptyFrame.errors.push(error);
          await stream.writeSSE({ data: error.message, event: 'error' });
        },
      );
    }

    @Get('/sse/error')
    public sseError(context: AsenaContext<any, any>) {
      return context.streamSSE(
        async () => {
          throw new Error(SSE_ERROR_MESSAGE);
        },
        async (error, stream) => {
          await stream.writeSSE({ data: JSON.stringify({ error: error.message }), event: 'error' });
        },
      );
    }

    @Get('/text/generate')
    public textGenerate(context: AsenaContext<any, any>) {
      return context.streamText(async (stream) => {
        for (const chunk of TEXT_CHUNKS) {
          await stream.write(chunk);
        }
      });
    }

    @Get('/text/lines')
    public textLines(context: AsenaContext<any, any>) {
      return context.streamText(async (stream) => {
        for (const line of LOG_LINES) {
          await stream.writeln(line);
        }
      });
    }

    @Get('/text/progressive')
    public textProgressive(context: AsenaContext<any, any>) {
      return context.streamText(async (stream) => {
        await stream.write('first|');
        progressive.firstWritten = true;
        await latch.promise;
        await stream.write('second');
        progressive.finished = true;
      });
    }

    @Get('/download/csv')
    public csv(context: AsenaContext<any, any>) {
      context.setResponseHeader!('Content-Disposition', CSV_DISPOSITION);

      return context.stream(async (stream) => {
        for (const row of CSV_ROWS) {
          await stream.writeln(row);
        }
      });
    }

    @Get('/download/binary')
    public binary(context: AsenaContext<any, any>) {
      return context.stream(async (stream) => {
        for (const chunk of BINARY_CHUNKS) {
          await stream.write(new Uint8Array(chunk));
        }
      });
    }

    @Get('/download/pipe')
    public pipe(context: AsenaContext<any, any>) {
      return context.stream(async (stream) => {
        const encoder = new TextEncoder();
        const source = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('piped-'));
            controller.enqueue(encoder.encode('content'));
            controller.close();
          },
        });

        await stream.write('head|');
        await stream.pipe(source);
        await stream.write('|tail');
      });
    }

    @Get('/download/error')
    public streamError(context: AsenaContext<any, any>) {
      return context.stream(
        async (stream) => {
          await stream.write('partial-');
          throw new Error(STREAM_ERROR_MESSAGE);
        },
        async (error, stream) => {
          await stream.write(`ERROR:${error.message}`);
        },
      );
    }
  }

  return { components: [StreamingController], emptyFrame, progressive };
}

export interface AbortProbeState {
  connected: number;
  aborted: number;
  abortedAt: number | undefined;
  writerAborted: boolean;
  finished: boolean;
}

export const ABORT_PROBE = 'StreamingAbortProbe';

export function abortFixture(): Component[] {
  @Service(ABORT_PROBE)
  class StreamingAbortProbe implements AbortProbeState {
    public connected = 0;
    public aborted = 0;
    public abortedAt: number | undefined = undefined;
    public writerAborted = false;
    public finished = false;
  }

  @Controller('/streaming-abort')
  class StreamingAbortController {
    @Inject(StreamingAbortProbe)
    private probe!: StreamingAbortProbe;

    @Get('/sse/long-lived')
    public longLived(context: AsenaContext<any, any>) {
      const probe = this.probe;

      return context.streamSSE(async (stream: AsenaSSEStreamWriter) => {
        const gone = deferred();

        stream.onAbort(() => {
          probe.aborted++;
          probe.abortedAt = performance.now();
          gone.resolve();
        });

        await stream.writeSSE({ data: 'connected', event: 'status' });
        probe.connected++;

        const fallback = setTimeout(gone.resolve, 10_000);

        await gone.promise;
        clearTimeout(fallback);
        probe.writerAborted = stream.aborted;
        probe.finished = true;
      });
    }
  }

  return [StreamingAbortController, StreamingAbortProbe];
}

class SharedTick {
  #waiting: (() => void)[] = [];
  #scheduled = false;

  wait(): Promise<void> {
    return new Promise((resolve) => {
      this.#waiting.push(resolve);

      if (!this.#scheduled) {
        this.#scheduled = true;
        setTimeout(() => {
          const waiting = this.#waiting;

          this.#waiting = [];
          this.#scheduled = false;

          for (const resolveOne of waiting) resolveOne();
        }, 1);
      }
    });
  }
}

class StartBarrier {
  #arrived = 0;
  readonly #all = deferred();

  constructor(private readonly expected: number) {}

  arrive(): Promise<void> {
    this.#arrived++;

    if (this.#arrived >= this.expected) this.#all.resolve();

    return this.#all.promise;
  }
}

export function concurrencyFixture(): Component[] {
  const tick = new SharedTick();
  const barrier = new StartBarrier(CONCURRENT_STREAMS * 2);

  @Controller('/streaming-concurrency')
  class StreamingConcurrencyController {
    @Get('/sse/:token')
    public sse(context: AsenaContext<any, any>) {
      const token = context.getParam('token');

      return context.streamSSE(async (stream: AsenaSSEStreamWriter) => {
        await barrier.arrive();

        for (let i = 0; i < CONCURRENT_WRITES; i++) {
          await stream.writeSSE({ data: `${token}:${i}`, event: 'tick', id: `${token}-${i}` });
          await tick.wait();
        }
      });
    }

    @Get('/text/:token')
    public text(context: AsenaContext<any, any>) {
      const token = context.getParam('token');

      return context.streamText(async (stream: AsenaStreamWriter) => {
        await barrier.arrive();

        for (let i = 0; i < CONCURRENT_WRITES; i++) {
          await stream.write(`${token}-${i};`);
          await tick.wait();
        }
      });
    }
  }

  return [StreamingConcurrencyController];
}
