import type { AsenaServer } from '@asenajs/asena';
import { AsenaServerFactory } from '@asenajs/asena';
import { Config } from '@asenajs/asena/decorators';
import { InMemoryTransport } from '@asenajs/asena/microservice';
import type { AsenaConfig } from '@asenajs/asena/server/config';
import { silentLogger } from '@asenajs/asena/test';
import { AuditController } from '../src/services/audit/AuditController.ts';
import { DuplicatePatternController } from '../src/services/duppattern/DuplicatePatternController.ts';
import { bootFailure, MEMORY_TIMING } from './helpers/testbed.ts';
import { type InheritanceBed, runInheritanceSuite } from './inheritance.shared.ts';

// The audit controller on its own in-process bus, so the contract topology stays untouched.
class MemoryInheritanceBed implements InheritanceBed {
  public readonly timing = MEMORY_TIMING;

  private transport = new InMemoryTransport();

  private server?: AsenaServer<any>;

  public async start(): Promise<void> {
    const transport = this.transport;

    @Config()
    class AuditConfig implements AsenaConfig {
      public transport() {
        return { microservice: transport };
      }
    }

    this.server = await AsenaServerFactory.create({
      headless: true,
      logger: silentLogger,
      components: [AuditConfig, AuditController],
    });
    await this.server.start();
  }

  public async stop(): Promise<void> {
    await this.server?.stop();
    this.server = undefined;
  }

  public send<T = any>(pattern: string, data?: unknown, opts?: { timeout?: number }): Promise<T> {
    return this.transport.send<T>(pattern, data, opts);
  }

  public emit(pattern: string, data?: unknown): Promise<void> {
    return this.transport.emit(pattern, data);
  }

  public bootDuplicatePatternService(): Promise<{ failed: boolean; message: string }> {
    return bootFailure(DuplicatePatternController);
  }
}

runInheritanceSuite('memory', () => new MemoryInheritanceBed(), { services: [], active: true });
