import type { RequestSchema, SchemaIssue, SchemaResult } from '@asenajs/asena/adapter';

export type Schema<T> = RequestSchema<unknown, T>;

type Path = readonly PropertyKey[];

interface Outcome<T> {
  value?: T;
  issues: SchemaIssue[];
}

type Check<T> = (value: unknown, path: Path) => Outcome<T> | Promise<Outcome<T>>;

const failure = (message: string, path: Path): Outcome<never> => ({ issues: [{ message, path: [...path] }] });

const CHECK = Symbol('asena-suite.check');

interface Checked<T> extends Schema<T> {
  readonly [CHECK]: Check<T>;
}

function make<T>(check: Check<T>, onValidate?: (value: unknown) => void): Checked<T> {
  return {
    [CHECK]: check,
    '~standard': {
      version: 1,
      vendor: 'asena-suite',
      validate: async (value: unknown): Promise<SchemaResult<T>> => {
        onValidate?.(value);
        const outcome = await check(value, []);

        return outcome.issues.length > 0 ? { issues: outcome.issues } : { value: outcome.value as T };
      },
    },
  };
}

export function string(options: { min?: number; trim?: boolean } = {}): Checked<string> {
  return make<string>((value, path) => {
    if (typeof value !== 'string') return failure('Expected a string', path);

    const out = options.trim ? value.trim() : value;

    if (options.min !== undefined && out.length < options.min) {
      return failure(`Expected at least ${options.min} characters`, path);
    }

    return { value: out, issues: [] };
  });
}

export function number(): Checked<number> {
  return make<number>((value, path) =>
    typeof value === 'number' && Number.isFinite(value) ? { value, issues: [] } : failure('Expected a number', path),
  );
}

export function coerceNumber(): Checked<number> {
  return make<number>((value, path) => {
    const out = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;

    return typeof out === 'number' && Number.isFinite(out)
      ? { value: out, issues: [] }
      : failure('Expected a number', path);
  });
}

export function optional<T>(inner: Checked<T>): Checked<T | undefined> {
  return make((value, path) => (value === undefined ? { value: undefined, issues: [] } : inner[CHECK](value, path)));
}

export function object<S extends Record<string, Checked<unknown>>>(
  shape: S,
): Checked<{ [K in keyof S]: S[K] extends Checked<infer T> ? T : never }> {
  return make(async (value, path) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return failure('Expected an object', path);

    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const issues: SchemaIssue[] = [];

    for (const key of Object.keys(shape)) {
      const result = await shape[key][CHECK](source[key], [...path, key]);

      if (result.issues.length > 0) issues.push(...result.issues);
      else if (result.value !== undefined) out[key] = result.value;
    }

    return issues.length > 0 ? { issues } : { value: out as never, issues: [] };
  });
}

export function traced<T>(label: string, order: string[], inner: Checked<T>): Checked<T> {
  return make(
    (value, path) => inner[CHECK](value, path),
    () => order.push(label),
  );
}
