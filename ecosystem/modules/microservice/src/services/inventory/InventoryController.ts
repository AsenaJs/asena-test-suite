import { MessageController } from '@asenajs/asena/decorators';
import { Inject } from '@asenajs/asena/decorators/ioc';
import { EventPattern, MessagePattern } from '@asenajs/asena/microservice';
import type { MessageContext } from '@asenajs/asena/microservice';
import type { Ulak } from '@asenajs/asena/messaging';
import { ICoreServiceNames } from '@asenajs/asena/ioc/types';

interface Reservation {
  bookingId: string;
  messageId: string;
}

/**
 * Exact-pattern listener that emits a follow-up event FROM INSIDE the handler
 * (the reentrancy case scenario C5 exercises). Records the observed messageId
 * so C4 can assert that every handler of one emit sees the SAME id.
 */
@MessageController('inventory')
export class InventoryController {
  @Inject(ICoreServiceNames.__ULAK__)
  private ulak!: Ulak;

  private reservations: Reservation[] = [];

  @EventPattern({ pattern: 'booking.created', prefix: false })
  public async onBookingCreated(data: { bookingId: string }, context: MessageContext) {
    // messageId dedup: a redelivery must not reserve twice or re-emit
    if (this.reservations.some((reservation) => reservation.messageId === context.messageId)) {
      return;
    }

    this.reservations.push({ bookingId: data?.bookingId, messageId: context.messageId });

    await this.ulak.emit('inventory.reserved', { bookingId: data?.bookingId });
  }

  @MessagePattern('dump')
  public async dump() {
    return this.reservations;
  }
}
