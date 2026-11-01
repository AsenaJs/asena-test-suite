import { runTransportContractSuite } from './contract.shared.ts';
import { MemoryTestBed } from './helpers/testbed.ts';

runTransportContractSuite('memory', () => new MemoryTestBed(), { services: [], active: true });
