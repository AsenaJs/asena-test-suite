import { expect } from 'bun:test';
import type { DevtoolsRequestStep, DevtoolsStepKind } from '@asenajs/asena/devtools';
import { scenario } from '@asenajs/adapter-conformance';
import { waitFor } from '@asenajs/adapter-conformance/helpers';
import { CLEANUP_MARKER, talkOutput } from './fixtures/app.ts';
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

  expect(typeof adapter).toBe('string');
  await body(child, adapter!);
}

scenario(
  id('001'),
  'the agent says hello first: the core version, a named adapter, the bound port and the child pid',
  () =>
    withApp('main', async (child, adapter) => {
      expect(await child.hello()).toEqual({
        coreVersion: installedCoreVersion(),
        adapter,
        port: child.port,
        pid: child.pid,
        transports: [],
      });
      expect(adapter.length).toBeGreaterThan(0);
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
      expect(await child.snapshot()).toEqual(appSnapshot);
    }),
  opts,
);

scenario(
  id('003'),
  'an entry that passes explicit components still gets the agent, and its snapshot follows that list',
  () =>
    withApp('main.explicit', async (child) => {
      expect((await child.hello()).port).toBe(child.port);
      expect(await child.snapshot()).toEqual(explicitSnapshot);
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
  id('020'),
  'runSchedule runs the job in the app, answers commandResult and records the run; an unknown job answers ok false',
  () =>
    withApp('main', async (child) => {
      expect(await child.command({ command: 'runSchedule', name: 'NoteCleanup' })).toEqual({
        id: expect.any(String),
        ok: true,
        result: { ran: 'NoteCleanup' },
      });
      await waitFor(() => child.output().includes(CLEANUP_MARKER), { label: 'the job ran in the app' });
      expect(child.requests().filter((record) => record.method === '@Schedule')).toEqual([
        expect.objectContaining({
          path: 'NoteCleanup',
          status: 200,
          steps: [step('controller', 'NoteCleanup.execute')],
          answeredBy: step('controller', 'NoteCleanup.execute'),
        }),
      ]);

      expect(await child.command({ command: 'runSchedule', name: 'NoteArchive' })).toEqual({
        id: expect.any(String),
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
