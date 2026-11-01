import { MessageController } from '@asenajs/asena/decorators';
import { EventPattern, MessagePattern } from '@asenajs/asena/microservice';
import type { MessageContext } from '@asenajs/asena/microservice';
import { AuditControllerBase } from './AuditControllerBase';

/**
 * Carries the prefix and its own handlers; everything else comes from the base.
 *
 * The wildcard subscription here overlaps the base's exact one on `booking.created`, so a
 * single emit has to reach both handlers of the same controller instance - the fan-out case,
 * inside one class rather than across two services.
 */
@MessageController('audit')
export class AuditController extends AuditControllerBase {
  @EventPattern({ pattern: 'booking.*', prefix: false })
  public async onAnyFromSubclass(data: any, context: MessageContext) {
    this.record('subclass', data, context);
  }

  @MessagePattern('ping')
  public async ping() {
    return { pong: true };
  }
}
