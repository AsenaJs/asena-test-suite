import { applyMaintainerSelection } from '../packages/conformance/src/maintainer.ts';

const path = process.argv[2] ?? '../adapters/hono.ts';
const literal = await import('../adapters/hono.ts');
const computed = await import(path);

applyMaintainerSelection({ tag: 'x', divergences: literal.divergences ?? computed.divergences, mixed: [] });
