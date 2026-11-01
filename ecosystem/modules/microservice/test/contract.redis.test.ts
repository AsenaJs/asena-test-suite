import { afterAll } from 'bun:test';
import { assertReachable } from '../../../src/services.ts';
import { runTransportContractSuite } from './contract.shared.ts';
import { RedisTestBed } from './helpers/brokerBeds.ts';
import { killAllSpawned } from './helpers/spawn.ts';

const active = await assertReachable('redis');

afterAll(killAllSpawned);

runTransportContractSuite('redis', () => new RedisTestBed(), { services: ['redis'], active });
