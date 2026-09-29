import { parseGoFloat, secondsToMs } from './numbers.ts';
import type { Bucket, Labels, Metric, MetricFamily, Quantile, Sample } from './types.ts';

function keyOf(labels: Labels, skip: string | undefined): string {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of labels) if (k !== skip) pairs.push([k, v]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(pairs);
}

function without(labels: Labels, skip: string): Labels {
  const out: Labels = new Map();
  for (const [k, v] of labels) if (k !== skip) out.set(k, v);
  return out;
}

function counterBase(name: string): string {
  return name.endsWith('_total') ? name.slice(0, -6) : name;
}

/**
 * Attach each sample of a family to its label set, the way expfmt's
 * `dto.Metric` does: histogram `_bucket`/`_sum`/`_count`/`_created` and
 * summary quantiles/`_sum`/`_count`/`_created` share one entry per label set
 * (`le` and `quantile` excluded), other types get one entry per sample.
 * Series that do not belong to the family's type (for example a bare `name`
 * sample in a histogram) are left out, as expfmt leaves them out.
 */
export function metrics(family: MetricFamily): Metric[] {
  const { name, type } = family;
  if (type === 'summary' || type === 'histogram' || type === 'gaugehistogram') return grouped(family);
  const out: Metric[] = [];
  const byKey = new Map<string, Metric>();
  const createdName = (type === 'counter' ? counterBase(name) : name) + '_created';
  const created: Sample[] = [];
  for (const s of family.samples) {
    if (type === 'counter' && s.name === createdName && s.name !== name) {
      created.push(s);
      continue;
    }
    const m: Metric = { labels: s.labels, value: s.value };
    if (s.timestamp !== undefined) m.timestamp = s.timestamp;
    if (s.exemplar) m.exemplar = s.exemplar;
    out.push(m);
    byKey.set(keyOf(s.labels, undefined), m);
  }
  for (const s of created) {
    const m = byKey.get(keyOf(s.labels, undefined));
    if (m) m.created = secondsToMs(s.value);
  }
  return out;
}

function grouped(family: MetricFamily): Metric[] {
  const floatCount = new Map<Metric, { f: number | undefined; i: number | undefined }>();
  const { name, type } = family;
  const isSummary = type === 'summary';
  const special = isSummary ? 'quantile' : 'le';
  const countName = type === 'gaugehistogram' ? [name + '_count', name + '_gcount'] : [name + '_count'];
  const sumName = type === 'gaugehistogram' ? [name + '_sum', name + '_gsum'] : [name + '_sum'];
  const out: Metric[] = [];
  const byKey = new Map<string, Metric>();
  for (const s of family.samples) {
    const isCreated = s.name === name + '_created';
    const isCount = countName.includes(s.name);
    const isSum = sumName.includes(s.name);
    const isBucket = isSummary ? s.name === name : s.name === name + '_bucket' || s.name === name;
    if (!isCreated && !isCount && !isSum && !isBucket) continue;
    const key = keyOf(s.labels, special);
    let m = byKey.get(key);
    if (!m) {
      m = { labels: without(s.labels, special) };
      byKey.set(key, m);
      out.push(m);
    }
    if (s.timestamp !== undefined) m.timestamp = s.timestamp;
    if (isCount) {
      // expfmt keeps integral and fractional counts in separate fields and
      // reports the fractional one when both were set.
      const v = s.value;
      const integral = v >= 0 && v < 2 ** 64 && Number.isInteger(v);
      const st = (floatCount.get(m) ?? { f: undefined, i: undefined });
      if (integral) st.i = v;
      else st.f = v;
      floatCount.set(m, st);
      m.count = st.f !== undefined ? st.f : st.i;
    } else if (isSum) m.sum = s.value;
    else if (isCreated) m.created = secondsToMs(s.value);
    else {
      const raw = s.labels.get(special);
      const v = raw === undefined ? NaN : (parseGoFloat(raw) ?? NaN);
      if (Number.isNaN(v)) continue;
      if (isSummary) {
        (m.quantiles ??= []).push({ quantile: v, value: s.value } satisfies Quantile);
      } else {
        const b: Bucket = { upperBound: v, count: s.value };
        if (s.exemplar) b.exemplar = s.exemplar;
        (m.buckets ??= []).push(b);
      }
    }
  }
  return out;
}
