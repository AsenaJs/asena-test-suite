import { MessageController } from '@asenajs/asena/decorators';
import { Inject } from '@asenajs/asena/decorators/ioc';
import { EventPattern, MessagePattern } from '@asenajs/asena/microservice';
import type { MessageContext } from '@asenajs/asena/microservice';
import type { Ulak } from '@asenajs/asena/messaging';
import { ICoreServiceNames } from '@asenajs/asena/ioc/types';

interface BridgedEvent {
  pattern: string;
  messageId: string;
  headers: Record<string, string>;
  data: any;
}

/**
 * The harness's ONLY transport-aware controller - on purpose: named-transport
 * binding (@MessageController({ transport })) is the feature under test.
 * Handlers here live on the NAMED kafka transport; the raw Ulak re-emits
 * consumed events onto the DEFAULT (redis) transport - a cross-broker bridge.
 * Header copy on the re-emit is what MX3 asserts (metadata survives the hop).
 */
@MessageController({ prefix: 'bridge', transport: 'kafka' })
export class BridgeController {
  @Inject(ICoreServiceNames.__ULAK__)
  private ulak!: Ulak;

  private events: BridgedEvent[] = [];

  @EventPattern({ pattern: 'upstream.order-created', prefix: false })
  public async onUpstreamOrderCreated(data: any, context: MessageContext) {
    this.events.push({
      pattern: context.pattern,
      messageId: context.messageId,
      headers: context.headers,
      data,
    });

    await this.ulak.emit('booking.created', data, { headers: context.headers });
  }

  @MessagePattern('ping')
  public async ping() {
    return { pid: process.pid, transport: 'kafka' };
  }

  @MessagePattern('dump')
  public async dump() {
    return { bridged: this.events.length, events: this.events };
  }
}
