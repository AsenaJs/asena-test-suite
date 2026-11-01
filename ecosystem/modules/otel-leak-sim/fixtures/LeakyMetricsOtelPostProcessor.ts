// Positive-control fixture: the pre-fix metrics setup (no `http.server.*` allow-list view), from asena-otel `e508e9e`
// lib/postprocessor/OtelTracingPostProcessor.ts. `setupMetrics` is private, so it is replaced on the prototype.
import { OtelTracingPostProcessor } from '@asenajs/asena-otel';
import { metrics } from '@opentelemetry/api';
import type { Resource } from '@opentelemetry/resources';
import { MeterProvider, type MetricReader } from '@opentelemetry/sdk-metrics';

export class LeakyMetricsOtelPostProcessor extends OtelTracingPostProcessor {}

Object.defineProperty(LeakyMetricsOtelPostProcessor.prototype, 'setupMetrics', {
  configurable: true,
  writable: true,
  value: function setupMetrics(
    this: { meterProvider?: MeterProvider },
    resource: Resource,
    reader: MetricReader,
  ): void {
    this.meterProvider = new MeterProvider({ resource, readers: [reader] });
    metrics.setGlobalMeterProvider(this.meterProvider);
  },
});
