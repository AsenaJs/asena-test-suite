export interface SseEvent {
  event?: string;
  id?: string;
  data: string;
  retry?: number;
  comment?: string;
}

export interface CollectSseOptions {
  max?: number;
  timeout?: number;
}

interface Block {
  event?: string;
  id?: string;
  data: string[];
  retry?: number;
  comments: string[];
  touched: boolean;
}

const emptyBlock = (): Block => ({ data: [], comments: [], touched: false });

class SseParser {
  #buffer = '';
  #block = emptyBlock();
  #started = false;

  push(text: string, final = false): SseEvent[] {
    this.#buffer += text;

    if (!this.#started && this.#buffer.length > 0) {
      if (this.#buffer.startsWith('﻿')) this.#buffer = this.#buffer.slice(1);
      this.#started = true;
    }

    const events: SseEvent[] = [];

    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.#buffer);

      if (!match) break;
      if (!final && match[0] === '\r' && match.index === this.#buffer.length - 1) break;

      const line = this.#buffer.slice(0, match.index);

      this.#buffer = this.#buffer.slice(match.index + match[0].length);

      if (line === '') {
        if (this.#block.touched) events.push(toEvent(this.#block));
        this.#block = emptyBlock();
      } else {
        applyLine(this.#block, line);
      }
    }

    return events;
  }
}

function applyLine(block: Block, line: string): void {
  if (line.startsWith(':')) {
    block.comments.push(line.slice(1).replace(/^ /, ''));
    block.touched = true;

    return;
  }

  const colon = line.indexOf(':');
  const field = colon === -1 ? line : line.slice(0, colon);
  const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');

  switch (field) {
    case 'data':
      block.data.push(value);
      break;
    case 'event':
      block.event = value;
      break;
    case 'id':
      if (value.includes('\0')) return;
      block.id = value;
      break;
    case 'retry':
      if (!/^\d+$/.test(value)) return;
      block.retry = Number(value);
      break;
    default:
      return;
  }

  block.touched = true;
}

function toEvent(block: Block): SseEvent {
  const event: SseEvent = { data: block.data.join('\n') };

  if (block.event !== undefined) event.event = block.event;
  if (block.id !== undefined) event.id = block.id;
  if (block.retry !== undefined) event.retry = block.retry;
  if (block.comments.length > 0) event.comment = block.comments.join('\n');

  return event;
}

function openReader(response: Response): ReadableStreamDefaultReader<string> | undefined {
  return response.body?.pipeThrough(new TextDecoderStream()).getReader();
}

export async function* readSse(response: Response): AsyncGenerator<SseEvent, void, undefined> {
  const reader = openReader(response);

  if (!reader) return;

  const parser = new SseParser();

  try {
    for (;;) {
      const { done, value } = await reader.read();

      yield* parser.push(value ?? '', done);

      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function collectSse(
  response: Response,
  { max = Number.POSITIVE_INFINITY, timeout = 5000 }: CollectSseOptions = {},
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const reader = openReader(response);

  if (!reader) return events;

  const parser = new SseParser();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, timeout);

  try {
    while (events.length < max) {
      const { done, value } = await reader.read();

      if (timedOut) {
        throw new Error(`collectSse: ${events.length} event(s) after ${timeout}ms, stream still open`, {
          cause: events,
        });
      }

      events.push(...parser.push(value ?? '', done));

      if (done) break;
    }

    return events.slice(0, max);
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
}
