import { afterAll, beforeAll, beforeEach, expect } from 'bun:test';
import { UlakError, UlakErrorCode } from '@asenajs/asena/messaging';
import { area, scenario, type ScenarioOptions } from '@asenajs/adapter-conformance';
import { waitFor } from '@asenajs/adapter-conformance/helpers';
import { REFUSAL_DETAIL, REFUSAL_PUBLIC, type RefusalOutcome } from '../src/services/booking/BookingErrors.ts';
import type { TransportTestBed } from './helpers/testbed.ts';

type Services = NonNullable<ScenarioOptions['services']>;

export interface SuiteOptions {
  /** Services every scenario of this bed declares; the bed boots only when they are reachable. */
  services: Services;
  active: boolean;
}

// The transport contract: runs unchanged against every bed. Transport capabilities are bed facts, identical for every
// adapter, so the registered ID set never depends on the adapter.
export function runTransportContractSuite(
  bedName: string,
  makeBed: () => TransportTestBed,
  options: SuiteOptions,
): void {
  const probe = makeBed();
  const { timing, capabilities } = probe;
  const id = (n: string) => `P2.microservice.contract.${bedName}.${n}`;
  const opts = { services: options.services, timeout: timing.testMs };

  area(`transport contract [${bedName}]`, () => {
    let bed: TransportTestBed;

    const uid = () => crypto.randomUUID().slice(0, 8);
    const rpc = { timeout: timing.rpcTimeoutMs };
    const postBooking = (dto: Record<string, unknown>) =>
      fetch(`${bed.baseUrl}/bookings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(dto),
      });

    beforeAll(async () => {
      if (!options.active) return;
      bed = makeBed();
      await bed.start();
    }, timing.bootMs);

    afterAll(async () => {
      await bed?.stop();
    }, timing.testMs);

    beforeEach(async () => {
      if (bed) await bed.clientSend('notification.clear', {}, rpc);
    }, timing.testMs);

    scenario(
      id('C01'),
      'full booking lifecycle over HTTP (create/get/cancel)',
      async () => {
        const clientRef = `c1-${uid()}`;
        const created = await postBooking({ roomId: 'R101', guest: 'Ada', clientRef });

        expect(created.status).toBe(201);

        const booking: any = await created.json();

        expect(typeof booking.id).toBe('string');
        expect(booking.roomId).toBe('R101');
        expect(booking.clientRef).toBe(clientRef);

        const fetched = await fetch(`${bed.baseUrl}/bookings/${booking.id}`);

        expect(fetched.status).toBe(200);
        expect((await fetched.json()).id).toBe(booking.id);

        const cancelled = await fetch(`${bed.baseUrl}/bookings/${booking.id}`, { method: 'DELETE' });

        expect(cancelled.status).toBe(200);
        expect((await cancelled.json()).status).toBe('cancelled');

        const after = await fetch(`${bed.baseUrl}/bookings/${booking.id}`);

        expect((await after.json()).status).toBe('cancelled');
      },
      opts,
    );

    scenario(
      id('C02'),
      'RPC errors surface faithfully and are final (no retry)',
      async () => {
        const before: any[] = await bed.clientSend('booking.dump', {}, rpc);
        const notFound = await fetch(`${bed.baseUrl}/bookings/does-not-exist`);

        expect(notFound.status).toBe(404);
        expect((await notFound.json()).error.code).toBe(String(UlakErrorCode.REMOTE_ERROR));
        expect((await fetch(`${bed.baseUrl}/bookings/debug/slow?boom=1`)).status).toBe(502);

        const error = await bed.clientSend('booking.get', { id: 'nope' }, rpc).then(
          () => undefined,
          (thrown: unknown) => thrown,
        );

        expect(error).toBeInstanceOf(UlakError);
        expect((error as UlakError).code).toBe(UlakErrorCode.REMOTE_ERROR);
        expect((error as UlakError).message).toContain('NOT_FOUND');

        const after: any[] = await bed.clientSend('booking.dump', {}, rpc);

        expect(after.length).toBe(before.length);
      },
      opts,
    );

    scenario(
      id('C03'),
      'the caller timeout fires on the caller side',
      async () => {
        const start = Date.now();
        const error = await bed.clientSend('booking.slow', { delayMs: 3000 }, { timeout: 500 }).then(
          () => undefined,
          (thrown: unknown) => thrown,
        );

        expect((error as UlakError).code).toBe(UlakErrorCode.TIMEOUT);
        expect(Date.now() - start).toBeLessThan(2000);
        expect((await fetch(`${bed.baseUrl}/bookings/debug/slow?delayMs=3000&timeout=500`)).status).toBe(504);
      },
      opts,
    );

    scenario(
      id('C04'),
      'event fan-out, wildcard selectivity and one messageId per emit',
      async () => {
        const clientRef = `c4-${uid()}`;
        const booking: any = await (await postBooking({ roomId: 'R4', guest: 'Grace', clientRef })).json();

        await fetch(`${bed.baseUrl}/bookings/${booking.id}`, { method: 'DELETE' });

        let notifications: any[] = [];
        let reservations: any[] = [];

        await waitFor(
          async () => {
            notifications = await bed.clientSend('notification.list', {}, rpc);
            reservations = await bed.clientSend('inventory.dump', {}, rpc);

            const mine = (pattern: string) =>
              notifications.some((record) => record.pattern === pattern && record.data?.bookingId === booking.id);

            return (
              mine('booking.created') &&
              mine('booking.cancelled') &&
              reservations.some((record) => record.bookingId === booking.id)
            );
          },
          {
            timeout: timing.waitForMs,
            interval: 25,
            label: 'fan-out to notification (wildcard) and inventory (exact)',
          },
        );

        expect(reservations.filter((record) => record.bookingId === booking.id).length).toBe(1);

        // Inventory consumes on its own group: give booking.cancelled time to arrive and be ignored before asserting.
        await Bun.sleep(timing.settleMs);
        reservations = await bed.clientSend('inventory.dump', {}, rpc);
        expect(reservations.filter((record) => record.bookingId === booking.id).length).toBe(1);

        const notifCreated = notifications.find(
          (record) => record.pattern === 'booking.created' && record.data?.bookingId === booking.id,
        );
        const reservation = reservations.find((record) => record.bookingId === booking.id);

        expect(notifCreated.messageId).toBe(reservation.messageId);
      },
      opts,
    );

    scenario(
      id('C05'),
      'an event chain (emit inside a handler) completes: created -> reserved -> confirmed',
      async () => {
        const booking: any = await (
          await postBooking({ roomId: 'R5', guest: 'Linus', clientRef: `c5-${uid()}` })
        ).json();

        await waitFor(
          async () => {
            const current: any = await (await fetch(`${bed.baseUrl}/bookings/${booking.id}`)).json();

            return current.status === 'confirmed';
          },
          { timeout: timing.waitForMs, interval: 25, label: 'booking confirmed via the inventory.reserved chain' },
        );
      },
      opts,
    );

    scenario(
      id('C06'),
      'a concurrent burst has no loss, no duplicates and no reply cross-talk',
      async () => {
        const prefix = `burst-${uid()}`;
        const count = 40;
        const responses = await Promise.all(
          Array.from({ length: count }, (_, i) =>
            postBooking({ roomId: `R${i}`, guest: `G${i}`, clientRef: `${prefix}-${i}` }),
          ),
        );

        expect(responses.map((response) => response.status)).toEqual(Array.from({ length: count }, () => 201));

        const bodies: any[] = await Promise.all(responses.map((response) => response.json()));

        expect(new Set(bodies.map((body) => body.id)).size).toBe(count);
        expect(bodies.map((body) => body.clientRef)).toEqual(Array.from({ length: count }, (_, i) => `${prefix}-${i}`));

        const dump: any[] = await bed.clientSend('booking.dump', {}, rpc);

        expect(dump.filter((booking) => booking.clientRef?.startsWith(prefix)).length).toBe(count);

        await waitFor(
          async () => {
            const list: any[] = await bed.clientSend('notification.list', {}, rpc);

            return (
              list.filter(
                (record) => record.pattern === 'booking.created' && record.data?.clientRef?.startsWith(prefix),
              ).length === count
            );
          },
          { timeout: timing.chainMs, interval: 25, label: `all ${count} created events delivered (deduped)` },
        );
      },
      opts,
    );

    scenario(
      id('C07'),
      'an unknown pattern behaves as the transport declares',
      async () => {
        const immediate = capabilities.unknownPatternSend === 'immediate-send-failed';
        const error = await bed.clientSend('booking.doesNotExist', {}, { timeout: timing.probeTimeoutMs }).then(
          () => undefined,
          (thrown: unknown) => thrown,
        );

        expect((error as UlakError).code).toBe(immediate ? UlakErrorCode.SEND_FAILED : UlakErrorCode.TIMEOUT);
        expect((await fetch(`${bed.baseUrl}/bookings/debug/unknown`)).status).toBe(immediate ? 502 : 504);
      },
      opts,
    );

    scenario(
      id('C08'),
      'messageId dedup accounting (at-least-once -> exactly-once view)',
      async () => {
        for (let i = 0; i < 3; i++) await bed.clientEmit('booking.pinged', { n: i });

        await waitFor(
          async () => (await bed.clientSend<{ deduped: number }>('notification.stats', {}, rpc)).deduped === 3,
          {
            timeout: timing.waitForMs,
            interval: 25,
            label: '3 distinct emits -> 3 deduped records',
          },
        );

        const stats: any = await bed.clientSend('notification.stats', {}, rpc);

        expect(stats.rawDeliveries).toBeGreaterThanOrEqual(3);

        if (capabilities.exactlyOnceDelivery) expect(stats.rawDeliveries).toBe(3);
      },
      opts,
    );

    scenario(
      id('C09'),
      'clientRef idempotency: the same ref never creates twice',
      async () => {
        const clientRef = `c9-${uid()}`;
        const first: any = await (await postBooking({ roomId: 'R9', guest: 'Edsger', clientRef })).json();
        const second: any = await (await postBooking({ roomId: 'R9', guest: 'Edsger', clientRef })).json();

        expect(second.id).toBe(first.id);

        const dump: any[] = await bed.clientSend('booking.dump', {}, rpc);

        expect(dump.filter((booking) => booking.clientRef === clientRef).length).toBe(1);
      },
      opts,
    );

    scenario(
      id('C10'),
      'edge validation stays at the edge (no transport involved)',
      async () => {
        const response = await postBooking({});

        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe('VALIDATION');
      },
      opts,
    );

    scenario(
      id('C11'),
      'a service with an invalid final pattern fails to boot loudly',
      async () => {
        const result = await bed.bootBadPatternService();

        expect(result.failed).toBe(true);
        expect(result.message).toMatch(/empty/i);
      },
      opts,
    );

    scenario(
      id('C12'),
      'send/emit headers propagate byte-identical into context.headers',
      async () => {
        const marker = `c12-${uid()}`;
        const echoed: any = await bed.clientSend(
          'booking.echoHeaders',
          {},
          { timeout: timing.rpcTimeoutMs, headers: { 'x-e2e-marker': marker, 'x-multi': 'a,b;c=d' } },
        );

        expect(echoed.headers['x-e2e-marker']).toBe(marker);
        expect(echoed.headers['x-multi']).toBe('a,b;c=d');

        await bed.clientEmit('booking.pinged', { ref: marker }, { headers: { 'x-e2e-marker': marker } });
        await waitFor(
          async () => {
            const list: any[] = await bed.clientSend('notification.list', {}, rpc);

            return list.find((entry) => entry.data?.ref === marker)?.headers?.['x-e2e-marker'] === marker;
          },
          { timeout: timing.waitForMs, interval: 25, label: 'emit headers arrived in the event handler context' },
        );
      },
      opts,
    );

    scenario(
      id('C14'),
      'a @Catch decides what the caller of a failed @MessagePattern sees: its own error, a reply, null, or the original failure',
      async () => {
        const refuse = (outcome: RefusalOutcome) =>
          bed.clientSend('booking.refuse', { outcome }, rpc).then(
            (reply: unknown) => ({ reply }),
            (thrown: unknown) => ({ thrown }),
          );

        const replaced = (await refuse('replace')) as { thrown: UlakError };

        expect(replaced.thrown).toBeInstanceOf(UlakError);
        expect(replaced.thrown.code).toBe(UlakErrorCode.REMOTE_ERROR);
        expect(replaced.thrown.message).toContain(REFUSAL_PUBLIC);
        expect(replaced.thrown.message).not.toContain(REFUSAL_DETAIL);

        expect(await refuse('reply')).toEqual({ reply: { refused: true, source: 'BookingMessageController.refuse' } });
        expect(await refuse('null')).toEqual({ reply: null });

        const declined = (await refuse('decline')) as { thrown: UlakError };

        expect(declined.thrown).toBeInstanceOf(UlakError);
        expect(declined.thrown.code).toBe(UlakErrorCode.REMOTE_ERROR);
        expect(declined.thrown.message).toContain(REFUSAL_DETAIL);

        expect((await bed.clientSend<{ headers: object }>('booking.echoHeaders', {}, rpc)).headers).toBeDefined();
      },
      opts,
    );

    if (capabilities.orderedEvents) {
      scenario(
        id('C13'),
        'events for one consumer arrive in publish order',
        async () => {
          const prefix = `c13-${uid()}`;
          const count = 5;
          const refs = Array.from({ length: count }, (_, i) => `${prefix}-${i}`);

          for (const ref of refs) await bed.clientEmit('booking.pinged', { ref });

          const seen = await waitFor(
            async () => {
              const list: any[] = await bed.clientSend('notification.list', {}, rpc);
              const mine = list
                .filter((record) => record.data?.ref?.startsWith(prefix))
                .map((record) => record.data.ref);

              return mine.length === count ? mine : undefined;
            },
            { timeout: timing.waitForMs, interval: 25, label: `all ${count} ordered events delivered` },
          );

          expect(seen).toEqual(refs);
        },
        opts,
      );
    }
  });
}
