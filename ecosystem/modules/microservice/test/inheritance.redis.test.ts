import { afterAll } from 'bun:test';
import { assertReachable } from '../../../src/services.ts';
import { RedisTestBed } from './helpers/brokerBeds.ts';
import { killAllSpawned } from './helpers/spawn.ts';
import { BrokerInheritanceBed } from './inheritance.brokers.ts';
import { runInheritanceSuite } from './inheritance.shared.ts';

const active = await assertReachable('redis');

afterAll(killAllSpawned);

runInheritanceSuite('redis', () => new BrokerInheritanceBed(new RedisTestBed()), { services: ['redis'], active });
