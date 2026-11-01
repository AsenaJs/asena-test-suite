import type { KafkaTestBed, RedisTestBed } from './helpers/brokerBeds.ts';
import type { InheritanceBed } from './inheritance.shared.ts';

// Only the audit service is booted: the inheritance scenarios need one controller and a client.
export class BrokerInheritanceBed implements InheritanceBed {
  public readonly timing;

  public constructor(private readonly bed: RedisTestBed | KafkaTestBed) {
    this.timing = bed.timing;
  }

  public start(): Promise<void> {
    return this.bed.start(['audit']);
  }

  public stop(): Promise<void> {
    return this.bed.stop();
  }

  public send<T = any>(pattern: string, data?: unknown, opts?: { timeout?: number }): Promise<T> {
    return this.bed.clientSend<T>(pattern, data, opts);
  }

  public emit(pattern: string, data?: unknown): Promise<void> {
    return this.bed.clientEmit(pattern, data);
  }

  public bootDuplicatePatternService(): Promise<{ failed: boolean; message: string }> {
    return this.bed.bootDuplicatePatternService();
  }
}
