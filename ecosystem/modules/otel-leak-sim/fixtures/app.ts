import { type AsenaContext, HttpException } from '@asenajs/asena/adapter';
import { Config, Controller, Service } from '@asenajs/asena/decorators';
import { Delete, Get, Post, Put } from '@asenajs/asena/decorators/http';
import { Inject } from '@asenajs/asena/decorators/ioc';
import type { AsenaConfig } from '@asenajs/asena/server/config';
import { Otel, OtelTracingMiddleware, OtelTracingPostProcessor } from '@asenajs/asena-otel';
import {
  AggregationTemporality,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { LeakyMetricsOtelPostProcessor } from './LeakyMetricsOtelPostProcessor.ts';
import { LeakyOtelTracingMiddleware } from './LeakyOtelTracingMiddleware.ts';

type Ctx = AsenaContext<any, any>;
type Component = new (...args: any[]) => unknown;
type ExportCallback = Parameters<SpanExporter['export']>[1];

const SUCCESS = { code: 0 } as Parameters<ExportCallback>[0];

class DiscardingSpanExporter implements SpanExporter {
  public export(_spans: unknown[], resultCallback: ExportCallback): void {
    resultCallback(SUCCESS);
  }

  public shutdown(): Promise<void> {
    return Promise.resolve();
  }

  public forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

// Cumulative like production OTLP exporters: with delta temporality the SDK drops accumulations after each collect and
// the leaky control would falsely plateau.
class DiscardingCumulativeMetricExporter implements PushMetricExporter {
  public export(_metrics: unknown, resultCallback: ExportCallback): void {
    resultCallback(SUCCESS);
  }

  public forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  public shutdown(): Promise<void> {
    return Promise.resolve();
  }

  public selectAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.CUMULATIVE;
  }
}

// The largest 32-bit interval: the periodic export never fires, every collection is a manual `collect()`.
export const leakSimMetricReader = new PeriodicExportingMetricReader({
  exporter: new DiscardingCumulativeMetricExporter(),
  exportIntervalMillis: 0x7fffffff,
});

interface User {
  id: string;
  name: string;
  email: string;
}

@Service('LeakSimUserService')
class LeakSimUserService {
  private users = new Map<string, User>();

  public all(): User[] {
    return [...this.users.values()].slice(0, 20);
  }

  public get(id: string): User | undefined {
    return this.users.get(id);
  }

  public create(name: string, email: string): User {
    const user = { id: crypto.randomUUID(), name, email };

    this.users.set(user.id, user);

    return user;
  }

  public update(id: string, name: string): User | undefined {
    const user = this.users.get(id);

    if (user) user.name = name;

    return user;
  }

  public delete(id: string): boolean {
    return this.users.delete(id);
  }
}

@Controller('/health')
class LeakSimHealthController {
  @Get('/')
  public health(context: Ctx) {
    return context.send({ status: 'ok' });
  }
}

@Controller('/api/users')
class LeakSimUserController {
  @Inject('LeakSimUserService')
  private users!: LeakSimUserService;

  @Get('/')
  public list(context: Ctx) {
    return context.send(this.users.all());
  }

  @Get('/:id')
  public byId(context: Ctx) {
    const user = this.users.get(context.getParam('id'));

    if (!user) throw new HttpException(404, { error: 'User not found' });

    return context.send(user);
  }

  @Post('/')
  public async create(context: Ctx) {
    const body = await context.getBody<{ name?: unknown; email?: unknown }>();
    const valid =
      typeof body?.name === 'string' && body.name !== '' && typeof body.email === 'string' && body.email.includes('@');

    if (!valid) throw new HttpException(400, { error: 'Validation failed' });

    return context.send(this.users.create(body.name as string, body.email as string), 201);
  }

  @Put('/:id')
  public async update(context: Ctx) {
    const body = await context.getBody<{ name?: string }>();
    const user = this.users.update(context.getParam('id'), String(body?.name ?? ''));

    if (!user) throw new HttpException(404, { error: 'User not found' });

    return context.send(user);
  }

  @Delete('/:id')
  public remove(context: Ctx) {
    if (!this.users.delete(context.getParam('id'))) throw new HttpException(404, { error: 'User not found' });

    return context.send({ deleted: true });
  }
}

function onError(error: Error, context: Ctx) {
  if (error instanceof HttpException) return context.send(error.body, error.status);

  return context.send({ error: 'Internal Server Error' }, 500);
}

@Otel({
  serviceName: 'leak-sim-fixed',
  traceExporter: new DiscardingSpanExporter(),
  metricReader: leakSimMetricReader,
  autoTrace: { services: true, controllers: true },
})
class LeakSimOtelFixed extends OtelTracingPostProcessor {}

@Otel({
  serviceName: 'leak-sim-leaky',
  traceExporter: new DiscardingSpanExporter(),
  metricReader: leakSimMetricReader,
  autoTrace: { services: true, controllers: true },
})
class LeakSimOtelLeaky extends LeakyMetricsOtelPostProcessor {}

@Config()
class LeakSimFixedConfig implements AsenaConfig {
  public globalMiddlewares() {
    return [OtelTracingMiddleware];
  }

  public onError(error: Error, context: Ctx) {
    return onError(error, context);
  }
}

@Config()
class LeakSimLeakyConfig implements AsenaConfig {
  public globalMiddlewares() {
    return [LeakyOtelTracingMiddleware];
  }

  public onError(error: Error, context: Ctx) {
    return onError(error, context);
  }
}

const CORE: Component[] = [LeakSimHealthController, LeakSimUserController, LeakSimUserService];

export const FixedComponents: Component[] = [LeakSimFixedConfig, ...CORE, LeakSimOtelFixed, OtelTracingMiddleware];

export const LeakyComponents: Component[] = [LeakSimLeakyConfig, ...CORE, LeakSimOtelLeaky, LeakyOtelTracingMiddleware];
