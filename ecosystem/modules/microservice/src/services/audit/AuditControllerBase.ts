import { EventPattern, MessagePattern } from '@asenajs/asena/microservice';
import type { MessageContext } from '@asenajs/asena/microservice';

export interface AuditRecord {
  pattern: string;
  messageId: string;

  /** Which half of the class hierarchy observed this delivery. */
  source: 'base' | 'subclass';
  data: any;
}

/**
 * The base a shared "audit" module would ship: an exact event subscription and the two
 * request/response handlers every service is expected to expose. The concrete controller
 * supplies the prefix and adds its own handlers.
 *
 * The interesting part is that the subclass declares handlers of its own. `@MessagePattern`
 * and `@EventPattern` write to the class that declares the method, and the reader used to
 * return the nearest ancestor's record *whole* - so one handler on the subclass silently
 * discarded every handler it inherited. Over a real broker that is not a missing route, it is
 * a subscription that was never opened: the event is consumed by somebody else's group and
 * nothing anywhere reports a problem.
 */
export abstract class AuditControllerBase {
  protected records: AuditRecord[] = [];

  /** Exact subscription declared on the base class. */
  @EventPattern({ pattern: 'booking.created', prefix: false })
  public async onCreatedFromBase(data: any, context: MessageContext) {
    this.record('base', data, context);
  }

  @MessagePattern('dump')
  public async dump() {
    return this.records;
  }

  @MessagePattern('clear')
  public async clear() {
    this.records = [];

    return { ok: true };
  }

  /** messageId dedup, per observing handler: a redelivery must not look like a second event. */
  protected record(source: 'base' | 'subclass', data: any, context: MessageContext): void {
    const seen = this.records.some((record) => record.messageId === context.messageId && record.source === source);

    if (seen) {
      return;
    }

    this.records.push({ pattern: context.pattern, messageId: context.messageId, source, data });
  }
}
