import type { AsenaContext } from '@asenajs/asena/adapter';
import { Config, Controller, Service, WebSocket } from '@asenajs/asena/decorators';
import { Get, Post } from '@asenajs/asena/decorators/http';
import { Inject } from '@asenajs/asena/decorators/ioc';
import { type Ulak, ulak } from '@asenajs/asena/messaging';
import type { AsenaConfig } from '@asenajs/asena/server/config';
import { AsenaWebSocketService, type Socket, type WebSocketData } from '@asenajs/asena/web-socket';
import { RedisTransport } from '@asenajs/asena-redis';
import type { Server } from 'bun';

type Ctx = AsenaContext<any, any>;
type Component = new (...args: any[]) => unknown;

export const POD_PATH = '/ws/pods';
export const POD_SOCKET = 'PodSocket';

interface Command {
  type: 'join' | 'say';
  room: string;
  message?: string;
}

export interface ProbedTransportOptions {
  url: string;
  channel: string;
  latencyMs?: number;
}

export class ProbedRedisTransport extends RedisTransport {
  public initCalled = false;
  public initSettled = false;
  public readonly settled: Promise<void>;

  readonly #latencyMs: number;
  #settle!: () => void;
  #defused = false;

  public constructor({ url, channel, latencyMs = 0 }: ProbedTransportOptions) {
    super({ url, autoReconnect: false, maxRetries: 0, connectionTimeout: 1000 }, { channel });
    this.#latencyMs = latencyMs;
    this.settled = new Promise((resolve) => (this.#settle = resolve));
  }

  public override async init(server: Server<WebSocketData>): Promise<void> {
    this.initCalled = true;

    try {
      await new Promise<void>((resolve) => setTimeout(resolve, this.#latencyMs));
      await super.init(server);
    } catch (error) {
      if (!this.#defused) throw error;
    } finally {
      this.initSettled = true;
      this.#settle();
    }
  }

  // bun test fails the running test on any unhandled rejection, so a still-pending failing init is swallowed instead
  public defuse(): void {
    this.#defused = true;
  }
}

export function podComponents(transport: RedisTransport): Component[] {
  @WebSocket(POD_PATH)
  class PodSocket extends AsenaWebSocketService {
    protected onOpen(ws: Socket) {
      ws.send(JSON.stringify({ type: 'connected', socketId: ws.id }));
    }

    protected onMessage(ws: Socket, message: string | Buffer) {
      const command = JSON.parse(String(message)) as Command;

      if (command.type === 'join') {
        ws.subscribe(command.room);
        ws.send(JSON.stringify({ type: 'joined', room: command.room }));
      } else {
        ws.publish(command.room, JSON.stringify({ type: 'said', message: command.message }));
      }
    }
  }

  @Service('PodService')
  class PodService {
    @Inject(ulak(POD_PATH))
    private pods!: Ulak.NameSpace<typeof POD_PATH>;

    public broadcast(data: object) {
      return this.pods.broadcast(data);
    }

    public toRoom(room: string, data: object) {
      return this.pods.to(room, data);
    }

    public toSocket(socketId: string, data: object) {
      return this.pods.toSocket(socketId, data);
    }

    public count(): number {
      return this.pods.getSocketCount();
    }
  }

  @Controller('/pods')
  class PodController {
    @Inject('PodService')
    private pods!: PodService;

    @Post('/broadcast')
    public async broadcast(context: Ctx) {
      await this.pods.broadcast(await context.getBody());

      return context.send({ ok: true });
    }

    @Post('/room/:room')
    public async room(context: Ctx) {
      await this.pods.toRoom(context.getParam('room'), await context.getBody());

      return context.send({ ok: true });
    }

    @Post('/socket/:socketId')
    public async socket(context: Ctx) {
      await this.pods.toSocket(context.getParam('socketId'), await context.getBody());

      return context.send({ ok: true });
    }

    @Get('/count')
    public count(context: Ctx) {
      return context.send({ count: this.pods.count() });
    }
  }

  @Config()
  class PodConfig implements AsenaConfig {
    public transport() {
      return transport;
    }
  }

  return [PodSocket, PodService, PodController, PodConfig];
}
