import { describe, it } from 'bun:test';
import { capabilities } from './capabilities.ts';
import type { CapabilityFlag, DescriptorMember } from './descriptor.ts';
import { hasMember, isOn, mixedDescriptors } from './load.ts';

export type ScenarioService = 'redis' | 'postgres' | 'kafka' | 'mixed' | 'slow';

export interface ScenarioOptions {
  requires?: CapabilityFlag[];
  members?: DescriptorMember[];
  services?: ScenarioService[];
  timeout?: number;
}

export type ScenarioBody = () => void | Promise<void>;

const ID = /^P[12](?:\.[A-Za-z0-9-]+){2,}$/;
const registered = new Set<string>();

function serviceAvailable(service: ScenarioService): boolean {
  switch (service) {
    case 'redis':
      return Boolean(process.env.ASENA_SUITE_REDIS_URL);
    case 'postgres':
      return Boolean(process.env.ASENA_SUITE_POSTGRES_URL);
    case 'kafka':
      return Boolean(process.env.ASENA_SUITE_KAFKA_BROKERS);
    case 'mixed':
      return mixedDescriptors().length >= 2;
    case 'slow':
      return process.env.ASENA_SUITE_SLOW === '1';
    default:
      throw new Error(`Unknown service '${String(service)}'`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function divergenceBody(flag: CapabilityFlag, id: string, fn: ScenarioBody): () => Promise<void> {
  const expected = capabilities[flag].expectedFailure;

  return async () => {
    try {
      await fn();
    } catch (error) {
      const message = messageOf(error);

      if (message.startsWith('expect(') || expected?.test(message)) return;

      throw new Error(`UNEXPECTED (flag ${flag}) ${id}: ${message}`, { cause: error });
    }

    throw new Error(`STALE FLAG ${flag} ${id}: scenario passed`);
  };
}

export function scenario(id: string, title: string, fn: ScenarioBody, options: ScenarioOptions = {}): void {
  if (!ID.test(id)) throw new Error(`Invalid scenario id '${id}' (expected ${ID.source})`);
  if (registered.has(id)) throw new Error(`Duplicate scenario id '${id}'`);

  registered.add(id);

  const requires = options.requires ?? [];
  const members = options.members ?? [];
  const services = options.services ?? [];

  for (const flag of requires) {
    if (!capabilities[flag]) throw new Error(`${id}: unknown capability flag '${String(flag)}'`);
  }

  const offFlags = requires.filter((flag) => !isOn(flag));
  const missingMembers = members.filter((member) => !hasMember(member));
  const missingServices = services.filter((service) => !serviceAvailable(service));
  const fullTitle =
    `[${id}] ${title}` +
    offFlags.map((flag) => ` [cap:${flag}]`).join('') +
    missingMembers.map((member) => ` [cap:member:${member}]`).join('') +
    missingServices.map((service) => ` [svc:${service}]`).join('');

  if (missingServices.length > 0) {
    if (process.env.ASENA_SUITE_REQUIRE_SERVICES === '1') {
      it(
        fullTitle,
        () => {
          throw new Error(`${id}: required service(s) not configured: ${missingServices.join(', ')}`);
        },
        options.timeout,
      );
    } else {
      it.skipIf(true)(fullTitle, fn, options.timeout);
    }

    return;
  }

  const divergence = offFlags.find((flag) => capabilities[flag].kind === 'divergence');

  if (divergence) {
    it(fullTitle, divergenceBody(divergence, id, fn), options.timeout);

    return;
  }

  if (offFlags.length > 0 || missingMembers.length > 0) {
    it.skipIf(true)(fullTitle, fn, options.timeout);

    return;
  }

  it(fullTitle, fn, options.timeout);
}

export function area(name: string, fn: () => void): void {
  describe(name, fn);
}
