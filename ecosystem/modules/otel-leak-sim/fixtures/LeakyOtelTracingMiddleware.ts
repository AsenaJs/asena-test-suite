// Positive-control fixture: the pre-fix middleware from asena-otel `e508e9e` lib/middleware/OtelTracingMiddleware.ts.
// It records `url.path` (the raw path for unmatched routes) as a metric attribute - the cardinality leak.
import type { AsenaContext } from '@asenajs/asena/adapter';
import { Middleware } from '@asenajs/asena/decorators';
import { PostConstruct } from '@asenajs/asena/decorators/ioc';
import { AsenaMiddlewareService } from '@asenajs/asena/middleware';
import { isRouteIgnored } from '@asenajs/asena-otel';
import {
  type Counter,
  type Histogram,
  type Meter,
  metrics,
  context as otelContext,
  propagation,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from '@opentelemetry/api';
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
} from '@opentelemetry/semantic-conventions';

const LIBRARY_NAME = '@asenajs/asena-otel';

@Middleware()
export class LeakyOtelTracingMiddleware extends AsenaMiddlewareService {
  private tracer!: Tracer;

  private meter!: Meter;

  private requestCounter!: Counter;

  private requestDuration!: Histogram;

  @PostConstruct()
  public onInit() {
    this.tracer = trace.getTracer(LIBRARY_NAME);
    this.meter = metrics.getMeter(LIBRARY_NAME);
    this.requestCounter = this.meter.createCounter('http.server.request.count', {
      description: 'Total number of HTTP requests',
    });
    this.requestDuration = this.meter.createHistogram('http.server.request.duration', {
      description: 'HTTP request duration in milliseconds',
      unit: 'ms',
    });
  }

  public async handle(ctx: AsenaContext<any, any>, next: () => Promise<void>): Promise<void> {
    const startTime = performance.now();
    const method = ctx.req?.method ?? 'UNKNOWN';
    const url = ctx.req?.url ? new URL(ctx.req.url).pathname : '/';

    if (isRouteIgnored(url)) {
      await next();

      return;
    }

    const parentContext = propagation.extract(otelContext.active(), ctx.headers);

    await this.tracer.startActiveSpan(`${method} ${url}`, { kind: SpanKind.SERVER }, parentContext, async (span) => {
      span.setAttribute(ATTR_HTTP_REQUEST_METHOD, method);
      span.setAttribute(ATTR_URL_PATH, url);

      try {
        await next();

        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
        span.recordException(error as Error);

        throw error;
      } finally {
        const duration = performance.now() - startTime;
        const raw = ctx.routePattern;
        const trimmed = raw && raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
        const routePattern = trimmed && trimmed !== '/*' ? trimmed : undefined;

        if (routePattern) {
          span.updateName(`${method} ${routePattern}`);
          span.setAttribute(ATTR_HTTP_ROUTE, routePattern);
        }

        const attributes: Record<string, string | number> = {
          [ATTR_HTTP_REQUEST_METHOD]: method,
          [ATTR_URL_PATH]: routePattern ?? url,
        };
        const statusCode = (ctx.res as { status?: number } | undefined)?.status;

        if (statusCode !== undefined) {
          span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode);
          attributes[ATTR_HTTP_RESPONSE_STATUS_CODE] = statusCode;
        }

        this.requestCounter.add(1, attributes);
        this.requestDuration.record(duration, attributes);
        span.end();
      }
    });
  }
}
