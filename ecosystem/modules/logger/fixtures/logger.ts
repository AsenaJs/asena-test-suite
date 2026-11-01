import { Writable } from 'node:stream';
import type { AsenaContext } from '@asenajs/asena/adapter';
import { Controller, Service } from '@asenajs/asena/decorators';
import { Get } from '@asenajs/asena/decorators/http';
import { Inject } from '@asenajs/asena/decorators/ioc';
import { AsenaLogger } from '@asenajs/asena-logger';

type Component = new (...args: any[]) => unknown;
type WinstonTransport = NonNullable<NonNullable<ConstructorParameters<typeof AsenaLogger>[1]>['transports']>[number];

export interface LogLine {
  level: string;
  message: string;
}

export interface MemoryLog {
  readonly lines: LogLine[];
  readonly transport: WinstonTransport;
}

export const HANDLER_ERROR = 'logger-module handler failure';
export const GREETING = 'greeting served by the injected logger';

export function memoryLog(): MemoryLog {
  const lines: LogLine[] = [];
  const stream = new Writable({
    objectMode: true,
    write(info: { level: string; message: unknown }, _encoding, callback) {
      lines.push({ level: info.level, message: String(info.message) });
      callback();
    },
  });
  // winston pipes into the stream; it only checks that a `log` member exists
  const transport: WinstonTransport = Object.assign(stream, { log: (_info: unknown, next: () => void) => next() });

  return { lines, transport };
}

export function memoryLogger(log: MemoryLog): AsenaLogger {
  return new AsenaLogger(undefined, { level: 'debug', transports: [log.transport] });
}

export function routeComponents(): Component[] {
  @Controller('/logger')
  class LoggerController {
    @Get('/ok')
    public ok(context: AsenaContext<any, any>) {
      return context.send({ ok: true });
    }

    @Get('/fail')
    public fail(): never {
      throw new Error(HANDLER_ERROR);
    }
  }

  return [LoggerController];
}

export function injectionComponents(log: MemoryLog): Component[] {
  @Service('ModuleLogger')
  class ModuleLogger extends AsenaLogger {
    public constructor() {
      super(undefined, { level: 'debug', transports: [log.transport] });
    }
  }

  @Service('Greeter')
  class Greeter {
    @Inject('ModuleLogger')
    private logger!: AsenaLogger;

    public greet(): boolean {
      this.logger.info(GREETING);

      return this.logger instanceof AsenaLogger;
    }
  }

  @Controller('/logger')
  class GreetingController {
    @Inject('Greeter')
    private greeter!: Greeter;

    @Get('/greet')
    public greet(context: AsenaContext<any, any>) {
      return context.send({ injected: this.greeter.greet() });
    }
  }

  return [ModuleLogger, Greeter, GreetingController];
}
