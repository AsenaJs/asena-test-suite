import type { DevtoolsComponent, DevtoolsRoute, DevtoolsSnapshot } from '@asenajs/asena/devtools';

function component(
  name: string,
  type: DevtoolsComponent['type'],
  extra: Partial<Pick<DevtoolsComponent, 'dependencies' | 'values'>> = {},
): DevtoolsComponent {
  return { name, type, scope: 'singleton', interfaces: [], className: name, dependencies: [], values: [], ...extra };
}

function route(
  controller: string,
  method: string,
  httpMethod: DevtoolsRoute['httpMethod'],
  path: string,
  extra: Partial<Pick<DevtoolsRoute, 'middlewares' | 'validator' | 'hasBodySchema'>> = {},
): DevtoolsRoute {
  return {
    controller,
    method,
    httpMethod,
    path,
    middlewares: [],
    validator: null,
    contract: null,
    hasBodySchema: false,
    staticServe: false,
    ...extra,
  };
}

/** What the agent reports for `fixtures/app.ts` booted from the build list. Adapter-independent by definition. */
export const appSnapshot: DevtoolsSnapshot = {
  components: [
    component('NoteAudit', 'MIDDLEWARE'),
    component('NoteCleanup', 'SCHEDULE'),
    component('NoteConfig', 'CONFIG'),
    component('NoteController', 'CONTROLLER', {
      dependencies: [
        { field: 'store', target: 'NoteStore', kind: 'inject' },
        { field: null, target: 'NoteLock', kind: 'soft' },
      ],
    }),
    component('NoteErrors', 'EXCEPTION_HANDLER'),
    component('NoteFallback', 'EXCEPTION_HANDLER'),
    component('NoteLock', 'MIDDLEWARE'),
    component('NoteStore', 'SERVICE', {
      values: [{ field: 'pageSize', key: 'DEVTOOLS_FIXTURE_PAGE_SIZE', hasDefault: true, parsed: true, isSet: false }],
    }),
    component('NoteValidator', 'MIDDLEWARE'),
    component('StatusController', 'CONTROLLER'),
  ],
  routes: [
    route('NoteController', 'list', 'GET', '/notes/'),
    route('NoteController', 'create', 'POST', '/notes/', { validator: 'NoteValidator', hasBodySchema: true }),
    route('NoteController', 'broken', 'GET', '/notes/broken'),
    route('NoteController', 'flood', 'GET', '/notes/flood/:unit'),
    route('NoteController', 'late', 'GET', '/notes/late'),
    route('NoteController', 'locked', 'GET', '/notes/locked', { middlewares: ['NoteLock'] }),
    route('NoteController', 'missing', 'GET', '/notes/missing'),
    route('NoteController', 'talk', 'GET', '/notes/talk/:tag'),
    route('StatusController', 'read', 'GET', '/status/'),
  ],
  pages: [],
  websockets: [],
  schedules: [{ name: 'NoteCleanup', cron: '0 3 * * *' }],
  events: [],
  messageHandlers: [],
  exceptionHandlers: [
    {
      component: 'NoteErrors',
      catches: [{ method: 'missing', types: [{ name: 'NoteMissingError', chain: ['NoteMissingError', 'Error'] }] }],
    },
    { component: 'NoteFallback', catches: [], notFound: 'notFound' },
  ],
  config: {
    component: 'NoteConfig',
    hasOnError: false,
    hasOnNotFound: false,
    globalMiddlewares: [{ middleware: 'NoteAudit', include: ['/notes/*'] }],
  },
};

/** `main.explicit.ts` lists every component but `NoteFallback`, and that list wins over the build list. */
export const explicitSnapshot: DevtoolsSnapshot = {
  ...appSnapshot,
  components: appSnapshot.components.filter((entry) => entry.name !== 'NoteFallback'),
  exceptionHandlers: appSnapshot.exceptionHandlers.filter((entry) => entry.component !== 'NoteFallback'),
};
