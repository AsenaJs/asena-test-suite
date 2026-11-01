import { type AsenaContext, HttpException } from '@asenajs/asena/adapter';
import { Config, Controller, MessageController, Service } from '@asenajs/asena/decorators';
import { Get, Post } from '@asenajs/asena/decorators/http';
import { Inject } from '@asenajs/asena/decorators/ioc';
import { ICoreServiceNames } from '@asenajs/asena/ioc/types';
import type { Ulak } from '@asenajs/asena/messaging';
import { InMemoryTransport, type MessageContext, MessagePattern } from '@asenajs/asena/microservice';
import type { AsenaConfig } from '@asenajs/asena/server/config';
import { Otel, OtelTracingMiddleware, OtelTracingPostProcessor, otelMessaging } from '@asenajs/asena-otel';
import { trace } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { z } from 'zod';

type Ctx = AsenaContext<any, any>;
type Component = new (...args: any[]) => unknown;
type DefineContext = (schemas: object) => new (...args: any[]) => unknown;

export const MESSAGE_PATTERN = 'suite.trace.echo';

export interface MetricPoint {
  attributes: Record<string, unknown>;
  value: any;
}

export interface Telemetry {
  readonly spanExporter: InMemorySpanExporter;
  readonly metricExporter: InMemoryMetricExporter;
  readonly consumed: { traceId: string; traceparent?: string }[];
  flush(): Promise<void>;
  spans(): ReadableSpan[];
  points(metric: string): MetricPoint[];
  reset(): Promise<void>;
}

export interface OtelFixture {
  components: Component[];
  telemetry: Telemetry;
}

export interface OtelFixtureOptions {
  ignoreRoutes?: string[];
  define?: DefineContext;
  extra?: Component[];
}

export function telemetryFixture(options: OtelFixtureOptions = {}): { otel: Component; telemetry: Telemetry } {
  const spanExporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const metricReader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60_000 });
  const holder: { processor?: OtelTracingPostProcessor } = {};

  @Otel({
    serviceName: 'asena-suite',
    traceExporter: spanExporter,
    metricReader,
    autoTrace: { services: true, controllers: true },
    ignoreRoutes: options.ignoreRoutes,
  })
  class SuiteOtel extends OtelTracingPostProcessor {
    public constructor() {
      super();
      holder.processor = this;
    }
  }

  const flush = async () => {
    if (!holder.processor) throw new Error('the Otel post processor was not constructed');

    await holder.processor.forceFlush();
  };

  const telemetry: Telemetry = {
    spanExporter,
    metricExporter,
    consumed: [],
    flush,
    spans: () => spanExporter.getFinishedSpans(),
    points(metric) {
      return metricExporter
        .getMetrics()
        .flatMap((resource: ResourceMetrics) => resource.scopeMetrics)
        .flatMap((scope) => scope.metrics)
        .filter((entry) => entry.descriptor.name === metric)
        .flatMap((entry) => entry.dataPoints.map((point) => ({ attributes: point.attributes, value: point.value })));
    },
    async reset() {
      await flush();
      spanExporter.reset();
      metricExporter.reset();
      telemetry.consumed.length = 0;
    },
  };

  return { otel: SuiteOtel, telemetry };
}

export function otelFixture(options: OtelFixtureOptions = {}): OtelFixture {
  const { otel, telemetry } = telemetryFixture(options);

  @Service('TraceGreetingService')
  class TraceGreetingService {
    public greet(id: string) {
      return { id, greeting: `hello ${id}` };
    }
  }

  @MessageController()
  class TraceEchoConsumer {
    @MessagePattern(MESSAGE_PATTERN)
    public echo(data: { value: string }, context: MessageContext) {
      const traceId = trace.getActiveSpan()?.spanContext().traceId ?? '';

      telemetry.consumed.push({ traceId, traceparent: context.headers.traceparent });

      return { echoed: data.value };
    }
  }

  @Controller('/users')
  class TraceUserController {
    @Inject('TraceGreetingService')
    private greetings!: TraceGreetingService;

    @Get('/:id')
    public byId(context: Ctx) {
      return context.send(this.greetings.greet(context.getParam('id')));
    }

    @Post('/')
    public create(context: Ctx) {
      return context.send({ created: true }, 201);
    }
  }

  @Controller('/trace')
  class TraceMiscController {
    @Inject(ICoreServiceNames.__ULAK__)
    private ulak!: Ulak;

    @Get('/forbidden')
    public forbidden(): never {
      throw new HttpException(403, { error: 'forbidden' });
    }

    @Post('/message')
    public async message(context: Ctx) {
      return context.send(await this.ulak.send(MESSAGE_PATTERN, { value: 'traced' }));
    }
  }

  @Controller('/health')
  class TraceHealthController {
    @Get('/')
    public health(context: Ctx) {
      return context.send({ status: 'ok' });
    }
  }

  @Config()
  class TraceConfig implements AsenaConfig {
    public globalMiddlewares() {
      return [OtelTracingMiddleware];
    }

    public transport() {
      return { microservice: new InMemoryTransport(), interceptors: [otelMessaging()] };
    }

    public onError(error: Error, context: Ctx) {
      if (error instanceof HttpException) return context.send(error.body, error.status);

      return context.send({ error: 'internal' }, 500);
    }
  }

  const components: Component[] = [
    otel,
    OtelTracingMiddleware,
    TraceGreetingService,
    TraceEchoConsumer,
    TraceUserController,
    TraceMiscController,
    TraceHealthController,
    TraceConfig,
    ...(options.extra ?? []),
  ];

  if (options.define) components.push(validatedController(options.define));

  return { components, telemetry };
}

function validatedController(define: DefineContext): Component {
  const Validated = define({ body: z.object({ name: z.string().min(1) }) }) as new (...args: any[]) => Ctx & {
    readonly input: { body: { name: string } };
  };

  class ValidatedContext extends Validated {}

  @Controller('/validated')
  class TraceValidatedController {
    @Post('/')
    public create(context: ValidatedContext) {
      return context.send(context.input.body, 201);
    }
  }

  return TraceValidatedController;
}
