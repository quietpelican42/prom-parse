/*
 * Parser for OpenMetrics 1.0 text. Written from the specification and checked
 * against the official parser test suite; it is not derived from another
 * implementation.
 */
import { ParseError } from './errors.ts';
import { isDecimal, parseGoFloat, secondsToMs } from './numbers.ts';
import type { Exemplar, Labels, MetricFamily, MetricType, Sample } from './types.ts';

const LEGACY_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LEGACY_LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const LABEL_START = /[a-zA-Z_][a-zA-Z0-9_]*/y;
const META = /^# (HELP|TYPE|UNIT) ("(?:[^"\\]|\\[\s\S])*"|[^ ]+) ([\s\S]*)$/;

const TYPES = new Set<string>(['counter', 'gauge', 'histogram', 'gaugehistogram', 'stateset', 'info', 'summary', 'unknown']);

const SUFFIXES: Record<string, string[]> = {
  counter: ['_total', '_created'],
  summary: ['', '_count', '_sum', '_created'],
  histogram: ['_count', '_sum', '_bucket', '_created'],
  gaugehistogram: ['_gcount', '_gsum', '_bucket'],
  info: ['_info'],
};

function unescape(s: string): string {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = s[i + 1];
    if (n === undefined) out += '\\';
    else if (n === '\\' || n === '"') {
      out += n;
      i++;
    } else if (n === 'n') {
      out += '\n';
      i++;
    } else out += '\\';
  }
  return out;
}

function unquote(raw: string): string {
  return unescape(raw.slice(1, -1));
}

interface Fam {
  spec: string;
  type?: MetricType;
  help?: string;
  unit?: string;
  samples: Sample[];
  allowed: Set<string>;
  lastLine: number;
  // Grouping state.
  group?: string;
  groupTs?: number | undefined;
  seenGroups: Set<string>;
}

class Fail extends Error {
  constructor(message: string) {
    super(message);
  }
}

function fail(msg: string): never {
  throw new Fail(msg);
}

interface Cursor {
  s: string;
  i: number;
}

function readQuoted(c: Cursor): string {
  // c.s[c.i] === '"'
  const start = c.i;
  c.i++;
  for (;;) {
    const ch = c.s[c.i];
    if (ch === undefined) fail('unterminated quoted string');
    if (ch === '\\') {
      if (c.s[c.i + 1] === undefined) fail('unterminated quoted string');
      c.i += 2;
      continue;
    }
    c.i++;
    if (ch === '"') break;
  }
  return unescape(c.s.slice(start + 1, c.i - 1));
}

interface LabelSet {
  labels: Labels;
  name?: string;
}

function readLabelSet(c: Cursor, allowName: boolean): LabelSet {
  // c.s[c.i] === '{'
  c.i++;
  const labels: Labels = new Map();
  let name: string | undefined;
  if (c.s[c.i] === '}') {
    c.i++;
    return { labels };
  }
  let first = true;
  for (;;) {
    let key: string;
    if (c.s[c.i] === '"') {
      const q = readQuoted(c);
      if (c.s[c.i] === '=') {
        key = q;
      } else if (allowName && first && (c.s[c.i] === ',' || c.s[c.i] === '}')) {
        if (q === '') fail('empty metric name');
        name = q;
        if (c.s[c.i] === '}') {
          c.i++;
          return { labels, name };
        }
        c.i++;
        first = false;
        continue;
      } else fail('expected "=" after label name');
      if (key === '') fail('empty label name');
    } else {
      LABEL_START.lastIndex = c.i;
      const m = LABEL_START.exec(c.s);
      if (!m) fail('invalid label name');
      key = m[0];
      c.i += key.length;
      if (c.s[c.i] !== '=') fail('expected "=" after label name');
    }
    c.i++; // '='
    if (c.s[c.i] !== '"') fail('expected \'"\' at start of label value');
    const value = readQuoted(c);
    if (key === '__name__') fail('label name "__name__" is reserved');
    if (labels.has(key)) fail(`duplicate label names: ${key}`);
    labels.set(key, value);
    first = false;
    const ch = c.s[c.i];
    if (ch === ',') {
      c.i++;
      continue;
    }
    if (ch === '}') {
      c.i++;
      return { labels, name };
    }
    fail('expected "," or "}" after label value');
  }
}

function readToken(c: Cursor): string {
  const start = c.i;
  while (c.i < c.s.length && c.s[c.i] !== ' ') c.i++;
  return c.s.slice(start, c.i);
}

function labelLength(labels: Labels): number {
  let n = 0;
  for (const [k, v] of labels) n += [...k].length + [...v].length;
  return n;
}

function parseSample(line: string): Sample {
  const c: Cursor = { s: line, i: 0 };
  let name: string;
  let labels: Labels = new Map();
  if (line[0] === '{') {
    const ls = readLabelSet(c, true);
    if (ls.name === undefined) fail('metric name missing');
    name = ls.name;
    labels = ls.labels;
  } else {
    const m = /^[a-zA-Z_:][a-zA-Z0-9_:]*/.exec(line);
    if (!m) fail('invalid metric name');
    name = m[0];
    c.i = name.length;
    if (line[c.i] === '{') {
      const ls = readLabelSet(c, false);
      labels = ls.labels;
    }
  }
  if (line[c.i] !== ' ') fail('expected space before value');
  c.i++;
  const valueTok = readToken(c);
  const value = parseGoFloat(valueTok);
  if (value === undefined) fail(`expected float as value, got "${valueTok}"`);
  const sample: Sample = { name, labels, value };
  if (c.i >= line.length) return sample;
  c.i++; // space
  if (line[c.i] !== '#') {
    const tsTok = readToken(c);
    if (!isDecimal(tsTok)) fail(`invalid timestamp "${tsTok}"`);
    sample.timestamp = secondsToMs(tsTok);
    if (c.i >= line.length) return sample;
    c.i++;
    if (line[c.i] !== '#') fail('unexpected text after timestamp');
  }
  // Exemplar: "# " already positioned at '#'.
  if (line[c.i + 1] !== ' ') fail('expected space after "#" in exemplar');
  c.i += 2;
  if (line[c.i] !== '{') fail('expected "{" at start of exemplar');
  const ex = readLabelSet(c, false);
  if (labelLength(ex.labels) > 128) fail('exemplar labels are too long');
  if (line[c.i] !== ' ') fail('expected space before exemplar value');
  c.i++;
  const exTok = readToken(c);
  const exValue = parseGoFloat(exTok);
  if (exValue === undefined) fail(`invalid exemplar value "${exTok}"`);
  const exemplar: Exemplar = { labels: ex.labels, value: exValue };
  if (c.i < line.length) {
    c.i++;
    const ets = readToken(c);
    if (!isDecimal(ets)) fail(`invalid exemplar timestamp "${ets}"`);
    exemplar.timestamp = secondsToMs(ets);
    if (c.i < line.length) fail('unexpected text after exemplar');
  }
  sample.exemplar = exemplar;
  return sample;
}

function groupOf(f: Fam, type: MetricType, s: Sample): string {
  if (type === 'info') return '';
  let labels: Array<[string, string]> = [...s.labels];
  if (type === 'summary' && s.name === f.spec) labels = labels.filter(([k]) => k !== 'quantile');
  else if (type === 'stateset') labels = labels.filter(([k]) => k !== f.spec);
  else if ((type === 'histogram' || type === 'gaugehistogram') && s.name === f.spec + '_bucket')
    labels = labels.filter(([k]) => k !== 'le');
  labels.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(labels);
}

function checkHistogram(f: Fam, type: MetricType): void {
  let group: string | undefined;
  let timestamp: number | undefined;
  let count: number | undefined;
  let bucket: number | undefined;
  let hasNeg = false;
  let hasSum = false;
  let hasGsum = false;
  let hasNegGsum = false;
  let value = 0;
  let atPoint = new Set<string>();
  const done = () => {
    if (bucket !== Infinity) fail(`+Inf bucket missing: ${f.spec}`);
    if (count !== undefined && value !== count) fail(`Count does not match +Inf value: ${f.spec}`);
    if (hasSum && count === undefined) fail(`_count must be present if _sum is present: ${f.spec}`);
    if (hasGsum && count === undefined) fail(`_gcount must be present if _gsum is present: ${f.spec}`);
    if (!(hasSum || hasGsum) && count !== undefined) fail(`_sum/_gsum must be present if _count is present: ${f.spec}`);
    if (hasNeg && hasSum) fail(`Cannot have _sum with negative buckets: ${f.spec}`);
    if (!hasNeg && hasNegGsum) fail(`Cannot have negative _gsum with non-negative buckets: ${f.spec}`);
  };
  for (const s of f.samples) {
    const suffix = s.name.slice(f.spec.length);
    if (suffix === '' || suffix === '_created') continue;
    const g = groupOf(f, type, s);
    if (g !== group || s.timestamp !== timestamp) {
      if (group !== undefined) done();
      count = undefined;
      bucket = undefined;
      hasNeg = false;
      hasSum = false;
      hasGsum = false;
      hasNegGsum = false;
      value = 0;
      atPoint = new Set();
    }
    // The same series at the same timestamp again is a duplicate, not a new bucket.
    const id = s.name + JSON.stringify([...s.labels]);
    if (atPoint.has(id)) continue;
    atPoint.add(id);
    group = g;
    timestamp = s.timestamp;
    if (suffix === '_bucket') {
      const b = parseGoFloat(s.labels.get('le')!)!;
      if (b < 0) hasNeg = true;
      if (bucket !== undefined && b <= bucket) fail(`Buckets out of order: ${f.spec}`);
      if (s.value < value) fail(`Bucket values out of order: ${f.spec}`);
      bucket = b;
      value = s.value;
    } else if (suffix === '_count' || suffix === '_gcount') count = s.value;
    else if (suffix === '_sum') hasSum = true;
    else if (suffix === '_gsum') {
      hasGsum = true;
      if (s.value < 0) hasNegGsum = true;
    }
  }
  if (group !== undefined) done();
}

/** Parse OpenMetrics 1.0 text. `text` must already be valid UTF-8. Throws `ParseError`. */
export function parseOpenMetrics(text: string): MetricFamily[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const out: MetricFamily[] = [];
  const seenNames = new Set<string>();
  let cur: Fam | undefined;
  let lineNo = 0;
  let eof = false;

  const newFam = (spec: string): Fam => ({
    spec,
    samples: [],
    allowed: new Set([spec]),
    lastLine: lineNo,
    seenGroups: new Set(),
  });

  const finish = () => {
    const f = cur;
    if (!f) return;
    // Errors found while closing a family are reported at its last line.
    const at = lineNo;
    lineNo = f.lastLine;
    const type: MetricType = f.type ?? 'unknown';
    for (const suffix of new Set([...(SUFFIXES[type] ?? []), ''])) {
      if (seenNames.has(f.spec + suffix)) fail(`Clashing name: ${f.spec + suffix}`);
      seenNames.add(f.spec + suffix);
    }
    if (f.unit) {
      if (!f.spec.endsWith('_' + f.unit)) fail(`Unit does not match metric name: ${f.spec}`);
      if (type === 'info' || type === 'stateset') fail(`Units not allowed for this metric type: ${f.spec}`);
    }
    if (type === 'histogram' || type === 'gaugehistogram') checkHistogram(f, type);
    const fam: MetricFamily = {
      name: type === 'counter' ? f.spec + '_total' : f.spec,
      type,
      samples: f.samples,
    };
    if (f.help !== undefined) fam.help = f.help;
    if (f.unit) fam.unit = f.unit;
    out.push(fam);
    cur = undefined;
    lineNo = at;
  };

  try {
    for (const line of lines) {
      lineNo++;
      if (eof) fail('text after # EOF');
      if (line === '') fail('blank line');
      if (line === '# EOF') {
        eof = true;
        continue;
      }
      if (line[0] === '#') {
        const m = META.exec(line);
        if (!m) fail(`invalid line "${line}"`);
        const kind = m[1]!;
        const rawName = m[2]!;
        const rest = m[3]!;
        let name: string;
        if (rawName[0] === '"') {
          name = unquote(rawName);
          if (name === '') fail('empty metric name');
        } else {
          if (!LEGACY_NAME.test(rawName)) fail(`invalid metric name "${rawName}"`);
          name = rawName;
        }
        if (cur && cur.spec === name) {
          if (cur.samples.length > 0) fail(`metadata after samples: ${line}`);
        } else {
          finish();
          cur = newFam(name);
        }
        const f = cur!;
        f.lastLine = lineNo;
        if (kind === 'HELP') {
          if (f.help !== undefined) fail(`more than one HELP for metric ${name}`);
          f.help = unescape(rest);
        } else if (kind === 'TYPE') {
          if (f.type !== undefined) fail(`more than one TYPE for metric ${name}`);
          if (!TYPES.has(rest)) fail(`invalid TYPE "${rest}"`);
          f.type = rest as MetricType;
          f.allowed = new Set((SUFFIXES[rest] ?? ['']).map((x) => name + x));
        } else {
          if (f.unit !== undefined) fail(`more than one UNIT for metric ${name}`);
          f.unit = rest;
        }
        continue;
      }
      const s = parseSample(line);
      if (!cur || !cur.allowed.has(s.name)) {
        finish();
        cur = newFam(s.name);
        cur.type = 'unknown';
      }
      const f = cur;
      f.lastLine = lineNo;
      const type: MetricType = f.type ?? 'unknown';
      checkSample(f, type, s);
      const g = groupOf(f, type, s);
      if (f.group !== undefined && g !== f.group && f.seenGroups.has(g)) fail(`invalid metric grouping: ${line}`);
      const isCreated = s.name.endsWith('_created') && s.name !== f.spec;
      if (isCreated) {
        // `_created` values are never stamped, whatever the samples they accompany.
      } else if (f.group !== undefined && g === f.group) {
        if ((s.timestamp === undefined) !== (f.groupTs === undefined)) fail(`mix of timestamp presence within a group: ${line}`);
        if (f.groupTs !== undefined && s.timestamp !== undefined && f.groupTs > s.timestamp && type !== 'info')
          fail(`timestamps went backwards within a group: ${line}`);
      }
      if (!isCreated) {
        f.group = g;
        f.groupTs = s.timestamp;
        f.seenGroups.add(g);
      }
      f.samples.push(s);
    }
    lineNo = Math.max(lines.length, 1);
    if (!eof) fail('missing # EOF at end of input');
    finish();
  } catch (e) {
    if (e instanceof Fail) throw new ParseError(e.message, lineNo);
    throw e;
  }
  return out;
}

function checkSample(f: Fam, type: MetricType, s: Sample): void {
  const suffix = s.name.slice(f.spec.length);
  if (type === 'stateset' && !s.labels.has(f.spec)) fail('stateset sample missing state label');
  if (s.name === f.spec + '_bucket' && (type === 'histogram' || type === 'gaugehistogram')) {
    const le = s.labels.get('le');
    const b = le === undefined ? NaN : parseGoFloat(le);
    if (b === undefined || Number.isNaN(b) || (!Number.isFinite(b) && le !== '+Inf')) fail('invalid le label');
    if (!Number.isInteger(s.value)) fail('bucket value must be an integer');
  }
  if ((suffix === '_count' || suffix === '_gcount') && s.name === f.spec + suffix && !Number.isInteger(s.value))
    fail('count value must be an integer');
  if (type === 'summary' && s.name === f.spec) {
    const q = s.labels.get('quantile');
    const v = q === undefined ? undefined : parseGoFloat(q);
    if (v === undefined || !(v >= 0 && v <= 1)) fail('invalid quantile label');
    if (s.value < 0) fail('quantile values cannot be negative');
  }
  if (type === 'stateset' && s.value !== 0 && s.value !== 1) fail('stateset samples can only have values zero and one');
  if (type === 'info' && s.value !== 1) fail('info samples can only have value one');
  if (['_total', '_sum', '_count', '_bucket', '_gcount', '_gsum'].includes(suffix) && Number.isNaN(s.value))
    fail('counter-like samples cannot be NaN');
  if (['_total', '_sum', '_count', '_bucket', '_gcount'].includes(suffix) && s.value < 0)
    fail('counter-like samples cannot be negative');
  if (s.exemplar) {
    const ok =
      ((type === 'histogram' || type === 'gaugehistogram') && s.name === f.spec + '_bucket') ||
      (type === 'counter' && s.name === f.spec + '_total');
    if (!ok) fail('only histogram buckets and counters can have exemplars');
  }
}

export { LEGACY_LABEL };
