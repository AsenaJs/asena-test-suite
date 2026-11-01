import { afterAll } from 'bun:test';
import { assertReachable } from '../../../src/services.ts';
import { runTransportContractSuite } from './contract.shared.ts';
import { KafkaTestBed } from './helpers/brokerBeds.ts';
import { killAllSpawned } from './helpers/spawn.ts';

const active = await assertReachable('kafka');

afterAll(killAllSpawned);

runTransportContractSuite('kafka', () => new KafkaTestBed(), { services: ['kafka'], active });
