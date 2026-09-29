import { formatFloat } from '../../src/numbers.ts';
import type { Exemplar, MetricFamily, Sample } from '../../src/index.ts';
import { Gen } from './gen.ts';

export interface EEx { labels: Array<[string, string]>; value: string; ts: number | null }
export interface EBucket { ub: string; count: string; float: boolean; exemplar: EEx | null }
export interface EMetric {
  labels: Array<[string, string]>;
  ts: number | null;
  value: string | null;
  exemplar: EEx | null;
  created: number | null;
  sum: string | null;
  count: string | null;
  countFloat: boolean;
  buckets: EBucket[];
  quantiles: Array<[string, string]>;
}
export interface EFam {
  name: string;
  type: 'counter' | 'gauge' | 'untyped' | 'summary' | 'histogram' | 'gaugehistogram';
  help: string | null;
  unit: string | null;
  metrics: EMetric[];
}

const SPECIAL = ['0', '1', '-1', '0.5', '2.5', '1e-7', '1e21', '123456', '1234567', '0.0001', '0.00001', '3.14159', '-2.5e10', 'NaN', '+Inf', '-Inf', '1e6', '100000', '17', '9007199254740993'];

export function genFamily(g: Gen): EFam {
  const type = g.pick(['counter', 'gauge', 'untyped', 'summary', 'histogram', 'gaugehistogram'] as const);
  let name = g.metricName();
  if (type === 'counter' && g.chance(0.7)) name += '_total';
  const num = () => (g.chance(0.5) ? g.pick(SPECIAL) : g.number().replace(/^(inf|Infinity)$/i, '+Inf').replace(/^-infinity$/i, '-Inf').replace(/^nan$/i, 'NaN'));
  const parse = (s: string) => Number(s === '+Inf' ? 'Infinity' : s === '-Inf' ? '-Infinity' : s);
  const fin = () => {
    for (;;) {
      const s = num();
      const v = parse(s);
      if (Number.isFinite(v)) return s;
    }
  };
  const ex = (): EEx | null =>
    g.chance(0.3)
      ? { labels: g.chance(0.85) ? [['trace_id', g.labelValue()]] : [], value: num(), ts: g.chance(0.5) ? g.int(2 ** 31) * 1000 + g.int(1000) : null }
      : null;
  const nm = 1 + g.int(3);
  const metrics: EMetric[] = [];
  for (let i = 0; i < nm; i++) {
    const labels: Array<[string, string]> = [];
    const used = new Set<string>();
    for (let j = g.int(3); j > 0; j--) {
      const k = g.labelName();
      if (used.has(k) || k === 'le' || k === 'quantile') continue;
      used.add(k);
      labels.push([k, g.labelValue()]);
    }
    const m: EMetric = {
      labels, ts: g.chance(0.3) ? g.int(2 ** 31) * 1000 + g.int(1000) : null, value: null, exemplar: null, created: null,
      sum: null, count: null, countFloat: false, buckets: [], quantiles: [],
    };
    if (g.chance(0.3)) m.created = g.int(2 ** 31) * 1000 + g.int(1000);
    if (type === 'counter') { m.value = num(); m.exemplar = ex(); }
    else if (type === 'gauge' || type === 'untyped') m.value = num();
    else if (type === 'summary') {
      for (let q = g.int(4); q > 0; q--) m.quantiles.push([g.pick(['0.5', '0.9', '0.99', '1', '0', '0.25']), num()]);
      if (g.chance(0.9)) m.sum = num();
      if (g.chance(0.9)) m.count = String(g.int(1000));
    } else {
      let c = 0;
      let ub = -5 + g.int(3);
      for (let b = g.int(5); b > 0; b--) {
        ub += 0.5 + g.int(4);
        c += g.int(20);
        m.buckets.push({ ub: String(ub), count: String(c), float: false, exemplar: ex() });
      }
      if (g.chance(0.85)) m.buckets.push({ ub: '+Inf', count: String(c + g.int(5)), float: false, exemplar: ex() });
      if (g.chance(0.9)) m.sum = num();
      if (g.chance(0.9)) m.count = String(c + g.int(5));
      if (g.chance(0.05)) { m.count = '2.5'; m.countFloat = true; }
      if (g.chance(0.05) && m.buckets.length) { m.buckets[0]!.count = '1.5'; m.buckets[0]!.float = true; }
    }
    void fin;
    // A summary or histogram entry with no series at all cannot come from samples.
    if ((type === 'summary' || type === 'histogram' || type === 'gaugehistogram') && m.sum === null && m.count === null && m.buckets.length === 0 && m.quantiles.length === 0) m.sum = '0';
    if (metrics.some((o) => JSON.stringify(o.labels) === JSON.stringify(m.labels))) m.labels.push(['idx', String(i)]);
    metrics.push(m);
  }
  return { name, type, help: g.chance(0.6) ? g.help().replace(/\\(.)/g, '$1') + (g.chance(0.2) ? '"q\n\\' : '') : null, unit: g.chance(0.2) ? g.pick(['seconds', 'bytes', 'a"b', '']) : null, metrics };
}

function exemplar(e: EEx | null): Exemplar | undefined {
  if (!e) return undefined;
  const r: Exemplar = { labels: new Map(e.labels), value: parseNum(e.value) };
  if (e.ts !== null) r.timestamp = e.ts;
  return r;
}

export function parseNum(s: string): number {
  return Number(s === '+Inf' ? 'Infinity' : s === '-Inf' ? '-Infinity' : s);
}

export function toFamily(f: EFam): MetricFamily {
  const samples: Sample[] = [];
  const type = f.type === 'untyped' ? 'unknown' : f.type;
  const base = type === 'counter' && f.name.endsWith('_total') ? f.name.slice(0, -6) : f.name;
  for (const m of f.metrics) {
    const labels = new Map(m.labels);
    const add = (name: string, extra: Array<[string, string]>, value: number, ex?: Exemplar) => {
      const s: Sample = { name, labels: new Map([...labels, ...extra]), value };
      if (m.ts !== null) s.timestamp = m.ts;
      if (ex) s.exemplar = ex;
      samples.push(s);
    };
    if (type === 'counter') {
      add(f.name, [], parseNum(m.value!), exemplar(m.exemplar));
      if (m.created !== null) samples.push({ name: base + '_created', labels: new Map(labels), value: m.created / 1000 });
    } else if (type === 'gauge' || type === 'unknown') add(f.name, [], parseNum(m.value!));
    else if (type === 'summary') {
      for (const [q, v] of m.quantiles) add(f.name, [['quantile', q]], parseNum(v));
      if (m.sum !== null) add(f.name + '_sum', [], parseNum(m.sum));
      if (m.count !== null) add(f.name + '_count', [], parseNum(m.count));
      if (m.created !== null) samples.push({ name: f.name + '_created', labels: new Map(labels), value: m.created / 1000 });
    } else {
      for (const b of m.buckets) add(f.name + '_bucket', [['le', formatFloat(parseNum(b.ub))]], parseNum(b.count), exemplar(b.exemplar));
      if (m.sum !== null) add(f.name + '_sum', [], parseNum(m.sum));
      if (m.count !== null) add(f.name + '_count', [], parseNum(m.count));
      if (m.created !== null) samples.push({ name: f.name + '_created', labels: new Map(labels), value: m.created / 1000 });
    }
  }
  const fam: MetricFamily = { name: f.name, type, samples };
  if (f.help !== null) fam.help = f.help;
  if (f.unit !== null) fam.unit = f.unit;
  return fam;
}
