import { afterAll } from 'bun:test';
import { assertReachable } from '../../../src/services.ts';
import { KafkaTestBed } from './helpers/brokerBeds.ts';
import { killAllSpawned } from './helpers/spawn.ts';
import { BrokerInheritanceBed } from './inheritance.brokers.ts';
import { runInheritanceSuite } from './inheritance.shared.ts';

const active = await assertReachable('kafka');

afterAll(killAllSpawned);

runInheritanceSuite('kafka', () => new BrokerInheritanceBed(new KafkaTestBed()), { services: ['kafka'], active });
