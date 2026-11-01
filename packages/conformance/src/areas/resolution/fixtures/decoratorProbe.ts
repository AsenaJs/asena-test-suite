import '@asenajs/asena';

export interface DecoratorProbeResult {
  methodDecoratorArgs: number;
  paramTypes: unknown;
}

class ProbeDependency {}

type MetadataReader = (key: string, target: object) => unknown;

export function runDecoratorProbe(): DecoratorProbeResult {
  let methodDecoratorArgs = -1;

  const recordMethod = (...args: unknown[]): void => {
    methodDecoratorArgs = args.length;
  };
  const markClass = (_target: object): void => {};

  @markClass
  class Probe {
    public constructor(public readonly dependency: ProbeDependency) {}

    @recordMethod
    public method(): void {}
  }

  const getMetadata = (Reflect as unknown as { getMetadata?: MetadataReader }).getMetadata;

  return {
    methodDecoratorArgs,
    paramTypes: typeof getMetadata === 'function' ? getMetadata('design:paramtypes', Probe) : undefined,
  };
}
