import { Service } from '@asenajs/asena/decorators';
import type { Booking, CreateBookingDto } from '../../domain/types';

@Service()
export class BookingStore {
  private bookings = new Map<string, Booking>();

  private byClientRef = new Map<string, string>();

  /**
   * Idempotent on clientRef: a redelivered create (at-least-once) returns the
   * existing booking instead of creating a duplicate.
   */
  public create(dto: CreateBookingDto): { booking: Booking; created: boolean } {
    const existingId = this.byClientRef.get(dto.clientRef);

    if (existingId) {
      return { booking: this.bookings.get(existingId)!, created: false };
    }

    const booking: Booking = {
      id: crypto.randomUUID(),
      roomId: dto.roomId,
      guest: dto.guest,
      clientRef: dto.clientRef,
      status: 'pending',
      createdAt: Date.now(),
    };

    this.bookings.set(booking.id, booking);
    this.byClientRef.set(dto.clientRef, booking.id);

    return { booking, created: true };
  }

  public get(id: string): Booking | undefined {
    return this.bookings.get(id);
  }

  public confirm(id: string): void {
    const booking = this.bookings.get(id);

    if (booking?.status === 'pending') {
      booking.status = 'confirmed';
    }
  }

  public cancel(id: string): Booking | undefined {
    const booking = this.bookings.get(id);

    if (!booking) return undefined;

    booking.status = 'cancelled';

    return booking;
  }

  public dump(): Booking[] {
    return [...this.bookings.values()];
  }
}
