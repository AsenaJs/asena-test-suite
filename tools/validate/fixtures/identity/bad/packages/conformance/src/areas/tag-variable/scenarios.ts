import { runTag } from '@asenajs/adapter-conformance';

export function register(): void {
  const t = runTag();

  if (t.startsWith('h')) return;
}
