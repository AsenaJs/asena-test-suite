export default {
  id: 'second',
  packageName: 'second-adapter',
  createAdapter: () => undefined,
  defineContext: () => class {},
  cliTemplate: 'second',
  capabilities: {
    'optional.notFoundHook': true,
    'optional.responseHeaders': true,
    'optional.unixSocket': true,
    'optional.builtinCors': true,
  },
};

export const divergences = {};
