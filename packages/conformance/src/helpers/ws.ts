export type WsMessage = string | Uint8Array;

export interface OpenWsOptions {
  protocols?: string | string[];
  headers?: Headers | Record<string, string> | [string, string][];
  timeout?: number;
}

export interface WsCloseInfo {
  code: number;
  reason: string;
}

export interface NextMessageOptions {
  timeout?: number;
}

interface Waiter {
  resolve: (message: WsMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type ClientWebSocket = Bun.WebSocket;

const ClientWebSocket = WebSocket as unknown as new (
  url: string | URL,
  options?: Bun.WebSocketOptions,
) => ClientWebSocket;

const decoder = new TextDecoder();

export class TestSocket {
  pings = 0;
  pongs = 0;
  readonly closed: Promise<WsCloseInfo>;

  readonly #ws: ClientWebSocket;
  readonly #queue: WsMessage[] = [];
  readonly #waiters: Waiter[] = [];
  readonly #arrivals = new Set<() => void>();
  #closeInfo: WsCloseInfo | undefined;

  constructor(ws: ClientWebSocket) {
    this.#ws = ws;
    ws.binaryType = 'arraybuffer';

    let resolveClosed!: (info: WsCloseInfo) => void;

    this.closed = new Promise((resolve) => (resolveClosed = resolve));

    ws.addEventListener('message', (event) => this.#push(toMessage(event.data)));
    ws.addEventListener('ping', () => this.pings++);
    ws.addEventListener('pong', () => this.pongs++);
    ws.addEventListener('close', (event) => {
      const info = { code: event.code, reason: event.reason };

      this.#closeInfo = info;

      for (const waiter of this.#waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`socket closed (${info.code} ${info.reason}) before a message arrived`));
      }

      for (const notify of this.#arrivals) notify();

      resolveClosed(info);
    });
  }

  get raw(): ClientWebSocket {
    return this.#ws;
  }

  get protocol(): string {
    return this.#ws.protocol;
  }

  get readyState(): number {
    return this.#ws.readyState;
  }

  get buffered(): readonly WsMessage[] {
    return this.#queue;
  }

  nextMessage({ timeout = 2000 }: NextMessageOptions = {}): Promise<WsMessage> {
    const queued = this.#queue.shift();

    if (queued !== undefined) return Promise.resolve(queued);

    if (this.#closeInfo) {
      const { code, reason } = this.#closeInfo;

      return Promise.reject(new Error(`socket closed (${code} ${reason}) before a message arrived`));
    }

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
          reject(new Error(`no message within ${timeout}ms`));
        }, timeout),
      };

      this.#waiters.push(waiter);
    });
  }

  async nextText(options?: NextMessageOptions): Promise<string> {
    const message = await this.nextMessage(options);

    return typeof message === 'string' ? message : decoder.decode(message);
  }

  async nextJson<T = unknown>(options?: NextMessageOptions): Promise<T> {
    return JSON.parse(await this.nextText(options)) as T;
  }

  async expectNoMessage(ms: number): Promise<void> {
    if (this.#queue.length === 0) {
      await new Promise<void>((resolve) => {
        const notify = (): void => {
          clearTimeout(timer);
          this.#arrivals.delete(notify);
          resolve();
        };
        const timer = setTimeout(notify, ms);

        this.#arrivals.add(notify);
      });
    }

    const message = this.#queue[0];

    if (message !== undefined) {
      throw new Error(`expected no message within ${ms}ms, received ${describe(message)}`);
    }
  }

  send(data: string | Uint8Array): void {
    this.#ws.send(data);
  }

  json(value: unknown): void {
    this.#ws.send(JSON.stringify(value));
  }

  ping(data?: string | Uint8Array): void {
    this.#ws.ping(data);
  }

  close(code?: number, reason?: string): Promise<WsCloseInfo> {
    if (!this.#closeInfo && this.#ws.readyState !== WebSocket.CLOSED) this.#ws.close(code, reason);

    return this.closed;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#closeInfo) return;

    this.#ws.close();
    await Promise.race([this.closed, Bun.sleep(1000)]);

    if (!this.#closeInfo) this.#ws.terminate();
  }

  #push(message: WsMessage): void {
    const waiter = this.#waiters.shift();

    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      this.#queue.push(message);
    }

    for (const notify of this.#arrivals) notify();
  }
}

function toMessage(data: unknown): WsMessage {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();

  return String(data);
}

function describe(message: WsMessage): string {
  return typeof message === 'string' ? JSON.stringify(message) : `${message.byteLength} binary byte(s)`;
}

export function openWs(
  url: string | URL,
  { protocols, headers, timeout = 5000 }: OpenWsOptions = {},
): Promise<TestSocket> {
  const ws = new ClientWebSocket(url, { ...(protocols !== undefined && { protocols }), ...(headers && { headers }) });
  const socket = new TestSocket(ws);

  return new Promise<TestSocket>((resolve, reject) => {
    let failure: string | undefined;

    const timer = setTimeout(() => {
      cleanup();
      ws.terminate();
      reject(new Error(`openWs: ${String(url)} did not open within ${timeout}ms`));
    }, timeout);

    const onOpen = (): void => {
      cleanup();
      resolve(socket);
    };
    const onError = (event: Event): void => {
      failure = (event as ErrorEvent).message || failure;
    };
    const onClose = (event: CloseEvent): void => {
      cleanup();
      reject(
        new Error(
          `openWs: ${String(url)} closed before open (${event.code}${event.reason ? ` ${event.reason}` : ''})` +
            (failure ? `: ${failure}` : ''),
        ),
      );
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
    };

    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);
  });
}
