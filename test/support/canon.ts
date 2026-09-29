import { metrics } from '../../src/index.ts';
import type { MetricFamily } from '../../src/index.ts';

const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);

/** IEEE bits as hex, or "NaN": the same encoding the Go oracle uses. */
export function bits(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  f64[0] = v;
  return u64[0]!.toString(16);
}

export interface CanonMetric {
  labels: Array<[string, string]>;
  ts: number | null;
  value?: string;
  sum?: string;
  count?: string;
  buckets?: Array<[string, string]>;
  quantiles?: Array<[string, string]>;
}

export interface CanonFamily {
  name: string;
  type: string;
  help: string | null;
  metrics: CanonMetric[];
}

const TYPE: Record<string, string> = {
  counter: 'counter',
  gauge: 'gauge',
  summary: 'summary',
  unknown: 'untyped',
  histogram: 'histogram',
  gaugehistogram: 'gauge_histogram',
};

/** Summary counts are uint64 in Go, so only compare them where the conversion is well defined. */
function summaryCount(v: number): string {
  return Number.isInteger(v) && v >= 0 && v < 2 ** 53 ? bits(v) : 'X';
}

export function canon(fams: MetricFamily[]): CanonFamily[] {
  const out: CanonFamily[] = fams.map((f) => ({
    name: f.name,
    type: TYPE[f.type] ?? f.type,
    help: f.help ?? null,
    metrics: metrics(f).map((m) => {
      const c: CanonMetric = { labels: [...m.labels], ts: m.timestamp ?? null };
      if (f.type === 'summary') {
        if (m.sum !== undefined) c.sum = bits(m.sum);
        if (m.count !== undefined) c.count = summaryCount(m.count);
        if (m.quantiles) c.quantiles = m.quantiles.map((q) => [bits(q.quantile), bits(q.value)]);
      } else if (f.type === 'histogram' || f.type === 'gaugehistogram') {
        if (m.sum !== undefined) c.sum = bits(m.sum);
        if (m.count !== undefined) c.count = bits(m.count === 0 ? 0 : m.count);
        if (m.buckets) c.buckets = m.buckets.map((b) => [bits(b.upperBound), bits(b.count === 0 ? 0 : b.count)]);
      } else {
        c.value = bits(m.value!);
      }
      return c;
    }),
  }));
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Collapse runs of U+FFFD: lossy UTF-8 decoders disagree on how many they emit. */
function fffd(s: string | null): string | null {
  return s === null ? null : s.replace(/�+/g, '�');
}

/** Normalize the oracle's output to the same shape as `canon`. */
export function normalizeOracle(fams: CanonFamily[] | undefined): CanonFamily[] {
  const out = (fams ?? []).map((f) => ({
    ...f,
    help: fffd(f.help),
    metrics: f.metrics.map((m) => JSON.parse(JSON.stringify(m)) as CanonMetric),
  }));
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function normalizeMine(fams: CanonFamily[]): CanonFamily[] {
  return fams.map((f) => ({ ...f, help: fffd(f.help), metrics: f.metrics.map((m) => JSON.parse(JSON.stringify(m)) as CanonMetric) }));
}

/** Drop fields that are `X` in ours from both sides. */
export function maskUnknown(mine: CanonFamily[], theirs: CanonFamily[]): void {
  const t = new Map(theirs.map((f) => [f.name, f]));
  for (const f of mine) {
    const g = t.get(f.name);
    if (!g) continue;
    f.metrics.forEach((m, i) => {
      if (m.count === 'X') {
        delete m.count;
        const o = g.metrics[i];
        if (o) delete o.count;
      }
    });
  }
}
