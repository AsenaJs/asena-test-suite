import type { AsenaAdapter } from '@asenajs/asena/adapter';

declare const adapter: AsenaAdapter<any, any>;

export const className: string = adapter.constructor.name;
