import type { AsenaContext, AsenaNextHandler } from '@asenajs/asena/adapter';
import { Config, Controller, Middleware, Service, WebSocket } from '@asenajs/asena/decorators';
import { Get, Post } from '@asenajs/asena/decorators/http';
import { Inject } from '@asenajs/asena/decorators/ioc';
import { type Ulak, ulak } from '@asenajs/asena/messaging';
import { AsenaMiddlewareService } from '@asenajs/asena/middleware';
import type { AsenaConfig } from '@asenajs/asena/server/config';
import {
  AsenaWebSocketService,
  type Socket,
  type WebSocketData,
  type WebSocketTransport,
  type WSOptions,
} from '@asenajs/asena/web-socket';
import type { Server } from 'bun';

type Component = new (...args: any[]) => unknown;

export const ECHO_PATH = '/ws/echo';
export const INHERITED_PATH = '/ws/inherited';
export const ECHO_SOCKET = 'ConformanceEchoSocket';
export const INHERITED_SOCKET = 'ConformanceInheritedSocket';
export const FLOOD_FRAME_BYTES = 1 << 20;
export const FLOOD_MAX_FRAMES = 64;
export const UPGRADE_VALUES = { tenant: 'conformance', level: 3 };

export type HookName = 'onOpen' | 'onMessage' | 'onClose' | 'onDrain' | 'onPing' | 'onPong' | 'flood';

export interface HookRecord {
  hook: HookName;
  socketId: string;
  at: number;
  payload?: unknown;
}

export interface FloodResult {
  sent: number;
  statuses: number[];
}

@Service('HookProbe')
export class HookProbe {
  public readonly records: HookRecord[] = [];

  public record(hook: HookName, socketId: string, payload?: unknown): void {
    this.records.push({ hook, socketId, at: performance.now(), ...(payload !== undefined && { payload }) });
  }

  public of(hook: HookName, socketId?: string): HookRecord[] {
    return this.records.filter(
      (entry) => entry.hook === hook && (socketId === undefined || entry.socketId === socketId),
    );
  }

  public count(hook: HookName, socketId?: string): number {
    return this.of(hook, socketId).length;
  }
}

export interface DeferredTransportOptions {
  delayMs?: number;
  fail?: boolean;
}

export const TRANSPORT_INIT_FAILURE = 'conformance transport init failed';

export class DeferredTransport implements WebSocketTransport {
  public initCalled = false;
  public initCompleted = false;
  public initSettled = false;
  public destroyCalls = 0;
  public readonly published: { topic: string; data: string | ArrayBuffer | ArrayBufferView }[] = [];
  public readonly publishedRemote: { topic: string; data: string | ArrayBuffer | ArrayBufferView }[] = [];
  public readonly settled: Promise<void>;

  readonly #delayMs: number;
  readonly #fail: boolean;
  #server: Server<WebSocketData> | undefined;
  #settle!: () => void;
  #defused = false;

  public constructor({ delayMs = 50, fail = false }: DeferredTransportOptions = {}) {
    this.#delayMs = delayMs;
    this.#fail = fail;
    this.settled = new Promise((resolve) => (this.#settle = resolve));
  }

  public async init(server: Server<WebSocketData>): Promise<void> {
    this.initCalled = true;

    try {
      await new Promise<void>((resolve) => setTimeout(resolve, this.#delayMs));

      if (this.#fail && !this.#defused) throw new Error(TRANSPORT_INIT_FAILURE);

      this.#server = server;
      this.initCompleted = true;
    } finally {
      this.initSettled = true;
      this.#settle();
    }
  }

  // bun test fails the running test on any unhandled rejection, whatever process listeners exist,
  // so a still-pending failing init is turned into a success instead of escaping.
  public defuse(): void {
    this.#defused = true;
  }

  public publish(topic: string, data: string | ArrayBuffer | ArrayBufferView): void {
    this.published.push({ topic, data });
    this.#server?.publish(topic, data as string | ArrayBuffer);
  }

  public publishRemote(topic: string, data: string | ArrayBuffer | ArrayBufferView): void {
    this.publishedRemote.push({ topic, data });
  }

  public async destroy(): Promise<void> {
    this.destroyCalls++;
  }
}

export interface WsFixtureOptions {
  wsOptions?: WSOptions;
  transport?: WebSocketTransport;
  upgrade?: 'reject' | 'values';
  ulak?: boolean;
  inherited?: boolean;
}

export interface WsFixture {
  components: Component[];
  upgradeCalls: { count: number };
}

type Values = Record<string, unknown>;

interface Command {
  type: string;
  room?: string;
  data?: unknown;
}

function parseCommand(text: string): Command | undefined {
  if (!text.startsWith('{')) return undefined;

  try {
    const value = JSON.parse(text) as Command;

    return typeof value?.type === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function toArrayBuffer(message: Buffer): ArrayBuffer {
  return message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength) as ArrayBuffer;
}

export function wsFixture(options: WsFixtureOptions = {}): WsFixture {
  const upgradeCalls = { count: 0 };
  const components: Component[] = [];

  @Middleware()
  class ConformanceRejectUpgrade extends AsenaMiddlewareService {
    public handle(): boolean {
      upgradeCalls.count++;

      return false;
    }
  }

  @Middleware()
  class ConformanceUpgradeValues extends AsenaMiddlewareService {
    public async handle(context: AsenaContext<any, any>, next: AsenaNextHandler) {
      upgradeCalls.count++;
      context.setWebSocketValue({ ...UPGRADE_VALUES });
      await next();
    }
  }

  const middlewares =
    options.upgrade === 'reject'
      ? [ConformanceRejectUpgrade]
      : options.upgrade === 'values'
        ? [ConformanceUpgradeValues]
        : [];

  @WebSocket({ path: ECHO_PATH, name: ECHO_SOCKET, middlewares })
  class ConformanceEchoSocket extends AsenaWebSocketService<Values> {
    @Inject(HookProbe)
    private probe!: HookProbe;

    protected onOpen(ws: Socket<Values>) {
      this.probe.record('onOpen', ws.id, ws.data.values);
    }

    protected onMessage(ws: Socket<Values>, message: Buffer | string) {
      if (typeof message !== 'string') {
        this.probe.record('onMessage', ws.id, { binary: message.byteLength });
        ws.sendBinary(toArrayBuffer(message));

        return;
      }

      this.probe.record('onMessage', ws.id, message);

      if (message === 'close-me') {
        ws.close(4001, 'policy reason');

        return;
      }

      if (message === 'flood') {
        this.flood(ws);

        return;
      }

      const command = parseCommand(message);

      switch (command?.type) {
        case 'whoami':
          ws.send(JSON.stringify({ type: 'whoami', id: ws.id }));
          break;
        case 'values':
          ws.send(JSON.stringify({ type: 'values', values: ws.data.values }));
          break;
        case 'join':
          ws.subscribe(command.room!);
          ws.send(JSON.stringify({ type: 'joined', room: command.room }));
          break;
        case 'leave':
          ws.unsubscribe(command.room!);
          ws.send(JSON.stringify({ type: 'left', room: command.room }));
          break;
        case 'to':
          this.to(command.room!, { type: 'room', room: command.room, data: command.data });
          break;
        case 'publish':
          ws.publish(command.room!, JSON.stringify({ type: 'published', room: command.room, data: command.data }));
          break;
        default:
          ws.send(JSON.stringify({ echo: message, from: ws.id }));
      }
    }

    protected onClose(ws: Socket<Values>, code: number, reason: string) {
      this.probe.record('onClose', ws.id, { code, reason });
    }

    protected onDrain(ws: Socket<Values>) {
      this.probe.record('onDrain', ws.id);
    }

    protected onPing(ws: Socket<Values>, data: Buffer) {
      this.probe.record('onPing', ws.id, data.toString());
    }

    protected onPong(ws: Socket<Values>, data: Buffer) {
      this.probe.record('onPong', ws.id, data.byteLength);
    }

    private flood(ws: Socket<Values>): void {
      const frame = new Uint8Array(FLOOD_FRAME_BYTES);
      const statuses: number[] = [];

      while (statuses.length < FLOOD_MAX_FRAMES) {
        const status = ws.sendBinary(frame.buffer);

        statuses.push(status);

        if (status === -1) break;
      }

      this.probe.record('flood', ws.id, { sent: statuses.length, statuses } satisfies FloodResult);
    }
  }

  components.push(ConformanceEchoSocket, HookProbe, ...middlewares);

  if (options.inherited) {
    abstract class ConformanceEchoBase extends AsenaWebSocketService<Values> {
      protected onMessage(ws: Socket<Values>, message: Buffer | string) {
        const text = typeof message === 'string' ? message : message.toString();

        ws.send(JSON.stringify({ echo: text, from: this.constructor.name }));
      }
    }

    @WebSocket({ path: INHERITED_PATH, name: INHERITED_SOCKET })
    class ConformanceInheritedSocket extends ConformanceEchoBase {}

    components.push(ConformanceInheritedSocket);
  }

  if (options.ulak) {
    @Service('ConformanceNotifier')
    class ConformanceNotifier {
      @Inject(ulak(ECHO_PATH))
      private echo!: Ulak.NameSpace<typeof ECHO_PATH>;

      public broadcast(data: unknown): Promise<void> {
        return this.echo.broadcast(data);
      }

      public toSocket(socketId: string, data: unknown): Promise<void> {
        return this.echo.toSocket(socketId, data);
      }

      public count(): number {
        return this.echo.getSocketCount();
      }
    }

    @Controller('/ws-ulak')
    class ConformanceNotifierController {
      @Inject(ConformanceNotifier)
      private notifier!: ConformanceNotifier;

      @Post('/broadcast')
      public async broadcast(context: AsenaContext<any, any>) {
        await this.notifier.broadcast(await context.getBody<unknown>());

        return context.send({ ok: true });
      }

      @Post('/to-socket')
      public async toSocket(context: AsenaContext<any, any>) {
        const { socketId, data } = await context.getBody<{ socketId: string; data: unknown }>();

        await this.notifier.toSocket(socketId, data);

        return context.send({ ok: true });
      }

      @Get('/count')
      public count(context: AsenaContext<any, any>) {
        return context.send({ count: this.notifier.count() });
      }
    }

    components.push(ConformanceNotifierController, ConformanceNotifier);
  }

  const { wsOptions, transport } = options;

  if (transport) {
    @Config()
    class ConformanceWsTransportConfig implements AsenaConfig {
      public serveOptions() {
        return { wsOptions: wsOptions ?? {} };
      }

      public transport() {
        return transport!;
      }
    }

    components.push(ConformanceWsTransportConfig);
  } else if (wsOptions) {
    @Config()
    class ConformanceWsConfig implements AsenaConfig {
      public serveOptions() {
        return { wsOptions };
      }
    }

    components.push(ConformanceWsConfig);
  }

  return { components, upgradeCalls };
}
