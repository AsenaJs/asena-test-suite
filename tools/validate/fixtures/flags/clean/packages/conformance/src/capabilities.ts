export const capabilities = {
  'routing.trailingSlashAlias': { kind: 'divergence', convergence: 'WP-51' },
  'optional.notFoundHook': {
    kind: 'optional',
    contract: { kind: 'member', file: 'lib/adapter/AsenaAdapter.ts', member: 'AsenaAdapter.onNotFound' },
  },
  'optional.responseHeaders': {
    kind: 'optional',
    contract: {
      kind: 'member',
      file: 'lib/adapter/AsenaContext.ts',
      member: ['AsenaContext.setResponseHeader', 'AsenaContext.appendResponseHeader'],
    },
  },
  'optional.unixSocket': {
    kind: 'optional',
    contract: { kind: 'member', file: 'lib/adapter/types/ServeOptions.ts', member: 'AsenaStartOptions.unix' },
  },
  'optional.builtinCors': {
    kind: 'optional',
    contract: { kind: 'non-member', reason: 'built-in middlewares are adapter extras' },
  },
};
