export interface Snapshot {
  label: string;
  histogramAccumulation: number;
  sumAccumulation: number;
  counterDataPoints: number;
  durationDataPoints: number;
  rssMb: number;
  heapUsedMb: number;
  cumulativeUniqueUnmatched: number;
}

export type Mode = 'fixed' | 'leaky';

export type Verdict = 'PLATEAU' | 'LEAK_DETECTED' | 'INCONCLUSIVE';

export interface RunResult {
  mode: Mode;
  run: string;
  totalRequests: number;
  uniquePerWave: number[];
  snapshots: Snapshot[];
  verdict: Verdict;
  reason: string;
  deltas: {
    counterGrowthLastWave: number;
    durationGrowthLastWave: number;
    histAccGrowthLastWave: number;
    finalDurationDataPoints: number;
    heapUsedGrowth: number;
  };
}

export const RESULT_MARKER = '@@RESULT ';

function pad(value: string | number, width: number): string {
  return String(value).padStart(width);
}

export function renderTable(result: RunResult): string {
  const snaps = result.snapshots;
  const width = 6;
  const header = `| ${'Metric'.padEnd(32)} |${snaps.map((snap) => ` ${pad(snap.label, width)} |`).join('')}`;
  const separator = `|${'-'.repeat(34)}|${snaps.map(() => `${'-'.repeat(width + 2)}|`).join('')}`;
  const row = (name: string, pick: (snap: Snapshot) => string | number) =>
    `| ${name.padEnd(32)} |${snaps.map((snap) => ` ${pad(pick(snap), width)} |`).join('')}`;

  return [
    `## leak-sim report - mode=${result.mode}, run=${result.run}, ${result.totalRequests} req, U=[${result.uniquePerWave.join(', ')}]`,
    '',
    header,
    separator,
    row('HistogramAccumulation', (snap) => snap.histogramAccumulation),
    row('SumAccumulation', (snap) => snap.sumAccumulation),
    row('dataPoints request.count', (snap) => snap.counterDataPoints),
    row('dataPoints request.duration', (snap) => snap.durationDataPoints),
    row('RSS (MB)', (snap) => snap.rssMb.toFixed(0)),
    row('heapUsed (MB)', (snap) => snap.heapUsedMb.toFixed(1)),
    row('unique unmatched (cum.)', (snap) => snap.cumulativeUniqueUnmatched),
    '',
    `VERDICT: ${result.verdict} - ${result.reason}`,
  ].join('\n');
}

export function emitJsonLine(result: RunResult): void {
  process.stdout.write(`${RESULT_MARKER}${JSON.stringify(result)}\n`);
}
