import { expect, spyOn } from 'bun:test';
import { bootApp, scenario } from '@asenajs/adapter-conformance';
import {
  GREETING,
  HANDLER_ERROR,
  injectionComponents,
  type LogLine,
  memoryLog,
  memoryLogger,
  routeComponents,
} from './fixtures/logger.ts';

function plain(lines: LogLine[]): LogLine[] {
  return lines.map((line) => ({ level: line.level, message: Bun.stripANSI(line.message) }));
}

scenario(
  'P2.logger.001',
  'an AsenaLogger passed to the app receives the route table and the startup line',
  async () => {
    const log = memoryLog();
    await using app = await bootApp({ components: routeComponents(), logger: memoryLogger(log) });
    const lines = plain(log.lines);
    const routeTable = lines.filter(
      (line) =>
        line.level === 'info' && line.message.includes('GET /logger/ok') && line.message.includes('GET /logger/fail'),
    );
    const startup = lines.filter(
      (line) => line.level === 'info' && line.message.includes(`http://localhost:${app.port}`),
    );

    expect(routeTable).toHaveLength(1);
    expect(startup).toHaveLength(1);
  },
);

scenario('P2.logger.002', 'a handler error is logged exactly once with its message', async () => {
  const log = memoryLog();
  await using app = await bootApp({ components: routeComponents(), logger: memoryLogger(log) });
  const before = log.lines.length;
  const response = await app.get('/logger/fail');
  const mentions = plain(log.lines.slice(before)).filter((line) => line.message.includes(HANDLER_ERROR));

  expect(response.status).toBe(500);
  expect(mentions).toHaveLength(1);
  expect(mentions[0].level).toBe('error');
});

scenario('P2.logger.003', 'the adapter does not write to the console during boot and a failing request', async () => {
  const log = memoryLog();
  const consoleLog = spyOn(console, 'log');
  const consoleError = spyOn(console, 'error');
  const consoleWarn = spyOn(console, 'warn');

  try {
    await using app = await bootApp({ components: routeComponents(), logger: memoryLogger(log) });
    const failing = await app.get('/logger/fail');
    const ok = await app.get('/logger/ok');

    expect(failing.status).toBe(500);
    expect(ok.status).toBe(200);
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(log.lines.length).toBeGreaterThan(0);
  } finally {
    consoleLog.mockRestore();
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  }
});

scenario(
  'P2.logger.004',
  'an AsenaLogger service is injected into another service of an adapter-booted app',
  async () => {
    const log = memoryLog();
    await using app = await bootApp({ components: injectionComponents(log) });
    const response = await app.get('/logger/greet');

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ injected: true });
    expect(log.lines).toEqual([{ level: 'info', message: GREETING }]);
  },
);
