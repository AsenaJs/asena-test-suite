import { expect } from 'bun:test';
import type { TestApp } from '@asenajs/asena/test';
import { bootApp, getDescriptor, scenario } from '@asenajs/adapter-conformance';
import {
  API_TITLE,
  API_VERSION,
  contractComponents,
  openApiFixture,
  SPEC_PATH,
  zodValidatorComponents,
} from './fixtures/openapi.ts';

async function specOf(app: TestApp): Promise<any> {
  const response = await app.get(SPEC_PATH);

  expect(response.status).toBe(200);

  return response.json();
}

const zod = { requires: ['optional.zodValidator' as const] };

scenario('P2.openapi.001', 'the spec route answers 200 JSON with openapi 3.1.0 and the configured info', async () => {
  await using app = await bootApp({ components: openApiFixture().components });
  const response = await app.get(SPEC_PATH);

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.json()).toMatchObject({ openapi: '3.1.0', info: { title: API_TITLE, version: API_VERSION } });
});

scenario('P2.openapi.002', 'the UI route answers HTML with the Swagger UI bundle pointing at the spec', async () => {
  await using app = await bootApp({ components: openApiFixture().components });
  const response = await app.get(`${SPEC_PATH}/ui`);
  const html = response.text();

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  expect(html).toContain('<div id="swagger-ui"></div>');
  expect(html).toContain('SwaggerUIBundle({');
  expect(html).toContain(`url: '${SPEC_PATH}'`);
  expect(html).toContain(`<title>${API_TITLE} - API Docs</title>`);
});

scenario(
  'P2.openapi.010',
  'path params are converted to {name} and documented as required path parameters',
  async () => {
    await using app = await bootApp({ components: openApiFixture().components });
    const spec = await specOf(app);

    expect(spec.paths['/books/:bookId/chapters/:chapter']).toBeUndefined();
    expect(spec.paths['/books/{bookId}/chapters/{chapter}'].get.parameters).toEqual([
      { name: 'bookId', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'chapter', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  },
);

scenario(
  'P2.openapi.011',
  'a zod json validator becomes the required application/json requestBody',
  async () => {
    await using app = await bootApp({ components: zodValidatorComponents() });
    const body = (await specOf(app)).paths['/authors'].post.requestBody;
    const schema = body.content['application/json'].schema;

    expect(body.required).toBe(true);
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toEqual(['name', 'email', 'born']);
    expect(schema.properties.email).toMatchObject({ type: 'string', format: 'email' });
    expect(schema.properties.born.type).toBe('integer');
    expect(schema.required).toEqual(['name', 'email']);
  },
  zod,
);

scenario(
  'P2.openapi.012',
  'a zod query validator becomes optional query parameters',
  async () => {
    await using app = await bootApp({ components: zodValidatorComponents() });
    const parameters = (await specOf(app)).paths['/authors'].get.parameters;

    expect(parameters.map((p: any) => [p.name, p.in, p.required ?? false, p.schema.type])).toEqual([
      ['page', 'query', false, 'number'],
      ['limit', 'query', false, 'number'],
    ]);
  },
  zod,
);

scenario(
  'P2.openapi.013',
  'zod .describe() texts reach parameters, properties and the request body',
  async () => {
    await using app = await bootApp({ components: zodValidatorComponents() });
    const paths = (await specOf(app)).paths;
    const query = paths['/authors'].get.parameters;
    const [id] = paths['/authors/{id}'].get.parameters;
    const body = paths['/authors'].post.requestBody;

    expect(query.map((p: any) => p.description)).toEqual(['Page number', 'Items per page']);
    expect(id).toMatchObject({ name: 'id', in: 'path', required: true, description: 'Author unique identifier' });
    expect(body.description).toBe('Author creation payload');
    expect(body.content['application/json'].schema.properties.name.description).toBe('Display name of the author');
  },
  zod,
);

scenario(
  'P2.openapi.014',
  'controllers become tags and a controller description becomes the tag description',
  async () => {
    await using app = await bootApp({ components: openApiFixture().components });
    const spec = await specOf(app);

    expect(spec.tags).toContainEqual({ name: 'BookController', description: 'Book catalogue endpoints' });
    expect(spec.paths['/books'].get.tags).toEqual(['BookController']);
  },
);

scenario('P2.openapi.015', 'route summary and description are taken from the route decorator', async () => {
  await using app = await bootApp({ components: openApiFixture().components });
  const list = (await specOf(app)).paths['/books'].get;

  expect(list.summary).toBe('List books');
  expect(list.description).toBe('List every book');
  expect(list.operationId).toBe('BookController_list');
});

scenario('P2.openapi.020', 'a Context.define route documents its body, query and params schemas', async () => {
  await using app = await bootApp({
    components: contractComponents((schemas) => getDescriptor().defineContext(schemas)),
  });
  const post = (await specOf(app)).paths['/reviews/{bookId}'].post;
  const schema = post.requestBody.content['application/json'].schema;

  expect(post.requestBody.required).toBe(true);
  expect(schema.properties).toEqual({ rating: { type: 'integer', minimum: 1, maximum: 5 }, text: { type: 'string' } });
  expect(schema.required).toEqual(['rating', 'text']);
  expect(post.parameters).toEqual([
    { name: 'draft', in: 'query', required: true, schema: { type: 'string', enum: ['yes', 'no'] } },
    { name: 'bookId', in: 'path', required: true, schema: { type: 'string' } },
  ]);
});

scenario('P2.openapi.030', '@Hidden hides class and method routes from the spec while they still answer', async () => {
  await using app = await bootApp({ components: openApiFixture().components });
  const spec = await specOf(app);
  const tags = spec.tags.map((tag: { name: string }) => tag.name);

  expect(spec.paths['/internal/metrics']).toBeUndefined();
  expect(spec.paths['/diagnostics/dump']).toBeUndefined();
  expect(spec.paths['/diagnostics/secret']).toBeUndefined();
  expect(spec.paths['/public-metrics/metrics'].get.operationId).toBe('PublicMetricsController_metrics');
  expect(spec.paths['/diagnostics/ping'].get.operationId).toBe('DiagnosticsController_ping');
  expect(tags).not.toContain('InternalController');
  expect(tags).toContain('PublicMetricsController');

  for (const [path, body] of [
    ['/internal/metrics', { scope: 'internal' }],
    ['/public-metrics/metrics', { scope: 'internal' }],
    ['/diagnostics/dump', { dump: true }],
    ['/diagnostics/secret', { secret: true }],
  ] as const) {
    const response = await app.get(path);

    expect(response.status).toBe(200);
    expect(response.json()).toEqual(body);
  }
});

scenario('P2.openapi.040', 'a global middleware from the config runs for the spec and UI routes', async () => {
  const fixture = openApiFixture();
  await using app = await bootApp({ components: fixture.components });

  expect((await app.get(SPEC_PATH)).status).toBe(200);
  expect((await app.get(`${SPEC_PATH}/ui`)).status).toBe(200);
  expect(fixture.stamped).toEqual([SPEC_PATH, `${SPEC_PATH}/ui`]);
});
