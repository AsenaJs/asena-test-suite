import { SpanKind } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { waitFor } from '@asenajs/adapter-conformance/helpers';
import type { Telemetry } from './otel.ts';

export function serverSpans(telemetry: Telemetry): ReadableSpan[] {
  return telemetry.spans().filter((span) => span.kind === SpanKind.SERVER);
}

export function serverSpanFor(telemetry: Telemetry, path: string): ReadableSpan | undefined {
  return serverSpans(telemetry).find((span) => span.attributes['url.path'] === path);
}

export function internalSpan(telemetry: Telemetry, name: string): ReadableSpan | undefined {
  return telemetry.spans().find((span) => span.kind === SpanKind.INTERNAL && span.name === name);
}

export function parentOf(span: ReadableSpan | undefined): string | undefined {
  return span?.parentSpanContext?.spanId;
}

export async function settle<T>(telemetry: Telemetry, probe: () => T, label: string): Promise<NonNullable<T>> {
  return waitFor(
    async () => {
      await telemetry.flush();

      return probe();
    },
    { timeout: 3000, label },
  );
}
