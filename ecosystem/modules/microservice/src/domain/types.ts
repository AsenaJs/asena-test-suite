export type BookingStatus = 'pending' | 'confirmed' | 'cancelled';

export interface Booking {
  id: string;
  roomId: string;
  guest: string;

  /**
   * Client-supplied idempotency key: the same clientRef always resolves to the
   * same booking. This is the domain-level absorber for at-least-once delivery
   * (a redelivered/zombie create request must not produce a second booking).
   */
  clientRef: string;
  status: BookingStatus;
  createdAt: number;
}

export interface CreateBookingDto {
  roomId: string;
  guest: string;
  clientRef: string;
}
