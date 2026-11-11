import { ExceptionHandler } from '@asenajs/asena/decorators';
import { Catch, type ExceptionContext } from '@asenajs/asena/exception';

export type RefusalOutcome = 'replace' | 'reply' | 'null' | 'decline';

export const REFUSAL_DETAIL = 'refusal-internal-ledger-row-7731';
export const REFUSAL_PUBLIC = 'REFUSED: booking not accepted';

export class BookingRefusedError extends Error {
  public constructor(public readonly outcome: RefusalOutcome) {
    super(`${REFUSAL_DETAIL} (${outcome})`);
    this.name = 'BookingRefusedError';
  }
}

@ExceptionHandler()
export class BookingErrors {
  @Catch(BookingRefusedError)
  public refused(error: BookingRefusedError, ctx: ExceptionContext) {
    if (ctx.scope !== 'microservice' || ctx.kind !== 'message') return undefined;

    switch (error.outcome) {
      case 'replace':
        throw new Error(REFUSAL_PUBLIC);
      case 'reply':
        return { refused: true, source: ctx.source };
      case 'null':
        return null;
      default:
        return undefined;
    }
  }
}
