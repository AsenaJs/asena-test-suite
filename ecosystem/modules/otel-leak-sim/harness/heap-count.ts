const NODE_STRIDE = 4;
const CLASS_NAME_OFFSET = 2;

export class LeakSimSentinel {
  public constructor(public readonly n: number) {}
}

export const SENTINEL_COUNT = 100;

export function pinSentinels(): LeakSimSentinel[] {
  const pinned: LeakSimSentinel[] = [];

  for (let i = 0; i < SENTINEL_COUNT; i++) pinned.push(new LeakSimSentinel(i));

  return pinned;
}

interface JscSnapshot {
  nodes: number[];
  nodeClassNames: string[];
}

export function countHeapClasses(classNames: string[]): Record<string, number> {
  const raw: unknown = Bun.generateHeapSnapshot('jsc');
  const snapshot = (typeof raw === 'string' ? JSON.parse(raw) : raw) as JscSnapshot;
  const { nodes, nodeClassNames } = snapshot;
  const counts: Record<string, number> = {};
  const indexToName = new Map<number, string>();

  for (const name of classNames) {
    counts[name] = 0;

    const index = nodeClassNames.indexOf(name);

    if (index !== -1) indexToName.set(index, name);
  }

  for (let i = 0; i + CLASS_NAME_OFFSET < nodes.length; i += NODE_STRIDE) {
    const name = indexToName.get(nodes[i + CLASS_NAME_OFFSET]);

    if (name !== undefined) counts[name]++;
  }

  return counts;
}

export interface MemorySample {
  rssMb: number;
  heapUsedMb: number;
}

export function sampleMemory(): MemorySample {
  const usage = process.memoryUsage();

  return { rssMb: usage.rss / 1024 / 1024, heapUsedMb: usage.heapUsed / 1024 / 1024 };
}

export function forceGc(): void {
  for (let i = 0; i < 3; i++) Bun.gc(true);
}
