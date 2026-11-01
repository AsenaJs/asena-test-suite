import { afterAll, beforeAll, beforeEach, expect } from 'bun:test';
import { UlakError } from '@asenajs/asena/messaging';
import { area, scenario } from '@asenajs/adapter-conformance';
import { waitFor } from '@asenajs/adapter-conformance/helpers';
import type { SuiteOptions } from './contract.shared.ts';
import type { TransportTiming } from './helpers/testbed.ts';

// Decorator inheritance on message controllers, proven over a real transport: a lost inherited @EventPattern is not an
// error anywhere, it is a subscription that was never opened.
export interface InheritanceBed {
  readonly timing: TransportTiming;
  start(): Promise<void>;
  stop(): Promise<void>;
  send<T = any>(pattern: string, data?: unknown, opts?: { timeout?: number }): Promise<T>;
  emit(pattern: string, data?: unknown): Promise<void>;
  /** Boot a service whose inherited and own @MessagePattern collide; must fail loudly. */
  bootDuplicatePatternService(): Promise<{ failed: boolean; message: string }>;
}

interface AuditRecord {
  source: 'base' | 'subclass';
  messageId: string;
  data?: { ref?: string };
}

export function runInheritanceSuite(bedName: string, makeBed: () => InheritanceBed, options: SuiteOptions): void {
  const { timing } = makeBed();
  const id = (n: string) => `P2.microservice.inheritance.${bedName}.${n}`;
  const opts = { services: options.services, timeout: timing.testMs };

  area(`message controller inheritance [${bedName}]`, () => {
    let bed: InheritanceBed;

    const uid = () => crypto.randomUUID().slice(0, 8);
    const dump = () => bed.send<AuditRecord[]>('audit.dump', {}, { timeout: timing.rpcTimeoutMs });
    const mine = async (ref: string) => (await dump()).filter((record) => record.data?.ref === ref);
    const wait = (predicate: () => Promise<boolean>, label: string) =>
      waitFor(predicate, { timeout: timing.waitForMs, interval: 25, label });

    beforeAll(async () => {
      if (!options.active) return;
      bed = makeBed();
      await bed.start();
    }, timing.bootMs);

    afterAll(async () => {
      await bed?.stop();
    }, timing.testMs);

    beforeEach(async () => {
      if (bed) await bed.send('audit.clear', {}, { timeout: timing.rpcTimeoutMs });
    }, timing.testMs);

    scenario(
      id('I01'),
      'a @MessagePattern declared on the base class answers over the transport',
      async () => {
        const result = await bed.send<{ pong: boolean }>('audit.ping', {}, { timeout: timing.rpcTimeoutMs });

        expect(result.pong).toBe(true);
        expect(Array.isArray(await dump())).toBe(true);
      },
      opts,
    );

    scenario(
      id('I02'),
      'an inherited @EventPattern opens a real subscription',
      async () => {
        const ref = `i2-${uid()}`;

        await bed.emit('booking.created', { ref });
        await wait(
          async () => (await mine(ref)).some((record) => record.source === 'base'),
          'inherited booking.created subscription delivered',
        );
      },
      opts,
    );

    scenario(
      id('I03'),
      'base and subclass handlers both receive one emit (fan-out inside one controller)',
      async () => {
        const ref = `i3-${uid()}`;

        await bed.emit('booking.created', { ref });
        await wait(async () => {
          const records = await mine(ref);

          return records.some((r) => r.source === 'base') && records.some((r) => r.source === 'subclass');
        }, 'both the inherited exact and the own wildcard handler fired');

        expect(new Set((await mine(ref)).map((record) => record.messageId)).size).toBe(1);
      },
      opts,
    );

    scenario(
      id('I04'),
      'the inherited exact subscription stays selective',
      async () => {
        const ref = `i4-${uid()}`;

        await bed.emit('booking.cancelled', { ref });
        await wait(
          async () => (await mine(ref)).some((record) => record.source === 'subclass'),
          'wildcard handler saw booking.cancelled',
        );
        // Give the event time to arrive and be ignored before asserting the negative.
        await Bun.sleep(timing.settleMs);
        expect((await mine(ref)).filter((record) => record.source === 'base')).toHaveLength(0);
      },
      opts,
    );

    scenario(
      id('I05'),
      'a redelivery is still one logical event for each handler',
      async () => {
        const ref = `i5-${uid()}`;

        await bed.emit('booking.created', { ref });
        await wait(async () => (await mine(ref)).length === 2, 'exactly one record per handler');
        await Bun.sleep(timing.settleMs);

        const records = await mine(ref);

        expect(records.filter((record) => record.source === 'base')).toHaveLength(1);
        expect(records.filter((record) => record.source === 'subclass')).toHaveLength(1);
      },
      opts,
    );

    scenario(
      id('I06'),
      'two @MessagePattern handlers resolving to one pattern fail to boot',
      async () => {
        const result = await bed.bootDuplicatePatternService();

        expect(result.failed).toBe(true);
        expect(result.message).toMatch(/duplicate message pattern/i);
        expect(result.message).toContain('dup.report');
        expect(result.message).toContain('baseReport');
        expect(result.message).toContain('subReport');
      },
      opts,
    );

    scenario(
      id('I07'),
      'an unknown handler on the inheriting controller is still unknown',
      async () => {
        const error = await bed.send('audit.doesNotExist', {}, { timeout: timing.probeTimeoutMs }).then(
          () => undefined,
          (thrown: unknown) => thrown,
        );

        expect(error).toBeInstanceOf(UlakError);
      },
      opts,
    );
  });
}
