import { expect } from 'bun:test';
import type { DevtoolsRequestStep, DevtoolsStepKind } from '@asenajs/asena/devtools';
import { scenario } from '@asenajs/adapter-conformance';
import { waitFor } from '@asenajs/adapter-conformance/helpers';
import {
  CLEANUP_MARKER,
  FLOOD_CHUNK,
  FLOOD_LINES,
  LATE_MARKER,
  WARNING_PREFIX,
  floodLine,
  talkOutput,
} from './fixtures/app.ts';
import { appSnapshot, explicitSnapshot } from './fixtures/snapshot.ts';
import { AgentChild, type FixtureEntry, installedCoreVersion } from './harness/agentChild.ts';

const opts = { timeout: 20_000 };
const id = (n: string) => `P2.devtools.${n}`;
const step = (kind: DevtoolsStepKind, name: string): DevtoolsRequestStep => ({ kind, name });
const audit = step('global-middleware', 'NoteAudit.handle');

interface Chain {
  status: number;
  steps: DevtoolsRequestStep[];
  answeredBy: DevtoolsRequestStep;
}

/** The record F4 shows for one request, checked against the response the client really got. */
async function chainOf(child: AgentChild, method: string, path: string, body?: unknown): Promise<Chain> {
  const before = Date.now();
  const { status, record } = await child.fetch(method, path, body);

  expect(record.status).toBe(status);
  expect(record.startedAt).toBeGreaterThanOrEqual(before - 1);
  expect(record.durationMs).toBeGreaterThanOrEqual(0);

  return { status: record.status, steps: record.steps, answeredBy: record.answeredBy };
}

/** Each step chain ends in the step that answered, so a chain fully determines its record. */
function answered(status: number, ...steps: DevtoolsRequestStep[]): Chain {
  return { status, steps, answeredBy: steps.at(-1)! };
}

async function withApp(entry: FixtureEntry, body: (child: AgentChild, adapter: string) => Promise<void>) {
  await using child = await AgentChild.spawn(entry);
  const { adapter } = await child.hello();

  if (typeof adapter !== 'string') throw new Error(`the agent named no adapter: ${String(adapter)}`);

  await body(child, adapter);
}

scenario(
  id('001'),
  'the agent says hello first: the core version, a named adapter, the bound port and the child pid',
  () =>
    withApp('main', async (child, adapter) => {
      const hello = await child.hello();

      expect(hello).toEqual({
        serverId: expect.any(String),
        coreVersion: installedCoreVersion(),
        adapter,
        port: child.port,
        pid: child.pid,
        transports: [],
      });
      expect(adapter.length).toBeGreaterThan(0);
      expect(hello.serverId.length).toBeGreaterThan(0);
      await child.snapshot();
      expect(child.messages.slice(0, 2).map((message) => message.type)).toEqual(['hello', 'snapshot']);
    }),
  opts,
);

scenario(
  id('002'),
  'the snapshot is the same metadata on every adapter: components, routes, schedules, handlers and config',
  () =>
    withApp('main', async (child) => {
      const { serverId } = await child.hello();

      expect(await child.snapshot()).toEqual({ ...appSnapshot, serverId });
    }),
  opts,
);

scenario(
  id('003'),
  'an entry that passes explicit components still gets the agent, and its snapshot follows that list',
  () =>
    withApp('main.explicit', async (child) => {
      const { port, serverId } = await child.hello();

      expect(port).toBe(child.port);
      expect(await child.snapshot()).toEqual({ ...explicitSnapshot, serverId });
    }),
  opts,
);

scenario(
  id('010'),
  'a matched route with no middleware is recorded as answered by its controller method',
  () =>
    withApp('main', async (child) => {
      expect(await chainOf(child, 'GET', '/status')).toEqual(
        answered(200, step('controller', 'StatusController.read')),
      );
    }),
  opts,
);

scenario(
  id('011'),
  'a matched route behind a global middleware records the middleware, then the controller method',
  () =>
    withApp('main', async (child) => {
      expect(await chainOf(child, 'GET', '/notes')).toEqual(
        answered(200, audit, step('controller', 'NoteController.list')),
      );
    }),
  opts,
);

scenario(
  id('012'),
  'an error a @Catch answers is recorded as answered by that @Catch method',
  () =>
    withApp('main', async (child) => {
      expect(await chainOf(child, 'GET', '/notes/missing')).toEqual(
        answered(404, audit, step('controller', 'NoteController.missing'), step('catch', 'NoteErrors.missing')),
      );
    }),
  opts,
);

scenario(
  id('013'),
  'an error nothing catches is recorded as answered by the adapter default, named after the adapter',
  () =>
    withApp('main', async (child, adapter) => {
      expect(await chainOf(child, 'GET', '/notes/broken')).toEqual(
        answered(500, audit, step('controller', 'NoteController.broken'), step('adapter-default', adapter)),
      );
    }),
  opts,
);

scenario(
  id('014'),
  'a route middleware answering false is recorded as the 403 answer, and the handler never runs',
  () =>
    withApp('main', async (child) => {
      expect(await chainOf(child, 'GET', '/notes/locked')).toEqual(
        answered(403, audit, step('middleware', 'NoteLock.handle')),
      );
    }),
  opts,
);

scenario(
  id('015'),
  'a legacy validator failure is answered by its validator step, <Validator>.<target>, with no adapter default after it',
  () =>
    withApp('main', async (child) => {
      const validator = step('validator', 'NoteValidator.json');

      expect(await chainOf(child, 'POST', '/notes', { title: '' })).toEqual(answered(400, audit, validator));
      expect(await chainOf(child, 'POST', '/notes', { title: 'groceries' })).toEqual(
        answered(201, audit, validator, step('controller', 'NoteController.create')),
      );
    }),
  opts,
);

scenario(
  id('016'),
  'an unmatched route is recorded as answered by the @NotFound method',
  () =>
    withApp('main', async (child) => {
      expect(await chainOf(child, 'GET', '/nowhere')).toEqual(
        answered(404, step('not-found', 'NoteFallback.notFound')),
      );
    }),
  opts,
);

scenario(
  id('017'),
  'an unmatched route with no @NotFound is recorded as answered by the adapter default, named after the adapter',
  () =>
    withApp('main.explicit', async (child, adapter) => {
      expect(await chainOf(child, 'GET', '/nowhere')).toEqual(answered(404, step('adapter-default', adapter)));
    }),
  opts,
);

scenario(
  id('018'),
  'a validator hook answering the failure is the answer: the validator step, with no adapter default after it',
  () =>
    withApp('main.drafts', async (child) => {
      const validator = step('validator', 'DraftHookValidator.json');
      const failed = await child.fetch('POST', '/drafts/hooked', { title: '' });

      expect(JSON.parse(failed.body)).toEqual({ by: 'hook' });
      expect(await chainOf(child, 'POST', '/drafts/hooked', { title: '' })).toEqual(answered(422, validator));
      expect(await chainOf(child, 'POST', '/drafts/hooked', { title: 'draft' })).toEqual(
        answered(201, validator, step('controller', 'DraftController.hooked')),
      );
    }),
  opts,
);

scenario(
  id('019'),
  'a validation failure an app @Catch or onError answers is recorded as that handler, after the validator step',
  () =>
    withApp('main.drafts', async (child) => {
      const caught = await child.fetch('POST', '/drafts/caught', { title: '' });

      expect(JSON.parse(caught.body)).toEqual({ by: 'catch', target: 'json' });
      expect(await chainOf(child, 'POST', '/drafts/caught', { title: '' })).toEqual(
        answered(422, step('validator', 'DraftValidator.json'), step('catch', 'DraftErrors.validation')),
      );

      const handled = await child.fetch('GET', '/drafts/search');

      expect(JSON.parse(handled.body)).toEqual({ by: 'onError', target: 'query' });
      expect(await chainOf(child, 'GET', '/drafts/search')).toEqual(
        answered(
          422,
          step('validator', 'DraftQueryValidator.query'),
          step('catch', 'DraftErrors.validation'),
          step('config-onError', 'DraftConfig.onError'),
        ),
      );
    }),
  opts,
);

scenario(
  id('020'),
  'runSchedule runs the job in the app, answers commandResult and records the run with its output; an unknown job answers ok false',
  () =>
    withApp('main', async (child) => {
      const { serverId } = await child.hello();

      expect(await child.command({ command: 'runSchedule', name: 'NoteCleanup' })).toEqual({
        id: expect.any(String),
        serverId,
        ok: true,
        result: { ran: 'NoteCleanup' },
      });
      await waitFor(() => child.output().includes(CLEANUP_MARKER), { label: 'the job ran in the app' });
      expect(child.requests().filter((record) => record.method === '@Schedule')).toEqual([
        expect.objectContaining({
          serverId,
          path: 'NoteCleanup',
          status: 200,
          steps: [step('controller', 'NoteCleanup.execute')],
          answeredBy: step('controller', 'NoteCleanup.execute'),
          logs: [{ stream: 'stdout', text: `${CLEANUP_MARKER}\n`, at: expect.any(Number) }],
        }),
      ]);

      expect(await child.command({ command: 'runSchedule', name: 'NoteArchive' })).toEqual({
        id: expect.any(String),
        serverId,
        ok: false,
        error: { name: 'Error', message: expect.stringContaining('NoteArchive') },
      });
    }),
  opts,
);

scenario(
  id('030'),
  'after the agent attached, SIGTERM stops the app and the process exits on its own',
  async () => {
    const child = await AgentChild.spawn('main');

    expect((await child.command({ command: 'runSchedule', name: 'NoteCleanup' })).ok).toBe(true);

    const exit = await child.stop();

    expect({ code: exit.code, signal: exit.signal }).toEqual({ code: 0, signal: null });
    expect(exit.afterMs).toBeLessThan(3000);
  },
  opts,
);

scenario(
  id('031'),
  'under NODE_ENV=production the app serves but the agent stays off: no message, no command run, one warning saying why',
  async () => {
    const devtoolsWarnings = (child: AgentChild) =>
      child
        .output()
        .split('\n')
        .filter((line) => line.startsWith(WARNING_PREFIX) && line.includes('devtools agent'));

    await using child = await AgentChild.spawn('main.warnings', { env: { NODE_ENV: 'production' }, ready: 'http' });

    expect(await child.status('GET', '/status')).toBe(200);
    expect(await child.status('GET', '/notes/late')).toBe(200);
    expect(await child.status('GET', '/notes/missing')).toBe(404);
    expect(await child.status('GET', '/notes/broken')).toBe(500);
    expect(await child.status('GET', '/nowhere')).toBe(404);
    await waitFor(() => child.output().includes(LATE_MARKER.after), { label: 'app output on the real stream' });

    child.post({ command: 'runSchedule', name: 'NoteCleanup' });
    // A metrics sample is due every second: long enough for one to have been sent if the agent were on.
    await Bun.sleep(1500);

    expect(child.messages).toEqual([]);
    expect(child.output()).not.toContain(CLEANUP_MARKER);
    expect(devtoolsWarnings(child)).toEqual([expect.stringContaining('NODE_ENV is production')]);

    const exit = await child.stop();

    expect({ code: exit.code, signal: exit.signal }).toEqual({ code: 0, signal: null });

    await using attached = await AgentChild.spawn('main.warnings');

    expect((await attached.hello()).port).toBe(attached.port);
    expect((await attached.fetch('GET', '/status')).record.status).toBe(200);
    expect(devtoolsWarnings(attached)).toEqual([]);
  },
  opts,
);

scenario(
  id('032'),
  'two servers in one process report under their own server ids, and a command addressed to the older one runs there',
  async () => {
    await using child = await AgentChild.spawn('main.pair');
    const [older, newer] = await child.hellos(2);
    const cleanup = { command: 'runSchedule', name: 'NoteCleanup' } as const;

    expect([older.port, newer.port]).toEqual([child.port, child.secondPort]);
    expect(older.serverId.length).toBeGreaterThan(0);
    expect(newer.serverId.length).toBeGreaterThan(0);
    expect(newer.serverId).not.toBe(older.serverId);

    await waitFor(() => child.snapshots().length >= 2, { label: 'a snapshot per server' });
    expect(child.snapshots().map((snapshot) => snapshot.serverId)).toEqual([older.serverId, newer.serverId]);
    expect(child.snapshots()[0]).toEqual({ ...explicitSnapshot, serverId: older.serverId });
    expect(child.snapshots()[1].schedules).toEqual([]);
    expect([...new Set(child.snapshots()[1].routes.map((route) => route.controller))]).toEqual(['DraftController']);

    const onOlder = await child.fetch('GET', '/status');
    const onNewer = await child.fetch('GET', '/drafts/search', undefined, child.secondPort);
    const unmatched = await child.fetch('GET', '/status/', undefined, child.secondPort);

    expect({
      status: onOlder.status,
      serverId: onOlder.record.serverId,
      answeredBy: onOlder.record.answeredBy,
    }).toEqual({ status: 200, serverId: older.serverId, answeredBy: step('controller', 'StatusController.read') });
    expect({
      status: onNewer.status,
      serverId: onNewer.record.serverId,
      answeredBy: onNewer.record.answeredBy,
    }).toEqual({ status: 422, serverId: newer.serverId, answeredBy: step('config-onError', 'DraftConfig.onError') });
    expect({
      status: unmatched.status,
      serverId: unmatched.record.serverId,
      answeredBy: unmatched.record.answeredBy,
    }).toEqual({ status: 404, serverId: newer.serverId, answeredBy: step('adapter-default', String(newer.adapter)) });

    expect(await child.command(cleanup, older.serverId)).toEqual({
      id: expect.any(String),
      serverId: older.serverId,
      ok: true,
      result: { ran: 'NoteCleanup' },
    });
    await waitFor(() => child.output().includes(CLEANUP_MARKER), { label: 'the job ran in the app' });
    expect(
      child
        .requests()
        .filter((record) => record.method === '@Schedule')
        .map((record) => ({ serverId: record.serverId, path: record.path, status: record.status })),
    ).toEqual([{ serverId: older.serverId, path: 'NoteCleanup', status: 200 }]);

    expect(await child.command(cleanup)).toEqual({
      id: expect.any(String),
      serverId: newer.serverId,
      ok: false,
      error: { name: 'Error', message: expect.stringContaining('NoteCleanup') },
    });

    const stray = await child.command(cleanup, `${older.serverId}-${newer.serverId}`);

    expect({ ok: stray.ok, answeredBy: stray.serverId }).toEqual({ ok: false, answeredBy: undefined });

    const sample = await waitFor(() => child.metrics().find((metrics) => Object.keys(metrics.servers).length === 2), {
      label: 'a metrics sample naming both servers',
      timeout: 5000,
    });

    expect(Object.keys(sample.servers).sort()).toEqual([older.serverId, newer.serverId].sort());
    expect(Object.values(sample.servers).map((server) => server.readiness.status)).toEqual(['up', 'up']);

    const exit = await child.stop();

    expect({ code: exit.code, signal: exit.signal }).toEqual({ code: 0, signal: null });
  },
  opts,
);

scenario(
  id('040'),
  'two overlapping requests that both write get only their own output in logs, in order, on the stream it went to',
  () =>
    withApp('main', async (child) => {
      const talks = await Promise.all(['a', 'b'].map((tag) => child.fetch('GET', `/notes/talk/${tag}`)));

      for (const [index, tag] of ['a', 'b'].entries()) {
        const { status, body, record } = talks[index];

        expect({ status, body: JSON.parse(body) }).toEqual({ status: 200, body: { tag, overlapped: true } });
        expect(record.answeredBy).toEqual(step('controller', 'NoteController.talk'));
        expect(record.logs).toEqual(talkOutput(tag).map((line) => ({ ...line, at: expect.any(Number) })));
        expect(record.logsTruncated).toBeUndefined();

        for (const line of talkOutput(tag)) {
          await waitFor(() => child.output().includes(line.text.trimEnd()), {
            label: `${line.text} on the real stream`,
          });
        }
      }

      expect((await child.fetch('GET', '/status')).record.logs).toBeUndefined();
    }),
  opts,
);

scenario(
  id('041'),
  'a record keeps the first 100 writes or 16 KiB of output, whichever comes first, and says logsTruncated',
  () =>
    withApp('main', async (child) => {
      const entries = (await child.fetch('GET', '/notes/flood/entries')).record;

      expect(entries.logs?.map((log) => log.text)).toEqual(
        Array.from({ length: 100 }, (_, index) => `${floodLine(index)}\n`),
      );
      expect(entries.logsTruncated).toBe(true);
      await waitFor(() => child.output().includes(floodLine(FLOOD_LINES - 1)), {
        label: 'every line on the real stream',
      });

      const chars = (await child.fetch('GET', '/notes/flood/chars')).record;
      const kept = chars.logs?.map((log) => log.text).join('') ?? '';

      expect({ kept: kept.length, onlyChunks: /^x+$/.test(kept), truncated: chars.logsTruncated }).toEqual({
        kept: 16 * 1024,
        onlyChunks: true,
        truncated: true,
      });
      expect(chars.logs?.every((log) => log.stream === 'stdout')).toBe(true);
      await waitFor(() => child.output().includes('x'.repeat(FLOOD_CHUNK.size * FLOOD_CHUNK.count)), {
        label: 'every chunk on the real stream',
      });
    }),
  opts,
);

scenario(
  id('042'),
  'output written after the record closed reaches the real stream but no record',
  () =>
    withApp('main', async (child) => {
      const { record } = await child.fetch('GET', '/notes/late');

      expect(record.logs).toEqual([{ stream: 'stdout', text: `${LATE_MARKER.before}\n`, at: expect.any(Number) }]);
      await waitFor(() => child.output().includes(LATE_MARKER.after), { label: 'the late line on the real stream' });

      // IPC keeps order: once this record arrived, anything sent for the late line already has.
      expect((await child.fetch('GET', '/status')).record.logs).toBeUndefined();
      expect(child.requests().filter((entry) => JSON.stringify(entry.logs ?? []).includes(LATE_MARKER.after))).toEqual(
        [],
      );
    }),
  opts,
);
