import { expect } from 'bun:test';
import { bootApp } from '../../boot.ts';
import { area, scenario } from '../../scenario.ts';
import { bodyFixture, emptyBodyFixture, invalidJsonFixture } from './fixtures/body.ts';
import {
  afterNextFixture,
  cookieSurfaceFixture,
  headerSurfaceFixture,
  querySurfaceFixture,
  responseSurfaceFixture,
  valueSurfaceFixture,
} from './fixtures/surface.ts';
import { rawExchange } from './raw.ts';

const JSON_HEADERS = { 'content-type': 'application/json' };
const LOOPBACK = /^(?:127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;

interface ParsedCookie {
  name: string;
  value: string;
  attributes: Record<string, string>;
}

function parseSetCookie(header: string | null): ParsedCookie {
  const [pair = '', ...rest] = (header ?? '').split(';').map((part) => part.trim());
  const eq = pair.indexOf('=');
  const attributes: Record<string, string> = {};

  for (const part of rest) {
    const at = part.indexOf('=');

    if (at === -1) attributes[part.toLowerCase()] = '';
    else attributes[part.slice(0, at).toLowerCase()] = part.slice(at + 1);
  }

  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attributes };
}

function mediaType(header: string | null): string | undefined {
  return header?.split(';')[0]?.trim().toLowerCase();
}

function multipart(): FormData {
  const form = new FormData();

  form.append('title', 'doc');
  form.append('upload', new File(['file-body'], 'a.txt', { type: 'text/plain' }));

  return form;
}

const UPLOAD = { kind: 'file', name: 'a.txt', size: 9, type: 'text/plain;charset=utf-8', text: 'file-body' };

const EMPTY_BODIES: [string, string[], string][] = [
  [
    'json, Content-Length 0',
    ['POST /ctx-empty/body HTTP/1.1', 'Content-Type: application/json', 'Content-Length: 0'],
    '',
  ],
  ['no content type, Content-Length 0', ['POST /ctx-empty/body HTTP/1.1', 'Content-Length: 0'], ''],
  ['json, no Content-Length', ['POST /ctx-empty/body HTTP/1.1', 'Content-Type: application/json'], ''],
  [
    'json, whitespace only',
    ['POST /ctx-empty/body HTTP/1.1', 'Content-Type: application/json', 'Content-Length: 4'],
    ' \n\t ',
  ],
  ['GET without a body', ['GET /ctx-empty/body HTTP/1.1'], ''],
];

export function register(): void {
  area('context', () => {
    scenario('P1.context.001', 'getBody parses a JSON body', async () => {
      await using app = await bootApp({ components: bodyFixture() });
      const response = await app.post('/ctx-body/json', { headers: JSON_HEADERS, body: '{"a":1,"b":[true]}' });

      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ body: { a: 1, b: [true] } });
    });

    scenario('P1.context.002', 'getArrayBuffer returns the raw bytes', async () => {
      await using app = await bootApp({ components: bodyFixture() });
      const response = await app.post('/ctx-body/array-buffer', { body: new Uint8Array([0, 1, 255]) });

      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ isArrayBuffer: true, size: 3, bytes: [0, 1, 255] });
    });

    scenario('P1.context.003', 'getBlob returns a Blob with the body and its type', async () => {
      await using app = await bootApp({ components: bodyFixture() });
      const response = await app.post('/ctx-body/blob', { headers: { 'content-type': 'text/plain' }, body: 'hello' });

      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ isBlob: true, size: 5, type: 'text/plain;charset=utf-8', text: 'hello' });
    });

    scenario('P1.context.004', 'getFormData reads a multipart body with a file', async () => {
      await using app = await bootApp({ components: bodyFixture() });
      const response = await app.post('/ctx-body/form-data', { body: multipart() });

      expect(response.status).toBe(200);
      expect(response.json()).toEqual({
        isFormData: true,
        title: { kind: 'string', value: 'doc' },
        upload: UPLOAD,
      });
    });

    scenario('P1.context.005', 'getParseBody reads urlencoded and multipart bodies', async () => {
      await using app = await bootApp({ components: bodyFixture() });
      const urlencoded = await app.post('/ctx-body/parse-body', {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'title=doc&x=1',
      });

      expect(urlencoded.status).toBe(200);
      expect(urlencoded.json()).toEqual({ title: { kind: 'string', value: 'doc' }, x: { kind: 'string', value: '1' } });

      const form = await app.post('/ctx-body/parse-body', { body: multipart() });

      expect(form.status).toBe(200);
      expect(form.json()).toEqual({ title: { kind: 'string', value: 'doc' }, upload: UPLOAD });
    });

    scenario(
      'P1.context.006',
      'invalid JSON in getBody reaches onError as HttpException(400)',
      async () => {
        const fixture = invalidJsonFixture();
        await using app = await bootApp({ components: fixture.components });
        const response = await app.post('/ctx-body/invalid-json', { headers: JSON_HEADERS, body: '{"a":' });

        expect(fixture.calls.handlerReturned).toBe(0);
        expect(response.json()).toEqual({ httpException: true, status: 400 });
        expect(response.status).toBe(400);
      },
      { requires: ['context.invalidJsonIsBadRequest'] },
    );

    scenario('P1.context.007', 'the body read in a middleware and again in the handler is the same value', async () => {
      await using app = await bootApp({ components: bodyFixture() });
      const response = await app.post('/ctx-body/twice', { headers: JSON_HEADERS, body: '{"a":1}' });

      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ middleware: { a: 1 }, handler: { a: 1 } });
    });

    scenario(
      'P1.context.008',
      'getBody resolves {} for an empty body, with or without a content type or Content-Length',
      async () => {
        await using app = await bootApp({ components: emptyBodyFixture() });
        const seen: [string, number, unknown][] = [];

        for (const [label, head, body] of EMPTY_BODIES) {
          const response = await rawExchange(app.port, head, body);

          seen.push([label, response.status, response.status === 200 ? JSON.parse(response.body) : response.body]);
        }

        expect(seen).toEqual(EMPTY_BODIES.map(([label]) => [label, 200, { first: {}, second: {} }]));
      },
      { requires: ['context.emptyBodyIsEmptyObject'] },
    );

    scenario('P1.context.010', 'getQuery returns a value, and an empty string for a present empty key', async () => {
      await using app = await bootApp({ components: querySurfaceFixture() });
      const response = await app.get('/ctx-query/one?name=ada&blank=');

      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ name: 'ada', blank: '' });
    });

    scenario('P1.context.011', 'getQueryAll returns every value of a repeated key in order', async () => {
      await using app = await bootApp({ components: querySurfaceFixture() });
      const response = await app.get('/ctx-query/all?color=red&color=blue');

      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ color: ['red', 'blue'] });
    });

    scenario('P1.context.012', 'getAllQueries returns strings for single and arrays for repeated keys', async () => {
      await using app = await bootApp({ components: querySurfaceFixture() });
      const response = await app.get('/ctx-query/every?name=ada&color=red&color=blue');

      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ name: 'ada', color: ['red', 'blue'] });
    });

    scenario(
      'P1.context.013',
      'a missing query is undefined for getQuery, {} for getAllQueries and [] for getQueryAll',
      async () => {
        await using app = await bootApp({ components: querySurfaceFixture() });
        const response = await app.get('/ctx-query/missing');

        expect(response.status).toBe(200);

        const body = response.json<{ one: unknown; every: unknown; all: unknown }>();

        expect(body.one).toBe('undefined');
        expect(body.every).toEqual({});
        expect(body.all).toEqual([]);
      },
      { requires: ['context.absentValuesMatchDeclaredTypes'] },
    );

    scenario('P1.context.020', 'headers is a map with lower-cased keys', async () => {
      await using app = await bootApp({ components: headerSurfaceFixture() });
      const response = await app.get('/ctx-headers/echo', { headers: { 'X-Custom-Header': 'v' } });

      expect(response.status).toBe(200);

      const headers = response.json<Record<string, string>>();

      expect(headers['x-custom-header']).toBe('v');
      expect(Object.keys(headers).filter((key) => key !== key.toLowerCase())).toEqual([]);
    });

    scenario('P1.context.021', 'multiple values of one header are joined with a comma', async () => {
      await using app = await bootApp({ components: headerSurfaceFixture() });
      const headers = new Headers();

      headers.append('x-multi', 'a');
      headers.append('x-multi', 'b');

      const response = await app.get('/ctx-headers/echo', { headers });

      expect(response.status).toBe(200);
      expect(response.json<Record<string, string>>()['x-multi']).toBe('a, b');
    });

    scenario(
      'P1.context.030',
      'getCookie reads a cookie, and false for a missing one',
      async () => {
        await using app = await bootApp({ components: cookieSurfaceFixture() });
        const response = await app.get('/ctx-cookie/read', { headers: { cookie: 'session=abc; other=1' } });

        expect(response.status).toBe(200);

        const body = response.json<{ session: unknown; missing: unknown }>();

        expect(body.session).toBe('abc');
        expect(body.missing).toBe(false);
      },
      { requires: ['context.absentValuesMatchDeclaredTypes'] },
    );

    scenario('P1.context.031', 'setCookie with path, httpOnly, maxAge and sameSite writes exactly those', async () => {
      await using app = await bootApp({ components: cookieSurfaceFixture() });
      const response = await app.get('/ctx-cookie/set');

      expect(response.status).toBe(200);
      expect(parseSetCookie(response.headers.get('set-cookie'))).toEqual({
        name: 'theme',
        value: 'dark',
        attributes: { path: '/', httponly: '', 'max-age': '3600', samesite: 'Strict' },
      });
    });

    scenario('P1.context.032', 'deleteCookie expires the cookie on the given path', async () => {
      await using app = await bootApp({ components: cookieSurfaceFixture() });
      const response = await app.get('/ctx-cookie/delete');

      expect(response.status).toBe(200);

      const cookie = parseSetCookie(response.headers.get('set-cookie'));
      const { 'max-age': maxAge, expires } = cookie.attributes;
      const expired = maxAge === '0' || (expires !== undefined && Date.parse(expires) <= Date.now());

      expect({ name: cookie.name, value: cookie.value, path: cookie.attributes.path, expired }).toEqual({
        name: 'theme',
        value: '',
        path: '/',
        expired: true,
      });
    });

    scenario('P1.context.033', 'a signed cookie round-trips with the secret', async () => {
      await using app = await bootApp({ components: cookieSurfaceFixture() });
      const signed = await app.get('/ctx-cookie/sign');

      expect(signed.status).toBe(200);

      const cookie = parseSetCookie(signed.headers.get('set-cookie'));

      expect(cookie.name).toBe('signed');
      expect(cookie.value).not.toBe('payload');

      const read = await app.get('/ctx-cookie/read-signed', { headers: { cookie: `signed=${cookie.value}` } });

      expect(read.status).toBe(200);
      expect(read.json()).toEqual({ value: 'payload' });
    });

    scenario('P1.context.034', 'a tampered signed cookie reads as false', async () => {
      await using app = await bootApp({ components: cookieSurfaceFixture() });
      const cookie = parseSetCookie((await app.get('/ctx-cookie/sign')).headers.get('set-cookie'));
      const tampered = cookie.value.replace(/^payload/, 'payloaX');

      expect(tampered).not.toBe(cookie.value);

      const read = await app.get('/ctx-cookie/read-signed', { headers: { cookie: `signed=${tampered}` } });

      expect(read.status).toBe(200);
      expect(read.json()).toEqual({ value: false });
    });

    scenario('P1.context.040', 'setValue in a middleware is visible to getValue in the handler', async () => {
      await using app = await bootApp({ components: valueSurfaceFixture() });
      const response = await app.get('/ctx-value/read?id=7');

      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ value: '7' });
    });

    scenario('P1.context.041', 'values do not leak between 50 concurrent requests', async () => {
      await using app = await bootApp({ components: valueSurfaceFixture() });
      const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => app.get(`/ctx-value/read?id=${i}`)));

      expect(responses.map((response) => response.status)).toEqual(Array.from({ length: 50 }, () => 200));
      expect(responses.map((response) => response.json<{ value: unknown }>().value)).toEqual(
        Array.from({ length: 50 }, (_, i) => String(i)),
      );
    });

    scenario(
      'P1.context.045',
      'after next() a global middleware still reads req.method, req.url and the produced res.status',
      async () => {
        const fixture = afterNextFixture();
        await using app = await bootApp({ components: fixture.components });
        const statuses = [
          (await app.get('/ctx-after/ok')).status,
          (await app.post('/ctx-after/created')).status,
          (await app.get('/ctx-after/forbidden')).status,
          (await app.get('/ctx-after/nowhere')).status,
        ];

        expect(statuses).toEqual([200, 201, 403, 404]);
        expect(fixture.records).toEqual([
          { method: 'GET', url: `${app.baseUrl}/ctx-after/ok`, status: 200 },
          { method: 'POST', url: `${app.baseUrl}/ctx-after/created`, status: 201 },
          { method: 'GET', url: `${app.baseUrl}/ctx-after/forbidden`, status: 403 },
          { method: 'GET', url: `${app.baseUrl}/ctx-after/nowhere`, status: 404 },
        ]);
      },
      { requires: ['middleware.codeAfterNextRuns'] },
    );

    scenario('P1.context.050', 'send(object) answers JSON with application/json', async () => {
      await using app = await bootApp({ components: responseSurfaceFixture() });
      const response = await app.get('/ctx-send/object');

      expect(response.status).toBe(200);
      expect(mediaType(response.headers.get('content-type'))).toBe('application/json');
      expect(response.json()).toEqual({ kind: 'object' });
    });

    scenario('P1.context.051', 'send(string) answers the text as text/plain', async () => {
      await using app = await bootApp({ components: responseSurfaceFixture() });
      const response = await app.get('/ctx-send/string');

      expect(response.status).toBe(200);
      expect(mediaType(response.headers.get('content-type'))).toBe('text/plain');
      expect(response.text()).toBe('plain text');
    });

    scenario('P1.context.052', 'send(data, 201) answers with that status', async () => {
      await using app = await bootApp({ components: responseSurfaceFixture() });
      const response = await app.get('/ctx-send/status');

      expect(response.status).toBe(201);
      expect(response.json()).toEqual({ kind: 'status' });
    });

    scenario('P1.context.053', 'send(data, { status, headers }) applies both', async () => {
      await using app = await bootApp({ components: responseSurfaceFixture() });
      const response = await app.get('/ctx-send/options');

      expect(response.status).toBe(202);
      expect(response.headers.get('x-send-option')).toBe('yes');
      expect(response.json()).toEqual({ kind: 'options' });
    });

    scenario('P1.context.054', 'redirect(url) answers 302 with the location', async () => {
      await using app = await bootApp({ components: responseSurfaceFixture() });
      const response = await app.get('/ctx-send/redirect', { redirect: 'manual' });

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/ctx-send/object');
    });

    scenario('P1.context.055', 'html(str) answers the markup as text/html', async () => {
      await using app = await bootApp({ components: responseSurfaceFixture() });
      const response = await app.get('/ctx-send/html');

      expect(response.status).toBe(200);
      expect(mediaType(response.headers.get('content-type'))).toBe('text/html');
      expect(response.text()).toBe('<h1>hi</h1>');
    });

    scenario(
      'P1.context.060',
      'setResponseHeader replaces an earlier value',
      async () => {
        await using app = await bootApp({ components: responseSurfaceFixture() });
        const response = await app.get('/ctx-send/set-header');

        expect(response.status).toBe(200);
        expect(response.headers.get('x-over')).toBe('second');
      },
      { requires: ['optional.responseHeaders'] },
    );

    scenario(
      'P1.context.061',
      'appendResponseHeader keeps both values',
      async () => {
        await using app = await bootApp({ components: responseSurfaceFixture() });
        const response = await app.get('/ctx-send/append-header');

        expect(response.status).toBe(200);
        expect(response.headers.get('x-multi')).toBe('a, b');
      },
      { requires: ['optional.responseHeaders'] },
    );

    scenario(
      'P1.context.062',
      'getRequestIp returns a loopback address over TCP',
      async () => {
        await using app = await bootApp({ components: responseSurfaceFixture() });
        const response = await app.get('/ctx-send/ip');

        expect(response.status).toBe(200);
        expect(response.json<{ ip: string }>().ip).toMatch(LOOPBACK);
      },
      { requires: ['optional.requestIp'] },
    );
  });
}
