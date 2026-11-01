import { Service } from '@asenajs/asena/decorators';
import { PostConstruct } from '@asenajs/asena/decorators/ioc';

export const POST_CONSTRUCT_PROBE = 'ResolutionPostConstructProbe';

export interface PostConstructProbe {
  readonly hookCalls: number;
}

export function postConstructProbeClass(): new () => PostConstructProbe {
  @Service(POST_CONSTRUCT_PROBE)
  class ResolutionPostConstructProbe implements PostConstructProbe {
    public hookCalls = 0;

    @PostConstruct()
    public init(): void {
      this.hookCalls++;
    }
  }

  return ResolutionPostConstructProbe;
}
