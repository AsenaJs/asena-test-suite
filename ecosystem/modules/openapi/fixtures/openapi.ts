import type { AsenaContext, AsenaNextHandler } from '@asenajs/asena/adapter';
import { Config, Controller, Middleware } from '@asenajs/asena/decorators';
import { Get, Post } from '@asenajs/asena/decorators/http';
import { AsenaMiddlewareService, type AsenaValidationService } from '@asenajs/asena/middleware';
import type { AsenaConfig } from '@asenajs/asena/server/config';
import { Hidden, OpenApi, OpenApiPostProcessor } from '@asenajs/asena-openapi';
import { type ZodType, z } from 'zod';

type Ctx = AsenaContext<any, any>;
type Component = new (...args: any[]) => unknown;

export const SPEC_PATH = '/api/openapi';
export const API_TITLE = 'Suite API';
export const API_VERSION = '1.2.3';

export interface OpenApiFixture {
  components: Component[];
  stamped: string[];
}

function documentComponents(): Component[] {
  @OpenApi({ info: { title: API_TITLE, version: API_VERSION }, path: SPEC_PATH, ui: true })
  class SuiteOpenApi extends OpenApiPostProcessor {}

  @Controller({ path: '/books', description: 'Book catalogue endpoints' })
  class BookController {
    @Get({ path: '/', summary: 'List books', description: 'List every book' })
    public list(context: Ctx) {
      return context.send([]);
    }

    @Get('/:bookId/chapters/:chapter')
    public chapter(context: Ctx) {
      return context.send({ bookId: context.getParam('bookId'), chapter: context.getParam('chapter') });
    }
  }

  return [SuiteOpenApi, BookController];
}

function hiddenComponents(): Component[] {
  @Hidden()
  @Controller('/internal')
  class InternalController {
    @Get('/metrics')
    public metrics(context: Ctx) {
      return context.send({ scope: 'internal' });
    }
  }

  @Controller('/public-metrics')
  class PublicMetricsController extends InternalController {}

  class DiagnosticsBase {
    @Get('/ping')
    public ping(context: Ctx) {
      return context.send({ pong: true });
    }

    @Hidden()
    @Get('/dump')
    public dump(context: Ctx) {
      return context.send({ dump: true });
    }
  }

  @Controller('/diagnostics')
  class DiagnosticsController extends DiagnosticsBase {
    @Hidden()
    @Get('/secret')
    public secret(context: Ctx) {
      return context.send({ secret: true });
    }
  }

  return [InternalController, PublicMetricsController, DiagnosticsController];
}

export function openApiFixture(): OpenApiFixture {
  const stamped: string[] = [];

  @Middleware()
  class OpenApiStamp extends AsenaMiddlewareService {
    public async handle(context: Ctx, next: AsenaNextHandler) {
      stamped.push(new URL((context.req as { url: string }).url).pathname);
      await next();
    }
  }

  @Config()
  class OpenApiSuiteConfig implements AsenaConfig {
    public globalMiddlewares() {
      return [OpenApiStamp];
    }
  }

  return {
    components: [...documentComponents(), ...hiddenComponents(), OpenApiStamp, OpenApiSuiteConfig],
    stamped,
  };
}

export function zodValidatorComponents(): Component[] {
  @OpenApi({ info: { title: API_TITLE, version: API_VERSION }, path: SPEC_PATH })
  class ZodOpenApi extends OpenApiPostProcessor {}

  @Middleware({ validator: true })
  class CreateAuthorValidator implements AsenaValidationService<ZodType> {
    public json() {
      return z
        .object({
          name: z.string().min(1).describe('Display name of the author'),
          email: z.email(),
          born: z.number().int().optional(),
        })
        .describe('Author creation payload');
    }
  }

  @Middleware({ validator: true })
  class AuthorQueryValidator implements AsenaValidationService<ZodType> {
    public query() {
      return z.object({
        page: z.coerce.number().describe('Page number').optional(),
        limit: z.coerce.number().describe('Items per page').optional(),
      });
    }
  }

  @Middleware({ validator: true })
  class AuthorParamValidator implements AsenaValidationService<ZodType> {
    public param() {
      return z.object({ id: z.uuid().describe('Author unique identifier') });
    }
  }

  @Controller('/authors')
  class AuthorController {
    @Post({ path: '/', validator: CreateAuthorValidator })
    public async create(context: Ctx) {
      return context.send(await context.getBody(), 201);
    }

    @Get({ path: '/', validator: AuthorQueryValidator })
    public list(context: Ctx) {
      return context.send([]);
    }

    @Get({ path: '/:id', validator: AuthorParamValidator })
    public byId(context: Ctx) {
      return context.send({ id: context.getParam('id') });
    }
  }

  return [ZodOpenApi, CreateAuthorValidator, AuthorQueryValidator, AuthorParamValidator, AuthorController];
}

export function contractComponents(define: (schemas: object) => new (...args: any[]) => unknown): Component[] {
  @OpenApi({ info: { title: API_TITLE, version: API_VERSION }, path: SPEC_PATH })
  class ContractOpenApi extends OpenApiPostProcessor {}

  const ReviewContext = define({
    body: z.object({ rating: z.number().int().min(1).max(5), text: z.string() }),
    query: z.object({ draft: z.enum(['yes', 'no']) }),
    params: z.object({ bookId: z.string() }),
  }) as new (...args: any[]) => Ctx & { readonly input: Record<string, any> };

  class ReviewRouteContext extends ReviewContext {}

  @Controller('/reviews')
  class ReviewController {
    @Post('/:bookId')
    public create(context: ReviewRouteContext) {
      return context.send({ input: context.input }, 201);
    }
  }

  return [ContractOpenApi, ReviewController];
}
