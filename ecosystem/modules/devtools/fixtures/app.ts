import type { AsenaContext, AsenaNextHandler, NotFoundRequest } from '@asenajs/asena/adapter';
import { Config, Controller, ExceptionHandler, Middleware, Schedule, Service } from '@asenajs/asena/decorators';
import { Get, Post } from '@asenajs/asena/decorators/http';
import { Inject, Value } from '@asenajs/asena/decorators/ioc';
import type { DevtoolsRequestLog } from '@asenajs/asena/devtools';
import { Catch, type ExceptionContext, NotFound } from '@asenajs/asena/exception';
import { AsenaMiddlewareService, type AsenaValidationService } from '@asenajs/asena/middleware';
import type { AsenaSchedule } from '@asenajs/asena/schedule';
import type { AsenaConfig } from '@asenajs/asena/server/config';
import { type ZodType, z } from 'zod';

type Ctx = AsenaContext<any, any>;

export const CLEANUP_MARKER = 'devtools-fixture: NoteCleanup ran';

/** What the `main.warnings` entry puts in front of every warning the server logs. */
export const WARNING_PREFIX = 'devtools-fixture warn: ';

/** What `GET /notes/talk/:tag` writes, in order, and to which stream. */
export const talkOutput = (tag: string): Omit<DevtoolsRequestLog, 'at'>[] => [
  { stream: 'stdout', text: `devtools-fixture: talk ${tag} arrived\n` },
  { stream: 'stderr', text: `devtools-fixture: talk ${tag} met\n` },
  { stream: 'stdout', text: `devtools-fixture: talk ${tag} answered\n` },
];

/** `GET /notes/flood/entries` logs this many lines, past the 100 entry cap. */
export const FLOOD_LINES = 120;

export const floodLine = (index: number) => `devtools-fixture: flood ${index}`;

/** `GET /notes/flood/chars` writes this many characters this many times, past the 16 KiB cap. */
export const FLOOD_CHUNK = { size: 10_000, count: 3 };

export const LATE_MARKER = {
  before: 'devtools-fixture: late before the answer',
  after: 'devtools-fixture: late after the answer',
};

let waitingTalk: (() => void) | undefined;

/** Resolves true once a second talk request reaches this point, so both are in flight together. */
function meetOtherTalk(): Promise<boolean> {
  const other = waitingTalk;

  if (other) {
    waitingTalk = undefined;
    other();

    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waitingTalk = undefined;
      resolve(false);
    }, 3000);

    waitingTalk = () => {
      clearTimeout(timer);
      resolve(true);
    };
  });
}

export class NoteMissingError extends Error {
  public constructor() {
    super('note missing');
    this.name = 'NoteMissingError';
  }
}

@Service()
export class NoteStore {
  @Value('DEVTOOLS_FIXTURE_PAGE_SIZE', { parse: Number, default: 20 })
  public pageSize!: number;

  public list(): string[] {
    return ['first', 'second'].slice(0, this.pageSize);
  }
}

@Middleware()
export class NoteAudit extends AsenaMiddlewareService {
  public async handle(_context: Ctx, next: AsenaNextHandler) {
    await next();
  }
}

@Middleware()
export class NoteLock extends AsenaMiddlewareService {
  public async handle(): Promise<boolean> {
    return false;
  }
}

@Middleware({ validator: true })
export class NoteValidator implements AsenaValidationService<ZodType> {
  public json() {
    return z.object({ title: z.string().min(1) });
  }
}

@Controller('/notes')
export class NoteController {
  @Inject(NoteStore)
  private store!: NoteStore;

  @Get('/')
  public list(context: Ctx) {
    return context.send({ notes: this.store.list() });
  }

  @Get('/missing')
  public missing(): Response {
    throw new NoteMissingError();
  }

  @Get('/broken')
  public broken(): Response {
    throw new Error('devtools-fixture: broken');
  }

  @Get({ path: '/locked', middlewares: [NoteLock] })
  public locked(context: Ctx) {
    return context.send({ unreachable: true });
  }

  @Post({ path: '/', validator: NoteValidator })
  public create(context: Ctx) {
    return context.send({ created: true }, 201);
  }

  @Get('/talk/:tag')
  public async talk(context: Ctx) {
    const tag = context.getParam('tag');
    const [arrived, met, answered] = talkOutput(tag);

    console.log(arrived.text.trimEnd());

    const overlapped = await meetOtherTalk();

    await Bun.sleep(5);
    console.error(met.text.trimEnd());
    process.stdout.write(answered.text);

    return context.send({ tag, overlapped });
  }

  @Get('/flood/:unit')
  public flood(context: Ctx) {
    if (context.getParam('unit') === 'entries') {
      for (let index = 0; index < FLOOD_LINES; index++) console.log(floodLine(index));
    } else {
      for (let index = 0; index < FLOOD_CHUNK.count; index++) process.stdout.write('x'.repeat(FLOOD_CHUNK.size));
      process.stdout.write('\n');
    }

    return context.send({ flooded: true });
  }

  @Get('/late')
  public late(context: Ctx) {
    console.log(LATE_MARKER.before);
    setTimeout(() => console.log(LATE_MARKER.after), 50);

    return context.send({ late: true });
  }
}

@Controller('/status')
export class StatusController {
  @Get('/')
  public read(context: Ctx) {
    return context.send({ ok: true });
  }
}

@ExceptionHandler()
export class NoteErrors {
  @Catch(NoteMissingError)
  public missing(_error: NoteMissingError, ctx: ExceptionContext<Ctx>) {
    if (ctx.scope !== 'http') return undefined;

    return ctx.context.send({ error: 'note missing' }, 404);
  }
}

@ExceptionHandler()
export class NoteFallback {
  @NotFound()
  public notFound(context: Ctx, request: NotFoundRequest) {
    return context.send({ error: 'no such page', path: request.path }, 404);
  }
}

@Schedule({ cron: '0 3 * * *' })
export class NoteCleanup implements AsenaSchedule {
  public async execute() {
    console.log(CLEANUP_MARKER);
  }
}

@Config()
export class NoteConfig implements AsenaConfig {
  public globalMiddlewares() {
    return [{ middleware: NoteAudit, routes: { include: ['/notes/*'] } }];
  }
}

/** Every component of the app, in the order `asena console` would list them. */
export const allComponents = [
  NoteStore,
  NoteAudit,
  NoteLock,
  NoteValidator,
  NoteController,
  StatusController,
  NoteErrors,
  NoteFallback,
  NoteCleanup,
  NoteConfig,
];

/** What the explicit entry hands `AsenaServerFactory.create`: everything but the `@NotFound` handler. */
export const explicitComponents = allComponents.filter((component) => component !== NoteFallback);
