import type { AsenaContext, RequestSchema } from '@asenajs/asena/adapter';
import { Controller, Service, WebSocket } from '@asenajs/asena/decorators';
import { Get } from '@asenajs/asena/decorators/http';
import { Inject } from '@asenajs/asena/decorators/ioc';
import { AsenaWebSocketService, type Socket } from '@asenajs/asena/web-socket';
import { getDescriptor } from '../../../load.ts';

type Component = new (...args: any[]) => unknown;

export const HARNESS_USER_ID = '3f1a9c7e-9b5d-4c2a-8f6e-1d2b3c4d5e6f';
export const HARNESS_SERVICE = 'HarnessUserService';

export interface HarnessUser {
  id: string;
  name: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uuidParams: RequestSchema<unknown, { id: string }> = {
  '~standard': {
    version: 1,
    vendor: 'asena-suite',
    validate(value) {
      const id = (value as { id?: unknown } | null)?.id;

      if (typeof id === 'string' && UUID.test(id)) return { value: { id } };

      return { issues: [{ message: 'id must be a uuid', path: ['id'] }] };
    },
  },
};

export interface HarnessFixture {
  Service: Component;
  Controller: Component;
}

export function userFixture(): HarnessFixture {
  @Service(HARNESS_SERVICE)
  class HarnessUserService {
    public marker = 'real';

    public async getAll(): Promise<HarnessUser[]> {
      return [{ id: HARNESS_USER_ID, name: 'Real' }];
    }

    public async getById(id: string): Promise<HarnessUser | null> {
      return { id, name: 'Real' };
    }
  }

  @Controller('/harness/users')
  class HarnessUserController {
    @Inject(HarnessUserService)
    private service!: HarnessUserService;

    @Get('/')
    public async list(context: AsenaContext<any, any>) {
      return context.send(await this.service.getAll());
    }

    @Get('/marker')
    public marker(context: AsenaContext<any, any>) {
      return context.send({ marker: this.service.marker });
    }

    @Get('/:id')
    public async byId(context: AsenaContext<any, any>) {
      const user = await this.service.getById(context.getParam('id'));

      return user ? context.send(user) : context.send({ error: 'missing' }, 404);
    }
  }

  return { Service: HarnessUserService, Controller: HarnessUserController };
}

export interface ContractFixture {
  components: Component[];
  calls: { handler: number };
}

export function contractFixture(): ContractFixture {
  const calls = { handler: 0 };
  const ParamsContext = getDescriptor().defineContext({ params: uuidParams }) as new (
    ...args: any[]
  ) => AsenaContext<any, any>;

  class HarnessParamsContext extends ParamsContext {}

  @Controller('/harness/checked')
  class HarnessContractController {
    @Get('/:id')
    public checked(context: HarnessParamsContext) {
      calls.handler++;

      return context.send({ id: context.getParam('id') });
    }
  }

  return { components: [HarnessContractController], calls };
}

export function echoSocketFixture(): Component[] {
  @WebSocket('/harness/ws')
  class HarnessEchoSocket extends AsenaWebSocketService<any> {
    protected onMessage(ws: Socket<any>, message: string | Buffer) {
      ws.send(`echo:${typeof message === 'string' ? message : message.toString()}`);
    }
  }

  return [HarnessEchoSocket];
}
