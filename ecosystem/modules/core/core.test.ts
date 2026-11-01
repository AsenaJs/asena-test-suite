import { expect } from 'bun:test';
import type { AsenaContext } from '@asenajs/asena/adapter';
import { Controller, Schedule, Service } from '@asenajs/asena/decorators';
import { Get } from '@asenajs/asena/decorators/http';
import { Inject } from '@asenajs/asena/decorators/ioc';
import { ICoreServiceNames } from '@asenajs/asena/ioc/types';
import type { AsenaSchedule, CronRunner } from '@asenajs/asena/schedule';
import { createCapturingLogger, type TestApp } from '@asenajs/asena/test';
import { bootApp, scenario } from '@asenajs/adapter-conformance';
import { waitFor } from '@asenajs/adapter-conformance/helpers';
import { type EventEntry, eventFixture } from './fixtures/events.ts';
import { bootShutdownApp, connectionRefused, readyStatus } from './fixtures/shutdown.ts';

type Ctx = AsenaContext<any, any>;
type Component = new (...args: any[]) => unknown;

const CRON_PROBE = 'SuiteCronProbe';

function cronProbe(): Component {
  @Service(CRON_PROBE)
  class SuiteCronProbe {
    @Inject(ICoreServiceNames.CRON_RUNNER)
    public runner!: CronRunner;
  }

  return SuiteCronProbe;
}

async function jobNames(app: TestApp): Promise<string[]> {
  return (await app.resolve<{ runner: CronRunner }>(CRON_PROBE)).runner.getJobNames();
}

async function emit(app: TestApp, name: string, data: unknown): Promise<boolean> {
  const response = await fetch(`${app.baseUrl}/events/emit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, data }),
  });

  expect(response.status).toBe(200);

  return ((await response.json()) as { matched: boolean }).matched;
}

async function bootError(components: Component[]): Promise<string> {
  try {
    const app = await bootApp({ components });

    await app.server.stop();
  } catch (error) {
    return (error as Error).message;
  }

  return 'boot succeeded';
}

scenario('P2.core.001', 'an event emitted from an HTTP handler reaches its @On handler', async () => {
  const { components, log } = eventFixture();

  log.length = 0;
  await using app = await bootApp({ components });

  expect(await emit(app, 'user.created', { name: 'Alice' })).toBe(true);
  await waitFor(() => log.length === 1, { label: 'user.created handled' });
  expect(log).toEqual<EventEntry[]>([{ event: 'user.created', data: { name: 'Alice' }, source: 'user' }]);
});

scenario('P2.core.002', 'an event nobody handles reports matched false and logs nothing', async () => {
  const { components, log } = eventFixture();

  log.length = 0;
  await using app = await bootApp({ components });

  expect(await emit(app, 'order.placed', {})).toBe(false);
  expect(await emit(app, 'user.created', { marker: true })).toBe(true);
  await waitFor(() => log.length === 1, { label: 'marker event handled' });
  expect(log.map((entry) => entry.event)).toEqual(['user.created']);
});

scenario('P2.core.003', 'an inherited @On and an own @On both join the subclass prefix', async () => {
  const { components, log } = eventFixture();

  log.length = 0;
  await using app = await bootApp({ components });

  expect(await emit(app, 'audit.archived', { id: 'a2' })).toBe(true);
  expect(await emit(app, 'audit.created', { id: 'a3' })).toBe(true);
  await waitFor(() => log.length === 2, { label: 'both audit events handled' });
  expect([...log].sort((a, b) => a.event.localeCompare(b.event))).toEqual<EventEntry[]>([
    { event: 'audit.archived', data: { id: 'a2' }, source: 'own' },
    { event: 'audit.created', data: { id: 'a3' }, source: 'base' },
  ]);
});

scenario('P2.core.010', '@Schedule jobs register under the concrete subclass name, never the base', async () => {
  abstract class HeartbeatScheduleBase implements AsenaSchedule {
    public async execute() {}
  }

  @Schedule({ cron: '* * * * *' })
  class HeartbeatSchedule extends HeartbeatScheduleBase {}

  await using app = await bootApp({ components: [HeartbeatSchedule, cronProbe()] });
  const names = await jobNames(app);

  expect(names).toContain('HeartbeatSchedule');
  expect(names).not.toContain('HeartbeatScheduleBase');
});

// Bun.cron.parse accepts five fields only ("seconds are not supported", Bun 1.4.4), so the shortest schedule is a minute.
scenario(
  'P2.core.011',
  'a scheduled job really executes once its minute comes',
  async () => {
    let executions = 0;

    @Schedule({ cron: '* * * * *' })
    class EveryMinuteSchedule implements AsenaSchedule {
      public async execute() {
        executions++;
      }
    }

    await using app = await bootApp({ components: [EveryMinuteSchedule, cronProbe()] });

    expect(await jobNames(app)).toContain('EveryMinuteSchedule');
    await waitFor(() => executions > 0, { timeout: 65_000, interval: 250, label: 'cron job executed' });
  },
  { services: ['slow'], timeout: 75_000 },
);

scenario('P2.core.020', 'the health server answers ready while serving and 503 during shutdown', async () => {
  const { server, healthPort, probe } = await bootShutdownApp();

  try {
    expect(await readyStatus(healthPort)).toBe(200);
    expect((await fetch(`http://127.0.0.1:${healthPort}/healthz/live`)).status).toBe(200);
  } finally {
    await server.stop();
  }

  expect(probe.readyStatusDuringStop).toBe(503);
  expect(await connectionRefused(healthPort)).toBe(true);
});

scenario(
  'P2.core.021',
  'an @OnStop hook runs after the adapter stopped and before the transport is destroyed',
  async () => {
    const { server, port, probe } = await bootShutdownApp();

    try {
      expect((await fetch(`http://127.0.0.1:${port}/shutdown/ping`)).status).toBe(200);
    } finally {
      await server.stop();
    }

    expect(probe.newConnectionRefused).toBe(true);
    expect(probe.order).toEqual(['onStop', 'transport.destroy']);
  },
);

scenario('P2.core.030', 'an inherited route and an own route on the same path refuse to boot', async () => {
  abstract class SharedBase {
    @Get('/shared')
    public baseShared(context: Ctx) {
      return context.send({ from: 'base' });
    }
  }

  @Controller('/api/same')
  class DuplicateController extends SharedBase {
    @Get('/shared')
    public subShared(context: Ctx) {
      return context.send({ from: 'sub' });
    }
  }

  const message = await bootError([DuplicateController]);

  expect(message).toContain('Duplicate route detected');
  expect(message).toContain('baseShared');
  expect(message).toContain('subShared');
  expect(message).toContain('GET /api/same/shared');
});

scenario(
  'P2.core.031',
  'two controllers extending one route-carrying base under one prefix refuse to boot',
  async () => {
    abstract class SharedRoutesBase {
      @Get('/shared')
      public shared(context: Ctx) {
        return context.send({ ok: true });
      }
    }

    @Controller('/api/same')
    class FirstController extends SharedRoutesBase {}

    @Controller('/api/same')
    class SecondController extends SharedRoutesBase {}

    const message = await bootError([FirstController, SecondController]);

    expect(message).toContain('Duplicate route detected');
    expect(message).toContain('GET /api/same/shared');
  },
);

scenario('P2.core.032', 'overriding the inherited route method by name boots and serves the override', async () => {
  abstract class OverridableBase {
    @Get('/report')
    public report(context: Ctx) {
      return context.send({ from: 'base' });
    }
  }

  @Controller('/api/override')
  class OverrideController extends OverridableBase {
    @Get('/report')
    public override report(context: Ctx) {
      return context.send({ from: 'sub' });
    }
  }

  await using app = await bootApp({ components: [OverrideController] });
  const response = await fetch(`${app.baseUrl}/api/override/report`);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ from: 'sub' });
});

scenario(
  'P2.core.040',
  'a plain subclass of a @Service is not registered and the warning names both classes',
  async () => {
    @Service()
    class BaseService {
      public value() {
        return 'base';
      }
    }

    class DerivedService extends BaseService {
      public override value() {
        return 'derived';
      }
    }

    const { logger, entries } = createCapturingLogger();

    await using app = await bootApp({ components: [BaseService, DerivedService], logger });

    expect(app.container.has('DerivedService')).toBe(false);
    expect(app.container.has('BaseService')).toBe(true);

    const warning = entries.find((entry) => entry.level === 'warn' && entry.message.includes('DerivedService'));

    expect(warning?.message ?? '').toContain('BaseService');
    expect(warning?.message ?? '').toContain('NOT registered');
  },
);

scenario('P2.core.041', 'a plain subclass of a @Schedule is not a job and the warning names both classes', async () => {
  @Schedule({ cron: '* * * * *' })
  class BaseJob implements AsenaSchedule {
    public async execute() {}
  }

  class DerivedJob extends BaseJob {}

  const { logger, entries } = createCapturingLogger();

  await using app = await bootApp({ components: [BaseJob, DerivedJob, cronProbe()], logger });
  const names = await jobNames(app);

  expect(names).toContain('BaseJob');
  expect(names).not.toContain('DerivedJob');

  const warning = entries.find((entry) => entry.level === 'warn' && entry.message.includes('DerivedJob'));

  expect(warning?.message ?? '').toContain('BaseJob');
  expect(warning?.message ?? '').toContain('NOT registered');
});
