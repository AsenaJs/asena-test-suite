// One mode per process: OTel global providers are set-once and heap snapshots are process-global.
// Usage (cwd ecosystem/, adapter from the bunfig preload): bun modules/otel-leak-sim/child.ts --mode=fixed|leaky
// Exit 0 = the mode's expectation met, 1 = not met, 2 = harness error.
import { bootApp, runTag } from '@asenajs/adapter-conformance';
import { FixedComponents, LeakyComponents, leakSimMetricReader } from './fixtures/app.ts';
import { countHeapClasses, forceGc, pinSentinels, SENTINEL_COUNT, sampleMemory } from './harness/heap-count.ts';
import { emitJsonLine, type Mode, renderTable, type RunResult, type Snapshot, type Verdict } from './harness/report.ts';
import { runWave, type WaveConfig } from './harness/traffic.ts';

const COUNTER_NAME = 'http.server.request.count';
const DURATION_NAME = 'http.server.request.duration';
const SENTINELS = pinSentinels();

function die(reason: string): never {
  process.stderr.write(`[leak-sim] HARNESS ERROR: ${reason}\n`);
  process.exit(2);
}

function parseMode(): Mode {
  const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.split('=')[1];

  if (mode !== 'fixed' && mode !== 'leaky') die('usage: child.ts --mode=fixed|leaky');

  return mode;
}

interface Collected {
  counterDataPoints: number;
  durationDataPoints: number;
  counterAttrKeys: Set<string>;
}

// The first collect merges the delta storage into the cumulative report history; the second proves retention.
async function collectMetrics(): Promise<Collected> {
  await leakSimMetricReader.collect();

  const { resourceMetrics } = await leakSimMetricReader.collect();
  const all = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
  const counter = all.find((metric) => metric.descriptor.name === COUNTER_NAME);
  const duration = all.find((metric) => metric.descriptor.name === DURATION_NAME);
  const counterAttrKeys = new Set<string>();

  for (const point of counter?.dataPoints ?? []) {
    for (const key of Object.keys(point.attributes)) counterAttrKeys.add(key);
  }

  return {
    counterDataPoints: counter?.dataPoints.length ?? 0,
    durationDataPoints: duration?.dataPoints.length ?? 0,
    counterAttrKeys,
  };
}

async function snapshot(label: string, cumulativeUnique: number): Promise<Snapshot> {
  const metrics = await collectMetrics();

  forceGc();

  const classCounts = countHeapClasses(['HistogramAccumulation', 'SumAccumulation', 'LeakSimSentinel']);

  if (classCounts.LeakSimSentinel !== SENTINEL_COUNT) {
    die(`sentinel calibration failed: expected ${SENTINEL_COUNT} LeakSimSentinel, got ${classCounts.LeakSimSentinel}`);
  }

  const memory = sampleMemory();

  return {
    label,
    histogramAccumulation: classCounts.HistogramAccumulation,
    sumAccumulation: classCounts.SumAccumulation,
    counterDataPoints: metrics.counterDataPoints,
    durationDataPoints: metrics.durationDataPoints,
    rssMb: memory.rssMb,
    heapUsedMb: memory.heapUsedMb,
    cumulativeUniqueUnmatched: cumulativeUnique,
  };
}

async function verifyWiring(mode: Mode): Promise<void> {
  const { counterAttrKeys } = await collectMetrics();
  const keys = [...counterAttrKeys].join(',');

  if (counterAttrKeys.size === 0) die('no metric data points after warmup - middleware not recording metrics?');

  if (mode === 'fixed') {
    if (counterAttrKeys.has('url.path')) die(`fixed mode but metric attributes contain 'url.path': ${keys}`);
    if (!counterAttrKeys.has('http.route')) die(`fixed mode but no 'http.route' metric attribute: ${keys}`);
  } else if (!counterAttrKeys.has('url.path')) {
    die(`leaky mode but no 'url.path' metric attribute (fixed code loaded?): ${keys}`);
  }
}

function evaluate(mode: Mode, snaps: Snapshot[], uniquePerWave: number[]): { verdict: Verdict; reason: string } {
  const [s0, , s2, s3] = snaps;
  const u3 = uniquePerWave[uniquePerWave.length - 1];
  const durationGrowth = s3.durationDataPoints - s2.durationDataPoints;
  const counterGrowth = s3.counterDataPoints - s2.counterDataPoints;
  const histAccGrowth = s3.histogramAccumulation - s2.histogramAccumulation;
  const heapUsedGrowth = s3.heapUsedMb - s0.heapUsedMb;

  if (mode === 'fixed') {
    const pass =
      durationGrowth <= 5 &&
      counterGrowth <= 5 &&
      s3.durationDataPoints <= 64 &&
      histAccGrowth <= 8 &&
      heapUsedGrowth <= 8;
    const reason =
      `durationDelta=${durationGrowth} (<=5) counterDelta=${counterGrowth} (<=5) final=${s3.durationDataPoints} (<=64) ` +
      `histAccDelta=${histAccGrowth} (<=8) heapDelta=${heapUsedGrowth.toFixed(1)}MB (<=8)`;

    return { verdict: pass ? 'PLATEAU' : 'INCONCLUSIVE', reason };
  }

  const pass = durationGrowth >= 0.8 * u3 && histAccGrowth >= 0.8 * u3;
  const reason = `durationDelta=${durationGrowth} histAccDelta=${histAccGrowth} vs U=${u3} (need >=${Math.round(0.8 * u3)})`;

  return { verdict: pass ? 'LEAK_DETECTED' : 'INCONCLUSIVE', reason };
}

async function main(): Promise<void> {
  const mode = parseMode();
  const app = await bootApp({ components: mode === 'fixed' ? FixedComponents : LeakyComponents }).catch((error) =>
    die(`server boot failed: ${(error as Error)?.message ?? error}`),
  );
  const waves: WaveConfig[] = [
    { normal: 300, attacker: 0, scanner: 0, tag: 'w0' },
    { normal: 300, attacker: 200, scanner: 500, tag: 'w1' },
    { normal: 300, attacker: 200, scanner: 500, tag: 'w2' },
    { normal: 300, attacker: 200, scanner: 500, tag: 'w3' },
  ];
  const uniquePerWave: number[] = [];
  const snapshots: Snapshot[] = [];
  let cumulativeUnique = 0;
  let totalRequests = 0;

  try {
    for (const [index, wave] of waves.entries()) {
      const unique = await runWave(app.baseUrl, wave);

      uniquePerWave.push(unique);
      cumulativeUnique += unique;
      totalRequests += wave.normal + wave.attacker + wave.scanner;

      if (index === 0) await verifyWiring(mode);

      snapshots.push(await snapshot(`S${index}`, cumulativeUnique));
    }
  } finally {
    await app.server.stop().catch(() => {});
  }

  const { verdict, reason } = evaluate(mode, snapshots, uniquePerWave);
  const [s0, , s2, s3] = snapshots;
  const result: RunResult = {
    mode,
    run: `${runTag()}`,
    totalRequests,
    uniquePerWave,
    snapshots,
    verdict,
    reason,
    deltas: {
      counterGrowthLastWave: s3.counterDataPoints - s2.counterDataPoints,
      durationGrowthLastWave: s3.durationDataPoints - s2.durationDataPoints,
      histAccGrowthLastWave: s3.histogramAccumulation - s2.histogramAccumulation,
      finalDurationDataPoints: s3.durationDataPoints,
      heapUsedGrowth: s3.heapUsedMb - s0.heapUsedMb,
    },
  };

  process.stdout.write(`${renderTable(result)}\n`);
  emitJsonLine(result);

  if (SENTINELS.length !== SENTINEL_COUNT) die('sentinel array mutated');

  process.exit(verdict === (mode === 'fixed' ? 'PLATEAU' : 'LEAK_DETECTED') ? 0 : 1);
}

main().catch((error) => die(`unhandled: ${(error as Error)?.stack ?? error}`));
