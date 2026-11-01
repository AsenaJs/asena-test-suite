export { runConformance } from './run.ts';
export { scenario, area, type ScenarioOptions } from './scenario.ts';
export { getDescriptor, mixedDescriptors, adapterPackageRoot, setDescriptor, runTag } from './load.ts';
export { bootApp } from './boot.ts';
export { capabilities } from './capabilities.ts';
export type {
  AdapterDescriptor,
  OptionalFlag,
  DescriptorMember,
  ConformanceCorsOptions,
  ConformanceRateLimiterOptions,
} from './descriptor.ts';
