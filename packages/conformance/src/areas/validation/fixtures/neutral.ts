import type { AsenaAdapter, AsenaContext } from '@asenajs/asena/adapter';
import { Service } from '@asenajs/asena/decorators';
import { Inject, OnStart } from '@asenajs/asena/decorators/ioc';
import { ICoreServiceNames } from '@asenajs/asena/ioc/types';
import { HttpMethod } from '@asenajs/asena/web-types';

type Component = new (...args: any[]) => unknown;

type RouteParams = Parameters<AsenaAdapter<any, any>['registerRoute']>[0];

export interface RegistrarFixture {
  components: Component[];
  calls: { handler: number };
}

export function registrarFixture(extra: Record<string, unknown>): RegistrarFixture {
  const calls = { handler: 0 };

  @Service()
  class ValidationRouteRegistrar {
    @Inject(ICoreServiceNames.ASENA_ADAPTER)
    private adapter!: AsenaAdapter<any, any>;

    @OnStart()
    public async registerDirect(): Promise<void> {
      await this.adapter.registerRoute({
        method: HttpMethod.GET,
        path: '/direct/route',
        middlewares: [],
        handler: (context: AsenaContext<any, any>) => {
          calls.handler++;

          return context.send({ ok: true });
        },
        staticServe: undefined as never,
        validator: undefined as never,
        controllerName: 'ValidationRouteRegistrar',
        ...extra,
      } as RouteParams);
    }
  }

  return { components: [ValidationRouteRegistrar], calls };
}
