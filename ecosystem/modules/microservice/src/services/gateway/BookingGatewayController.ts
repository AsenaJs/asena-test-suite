import type { AsenaContext } from '@asenajs/asena/adapter';
import { Controller } from '@asenajs/asena/decorators';
import { Delete, Get, Post } from '@asenajs/asena/decorators/http';
import { Inject } from '@asenajs/asena/decorators/ioc';
import { type Ulak, ulak } from '@asenajs/asena/messaging';
import type { CreateBookingDto } from '../../domain/types.ts';
import { mapUlakError } from './errorMapping.ts';

type Context = AsenaContext<any, any>;

@Controller('/bookings')
export class BookingGatewayController {
  @Inject(ulak.messages('booking'))
  private bookings!: Ulak.Messages<'booking'>;

  @Post({ path: '/' })
  public async create(context: Context) {
    const dto = await context.getBody<Partial<CreateBookingDto> | undefined>();
    const missing = (['roomId', 'guest', 'clientRef'] as const).filter((field) => !dto?.[field]);

    if (missing.length) {
      return context.send({ error: { code: 'VALIDATION', message: `Missing fields: ${missing.join(', ')}` } }, 400);
    }

    return this.forward(context, () => this.bookings.send('create', dto), 201);
  }

  @Get({ path: '/:id' })
  public async get(context: Context) {
    return this.forward(context, () => this.bookings.send('get', { id: context.getParam('id') }));
  }

  @Delete('/:id')
  public async cancel(context: Context) {
    return this.forward(context, () => this.bookings.send('cancel', { id: context.getParam('id') }));
  }

  @Get({ path: '/debug/slow' })
  public async slow(context: Context) {
    const delayMs = Number((await context.getQuery('delayMs')) ?? 0);
    const timeout = Number((await context.getQuery('timeout')) ?? 0) || undefined;
    const boom = (await context.getQuery('boom')) === '1';

    return this.forward(context, () => this.bookings.send('slow', { delayMs, boom }, { timeout }));
  }

  @Get({ path: '/debug/unknown' })
  public async unknown(context: Context) {
    return this.forward(context, () => this.bookings.send('doesNotExist', {}, { timeout: 800 }));
  }

  private async forward(context: Context, call: () => Promise<unknown>, status = 200) {
    try {
      return context.send(await call(), status);
    } catch (error) {
      const mapped = mapUlakError(error);

      return context.send(mapped.body, mapped.status);
    }
  }
}
