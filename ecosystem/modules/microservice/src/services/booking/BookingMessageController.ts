import { MessageController } from '@asenajs/asena/decorators';
import { Inject } from '@asenajs/asena/decorators/ioc';
import { EventPattern, MessagePattern } from '@asenajs/asena/microservice';
import type { MessageContext } from '@asenajs/asena/microservice';
import { ulak } from '@asenajs/asena/messaging';
import type { Ulak } from '@asenajs/asena/messaging';
import { BookingRefusedError, type RefusalOutcome } from './BookingErrors';
import { BookingStore } from './BookingStore';
import type { CreateBookingDto } from '../../domain/types';

interface SlowRequest {
  delayMs?: number;
  onlyFirstAttempt?: boolean;
  boom?: boolean;
}

@MessageController('booking')
export class BookingMessageController {
  @Inject(BookingStore)
  private store!: BookingStore;

  @Inject(ulak.messages('booking'))
  private events!: Ulak.Messages<'booking'>;

  @MessagePattern('create')
  public async create(dto: CreateBookingDto) {
    const { booking, created } = this.store.create(dto);

    // Only a genuinely new booking emits - a redelivered create must not
    // double-fire downstream events
    if (created) {
      await this.events.emit('created', { bookingId: booking.id, clientRef: booking.clientRef });
    }

    return { ...booking, pid: process.pid };
  }

  @MessagePattern('get')
  public async get(data: { id: string }) {
    const booking = this.store.get(data?.id);

    if (!booking) {
      throw new Error(`NOT_FOUND: booking ${data?.id}`);
    }

    return booking;
  }

  @MessagePattern('cancel')
  public async cancel(data: { id: string }) {
    const booking = this.store.cancel(data?.id);

    if (!booking) {
      throw new Error(`NOT_FOUND: booking ${data?.id}`);
    }

    await this.events.emit('cancelled', { bookingId: booking.id });

    return booking;
  }

  /**
   * Resilience-test workhorse. The marker line is printed BEFORE the sleep so
   * the harness can SIGKILL this replica while the handler is provably
   * mid-flight. onlyFirstAttempt makes the rescued redelivery (attempt > 1)
   * return instantly, so rescue tests don't wait out the full delay again.
   */
  @MessagePattern('slow')
  public async slow(data: SlowRequest, context: MessageContext) {
    if (data?.boom) {
      throw new Error('boom: intentional handler failure');
    }

    const skipDelay = data?.onlyFirstAttempt && context.attempt > 1;

    if (!skipDelay && data?.delayMs) {
      console.log(`[e2e] slow start id=${context.messageId} pid=${process.pid} attempt=${context.attempt}`);
      await new Promise((resolve) => setTimeout(resolve, data.delayMs));
    }

    return { pid: process.pid, attempt: context.attempt };
  }

  // C14 fixture: always fails; BookingErrors decides what the caller sees
  @MessagePattern('refuse')
  public async refuse(data: { outcome: RefusalOutcome }): Promise<never> {
    throw new BookingRefusedError(data?.outcome);
  }

  @MessagePattern('dump')
  public async dump() {
    return this.store.dump();
  }

  // C12 fixture: proves send() headers arrive byte-identical in the context
  @MessagePattern('echoHeaders')
  public async echoHeaders(_data: unknown, context: MessageContext) {
    return { headers: context.headers, pid: process.pid };
  }

  // Closes the event chain: created -> inventory reserves -> booking confirmed
  @EventPattern({ pattern: 'inventory.reserved', prefix: false })
  public async onInventoryReserved(data: { bookingId: string }) {
    this.store.confirm(data?.bookingId);
  }
}
