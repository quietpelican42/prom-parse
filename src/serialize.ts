/*
 * Serializers for the Prometheus text format 0.0.4 and OpenMetrics 1.0.
 *
 * The output follows text_create.go and openmetrics_create.go from
 * github.com/prometheus/common (expfmt), v0.72.0, byte for byte.
 *
 * Copyright 2014 The Prometheus Authors
 * Licensed under the Apache License, Version 2.0. See LICENSE-prometheus-common.
 */
import { SerializeError } from './errors.ts';
import { metrics } from './metrics.ts';
import { formatFloat, formatInt64, formatOpenMetricsFloat } from './numbers.ts';
import { isLegacyMetricName } from './prometheus.ts';
import type { Exemplar, Format, Labels, Metric, MetricFamily, SerializeOptions } from './types.ts';

function escapeString(v: string, quote: boolean): string {
  let out = v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
  if (quote) out = out.replace(/"/g, '\\"');
  return out;
}

function writeName(name: string): string {
  return isLegacyMetricName(name) ? name : `"${escapeString(name, true)}"`;
}

function uint(n: number | undefined): string {
  if (n === undefined || !(n >= 0)) return '0';
  if (n >= 2 ** 64) return '18446744073709551615';
  return BigInt(Math.trunc(n)).toString();
}

/** float64(UnixNano)/1e9 for a millisecond timestamp, with the same rounding as Go. */
function nanoSeconds(ms: number): number {
  if (!Number.isFinite(ms) || Math.abs(ms) > 9e15) return ms / 1000;
  return Number(BigInt(Math.round(ms * 1000)) * 1000n) / 1e9;
}

function nameAndLabels(
  name: string,
  labels: Labels,
  extraName: string,
  extraValue: string,
): string {
  let out = '';
  let sep = '{';
  let inside = false;
  if (name !== '') {
    if (!isLegacyMetricName(name)) {
      inside = true;
      out += sep;
      sep = ',';
    }
    out += writeName(name);
  }
  if (labels.size === 0 && extraName === '') return inside ? out + '}' : out;
  for (const [k, v] of labels) {
    out += `${sep}${writeName(k)}="${escapeString(v, true)}"`;
    sep = ',';
  }
  if (extraName !== '') out += `${sep}${extraName}="${extraValue}"`;
  return out + '}';
}

function requireNamed(f: MetricFamily): void {
  if (f.name === '') throw new SerializeError('MetricFamily has no name');
}

function textType(f: MetricFamily): string {
  switch (f.type) {
    case 'counter': return 'counter';
    case 'gauge': case 'info': case 'stateset': return 'gauge';
    case 'summary': return 'summary';
    case 'unknown': return 'untyped';
    case 'histogram': case 'gaugehistogram': return 'histogram';
    default: throw new SerializeError(`unknown metric type ${String(f.type)}`);
  }
}

function scalarName(f: MetricFamily): string {
  return f.type === 'info' ? f.name + '_info' : f.name;
}

function familyToText(f: MetricFamily): string {
  requireNamed(f);
  const ms = metrics(f);
  if (ms.length === 0) throw new SerializeError(`MetricFamily has no metrics: ${f.name}`);
  const name = scalarName(f);
  let out = '';
  if (f.help !== undefined) out += `# HELP ${writeName(name)} ${escapeString(f.help, false)}\n`;
  out += `# TYPE ${writeName(name)} ${textType(f)}\n`;
  const line = (suffix: string, m: Metric, extraName: string, extraValue: number, value: number): string => {
    let s = nameAndLabels(name + suffix, m.labels, extraName, extraName ? formatFloat(extraValue) : '');
    s += ' ' + formatFloat(value);
    if (m.timestamp !== undefined) s += ' ' + formatInt64(m.timestamp);
    return s + '\n';
  };
  for (const m of ms) {
    if (f.type === 'summary') {
      for (const q of m.quantiles ?? []) out += line('', m, 'quantile', q.quantile, q.value);
      out += line('_sum', m, '', 0, m.sum ?? 0);
      out += line('_count', m, '', 0, Number(uint(m.count)));
    } else if (f.type === 'histogram' || f.type === 'gaugehistogram') {
      let infSeen = false;
      for (const b of m.buckets ?? []) {
        out += line('_bucket', m, 'le', b.upperBound, b.count);
        if (b.upperBound === Infinity) infSeen = true;
      }
      if (!infSeen) out += line('_bucket', m, 'le', Infinity, m.count ?? 0);
      out += line('_sum', m, '', 0, m.sum ?? 0);
      out += line('_count', m, '', 0, m.count ?? 0);
    } else {
      out += line('', m, '', 0, m.value ?? 0);
    }
  }
  return out;
}

function exemplarText(e: Exemplar): string {
  let s = ' # ' + nameAndLabels('', e.labels, '', '') + ' ' + formatOpenMetricsFloat(e.value);
  if (e.timestamp !== undefined) s += ' ' + formatOpenMetricsFloat(nanoSeconds(e.timestamp));
  return s;
}

function familyToOpenMetrics(f: MetricFamily, opts: SerializeOptions): string {
  requireNamed(f);
  const ms = metrics(f);
  const name = f.name;
  let compliant = name;
  if (f.type === 'counter' && name.endsWith('_total')) compliant = name.slice(0, -6);
  let out = '';
  if (f.help !== undefined) out += `# HELP ${writeName(compliant)} ${escapeString(f.help, true)}\n`;
  out += `# TYPE ${writeName(compliant)} `;
  switch (f.type) {
    case 'counter': out += name.endsWith('_total') ? 'counter\n' : 'unknown\n'; break;
    case 'gauge': out += 'gauge\n'; break;
    case 'summary': out += 'summary\n'; break;
    case 'unknown': out += 'unknown\n'; break;
    case 'histogram': out += 'histogram\n'; break;
    case 'gaugehistogram': out += 'gaugehistogram\n'; break;
    case 'info': out += 'info\n'; break;
    case 'stateset': out += 'stateset\n'; break;
    default: throw new SerializeError(`unknown metric type ${String(f.type)}`);
  }
  if (f.unit !== undefined) out += `# UNIT ${writeName(compliant)} ${escapeString(f.unit, true)}\n`;
  const sampleName = f.type === 'counter' && name.endsWith('_total') ? compliant + '_total' : f.type === 'info' ? compliant + '_info' : compliant;
  const line = (
    suffix: string,
    m: Metric,
    extraName: string,
    extraValue: number,
    value: string,
    exemplar: Exemplar | undefined,
  ): string => {
    let s = nameAndLabels(sampleName + suffix, m.labels, extraName, extraName ? formatOpenMetricsFloat(extraValue) : '');
    s += ' ' + value;
    if (m.timestamp !== undefined) s += ' ' + formatOpenMetricsFloat(m.timestamp / 1000);
    if (exemplar && exemplar.labels.size > 0) s += exemplarText(exemplar);
    return s + '\n';
  };
  const created = (base: string, m: Metric): string => {
    if (!opts.createdLines || m.created === undefined) return '';
    return `${nameAndLabels(base + '_created', m.labels, '', '')} ${formatOpenMetricsFloat(nanoSeconds(m.created))}\n`;
  };
  const intCount = (n: number | undefined): string => {
    if (n !== undefined && !Number.isInteger(n)) {
      throw new SerializeError(`OpenMetrics v1.0 does not support float histogram ${sampleName}`);
    }
    return uint(n);
  };
  for (const m of ms) {
    if (f.type === 'counter') {
      out += line('', m, '', 0, formatOpenMetricsFloat(m.value ?? 0), m.exemplar);
      out += created(sampleName.endsWith('_total') ? sampleName.slice(0, -6) : sampleName, m);
    } else if (f.type === 'summary') {
      for (const q of m.quantiles ?? []) out += line('', m, 'quantile', q.quantile, formatOpenMetricsFloat(q.value), undefined);
      out += line('_sum', m, '', 0, formatOpenMetricsFloat(m.sum ?? 0), undefined);
      out += line('_count', m, '', 0, uint(m.count), undefined);
      out += created(sampleName, m);
    } else if (f.type === 'histogram' || f.type === 'gaugehistogram') {
      let infSeen = false;
      for (const b of m.buckets ?? []) {
        out += line('_bucket', m, 'le', b.upperBound, intCount(b.count), b.exemplar);
        if (b.upperBound === Infinity) infSeen = true;
      }
      if (!infSeen) out += line('_bucket', m, 'le', Infinity, intCount(m.count), undefined);
      out += line('_sum', m, '', 0, formatOpenMetricsFloat(m.sum ?? 0), undefined);
      out += line('_count', m, '', 0, intCount(m.count), undefined);
      out += created(sampleName, m);
    } else {
      out += line('', m, '', 0, formatOpenMetricsFloat(m.value ?? 0), undefined);
    }
  }
  return out;
}

/**
 * Write metric families as Prometheus text (0.0.4) or OpenMetrics 1.0, in the
 * order given, matching expfmt's `MetricFamilyToText` and
 * `MetricFamilyToOpenMetrics` byte for byte. Throws `SerializeError` where
 * expfmt returns an error.
 */
export function serialize(families: MetricFamily[], format: Format, options: SerializeOptions = {}): string {
  let out = '';
  if (format === 'prometheus') {
    for (const f of families) out += familyToText(f);
    return out;
  }
  if (format !== 'openmetrics') throw new TypeError(`unknown format: ${String(format)}`);
  for (const f of families) out += familyToOpenMetrics(f, options);
  if (options.eof !== false) out += '# EOF\n';
  return out;
}
