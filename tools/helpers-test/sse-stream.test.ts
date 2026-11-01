import { afterEach, describe, expect, it } from 'bun:test';
import type { Server } from 'bun';
import { collectSse, readChunks, readSse } from '@asenajs/adapter-conformance/helpers';
import { errorOf } from './errorOf.ts';

let server: Server<undefined> | undefined;

afterEach(async () => {
  await server?.stop(true);
  server = undefined;
});

function streamOf(parts: string[], { gapMs = 0, keepOpen = false } = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(part));
        if (gapMs > 0) await Bun.sleep(gapMs);
      }

      if (!keepOpen) controller.close();
    },
  });

  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

async function fetchFrom(handler: () => Response): Promise<Response> {
  server = Bun.serve({ port: 0, fetch: handler });

  return fetch(`http://localhost:${server.port}/`);
}

describe('readSse', () => {
  it('parses fields per the EventSource spec', async () => {
    const response = streamOf([
      ': keep-alive\n\n',
      'event: greet\nid: 7\nretry: 1500\ndata: first\ndata:second\n\n',
      'data: crlf\r\n\r\n',
      'data: cr\r\r',
      'data\n\n',
      'retry: soon\nunknown: x\ndata: ok\n\n',
      'data: dropped at eof',
    ]);
    const events = [];

    for await (const event of readSse(response)) events.push(event);

    expect(events).toEqual([
      { data: '', comment: 'keep-alive' },
      { event: 'greet', id: '7', retry: 1500, data: 'first\nsecond' },
      { data: 'crlf' },
      { data: 'cr' },
      { data: '' },
      { data: 'ok' },
    ]);
  });

  it('handles events split across network chunks', async () => {
    const response = await fetchFrom(() => streamOf(['da', 'ta: a', 'b\n', '\ndata: c\r', '\n\r\n'], { gapMs: 5 }));
    const events = [];

    for await (const event of readSse(response)) events.push(event.data);

    expect(events).toEqual(['ab', 'c']);
  });

  it('strips a leading BOM', async () => {
    const events = [];

    for await (const event of readSse(streamOf(['﻿data: x\n\n']))) events.push(event);

    expect(events).toEqual([{ data: 'x' }]);
  });
});

describe('collectSse', () => {
  it('stops after max events on an open stream', async () => {
    const response = await fetchFrom(() => streamOf(['data: 1\n\n', 'data: 2\n\n', 'data: 3\n\n'], { keepOpen: true }));

    const events = await collectSse(response, { max: 2, timeout: 1000 });

    expect(events.map((event) => event.data)).toEqual(['1', '2']);
  });

  it('collects until the stream ends', async () => {
    const events = await collectSse(streamOf(['data: 1\n\n', 'data: 2\n\n']));

    expect(events.map((event) => event.data)).toEqual(['1', '2']);
  });

  it('rejects when the stream stays open past the timeout', async () => {
    const response = await fetchFrom(() => streamOf(['data: 1\n\n'], { keepOpen: true }));

    expect((await errorOf(collectSse(response, { max: 5, timeout: 100 }))).message).toContain('1 event(s) after 100ms');
  });
});

describe('readChunks', () => {
  it('returns progressive chunks and the full text', async () => {
    const response = await fetchFrom(() => streamOf(['alpha-', 'beta-', 'gamma'], { gapMs: 40 }));

    const { chunks, text } = await readChunks(response);

    expect(text).toBe('alpha-beta-gamma');
    expect(chunks.length).toBe(3);
    expect(chunks.map((chunk) => chunk.text)).toEqual(['alpha-', 'beta-', 'gamma']);
    expect(chunks[2].at - chunks[0].at).toBeGreaterThan(40);
  });

  it('decodes a multi-byte character split across chunks', async () => {
    const bytes = new TextEncoder().encode('ğü');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 1));
        controller.enqueue(bytes.slice(1));
        controller.close();
      },
    });

    const { text } = await readChunks(new Response(body));

    expect(text).toBe('ğü');
  });

  it('rejects when the stream stays open past the timeout', async () => {
    const response = await fetchFrom(() => streamOf(['x'], { keepOpen: true }));

    expect((await errorOf(readChunks(response, { timeout: 100 }))).message).toContain('stream still open after 100ms');
  });
});
