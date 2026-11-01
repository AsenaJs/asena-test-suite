import { MessageController } from '@asenajs/asena/decorators';
import { EventPattern, MessagePattern } from '@asenajs/asena/microservice';
import type { MessageContext } from '@asenajs/asena/microservice';

interface NotificationRecord {
  pattern: string;
  messageId: string;
  attempt: number;
  headers: Record<string, string>;
  data: any;
}

/**
 * Wildcard listener with the documented messageId-dedup recipe applied.
 * rawDeliveries counts every delivery (at-least-once may exceed the emit
 * count); deduped is the exactly-once view the recipe promises. Failure
 * injection is data-driven so resilience scenarios need no code changes:
 * - data.poison: handler always throws (DLQ path)
 * - data.failAttempts: throws while attempt <= failAttempts (redelivery path)
 */
@MessageController('notification')
export class NotificationController {
  private deduped = new Map<string, NotificationRecord>();

  private rawDeliveries = 0;

  @EventPattern({ pattern: 'booking.*', prefix: false })
  public async onBookingEvent(data: any, context: MessageContext) {
    this.rawDeliveries++;

    if (data?.poison) {
      throw new Error('poison event - always fails');
    }

    if (data?.failAttempts && context.attempt <= data.failAttempts) {
      throw new Error(`transient failure (attempt ${context.attempt}/${data.failAttempts})`);
    }

    if (this.deduped.has(context.messageId)) {
      return;
    }

    this.deduped.set(context.messageId, {
      pattern: context.pattern,
      messageId: context.messageId,
      attempt: context.attempt,
      headers: context.headers,
      data,
    });
  }

  @MessagePattern('list')
  public async list() {
    return [...this.deduped.values()];
  }

  @MessagePattern('stats')
  public async stats() {
    return { rawDeliveries: this.rawDeliveries, deduped: this.deduped.size };
  }

  @MessagePattern('clear')
  public async clear() {
    this.deduped.clear();
    this.rawDeliveries = 0;

    return { ok: true };
  }
}
