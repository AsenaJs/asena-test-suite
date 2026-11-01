const recordedMembers = [
  'setPort',
  'serveOptions',
  'onError',
  'onNotFound',
  'use',
  'registerRoute',
  'registerHTMLRoute',
  'registerWebsocketRoute',
  'start',
  'stop',
] as const;

export type RecordedMember = (typeof recordedMembers)[number];

export interface RecordedCall {
  member: RecordedMember;
  at: number;
}

export interface RecordCallsOptions {
  hide?: string[];
}

export interface RecordedAdapter<A extends object> {
  adapter: A;
  calls: RecordedCall[];
}

const recorded = new Set<PropertyKey>(recordedMembers);

export function recordCalls<A extends object>(adapter: A, { hide = [] }: RecordCallsOptions = {}): RecordedAdapter<A> {
  const hidden = new Set<PropertyKey>(hide);
  const calls: RecordedCall[] = [];
  const wrappers = new Map<PropertyKey, { original: unknown; wrapper: (...args: unknown[]) => unknown }>();
  let sequence = 0;

  const proxy = new Proxy(adapter, {
    get(target, prop) {
      if (hidden.has(prop)) return undefined;

      const value: unknown = Reflect.get(target, prop);

      if (!recorded.has(prop) || typeof value !== 'function') return value;

      const cached = wrappers.get(prop);

      if (cached?.original === value) return cached.wrapper;

      const wrapper = (...args: unknown[]): unknown => {
        calls.push({ member: prop as RecordedMember, at: sequence++ });

        return Reflect.apply(value as (...a: unknown[]) => unknown, target, args);
      };

      wrappers.set(prop, { original: value, wrapper });

      return wrapper;
    },
    has(target, prop) {
      if (hidden.has(prop)) return false;

      return Reflect.has(target, prop);
    },
  });

  return { adapter: proxy, calls };
}
