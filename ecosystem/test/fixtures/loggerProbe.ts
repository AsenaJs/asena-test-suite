import { AsenaLogger } from '@asenajs/asena-logger';
import { Service } from '@asenajs/asena/decorators';
import { Inject, PostConstruct } from '@asenajs/asena/decorators/ioc';

export const LOGGER_PROBE = 'P2ResolutionLoggerProbe';
const LOGGER_SERVICE = 'P2ResolutionLogger';

export interface LoggerProbe {
  readonly hookCalls: number;
  readonly injectedIsAsenaLogger: boolean;
}

type Component = new (...args: any[]) => unknown;

export function loggerProbeComponents(): Component[] {
  @Service(LOGGER_SERVICE)
  class ResolutionLogger extends AsenaLogger {}

  @Service(LOGGER_PROBE)
  class ResolutionLoggerProbe implements LoggerProbe {
    @Inject(LOGGER_SERVICE)
    private logger!: AsenaLogger;

    public hookCalls = 0;

    public injectedIsAsenaLogger = false;

    @PostConstruct()
    public init(): void {
      this.hookCalls++;
      this.injectedIsAsenaLogger = this.logger instanceof AsenaLogger;
    }
  }

  return [ResolutionLogger, ResolutionLoggerProbe];
}
