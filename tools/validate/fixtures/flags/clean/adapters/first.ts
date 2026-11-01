export default {
  id: 'first',
  packageName: 'first-adapter',
  createAdapter: () => undefined,
  defineContext: () => class {},
  capabilities: {
    'optional.notFoundHook': true,
    'optional.responseHeaders': true,
    'optional.unixSocket': true,
    'optional.builtinCors': true,
  },
};

export const divergences = { 'routing.trailingSlashAlias': false };
