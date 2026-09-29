/*
 * Parser for the Prometheus text exposition format 0.0.4.
 *
 * The state machine follows text_parse.go from github.com/prometheus/common
 * (expfmt), v0.72.0, so that it accepts and rejects the same inputs with the
 * same line numbers and messages.
 *
 * Copyright 2014 The Prometheus Authors
 * Licensed under the Apache License, Version 2.0. See LICENSE-prometheus-common.
 */
import { ParseError } from './errors.ts';
import { parseGoFloat, parseGoInt64 } from './numbers.ts';
import type { Labels, MetricFamily, MetricType, Sample } from './types.ts';

const BLANK = 0x20;
const TAB = 0x09;
const NL = 0x0a;

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const utf8Lossy = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

/** Decode bytes as UTF-8, or return undefined if they are not valid UTF-8. */
export function decodeStrict(b: number[] | Uint8Array): string | undefined {
  try {
    return utf8.decode(b instanceof Uint8Array ? b : Uint8Array.from(b));
  } catch {
    return undefined;
  }
}

function decodeLossy(b: number[]): string {
  return utf8Lossy.decode(Uint8Array.from(b));
}

const EOF = Symbol('eof');

interface Fam {
  name: string;
  type?: MetricType;
  help?: string;
  samples: Sample[];
}

type State = (() => State) | null;

type Scheme = 'utf8' | 'legacy';

function isBlankOrTab(b: number): boolean {
  return b === BLANK || b === TAB;
}

function isLetterOrUnderscore(b: number): boolean {
  return (b >= 0x61 && b <= 0x7a) || (b >= 0x41 && b <= 0x5a) || b === 0x5f;
}

function isValidLabelNameStart(b: number): boolean {
  return isLetterOrUnderscore(b) || b === 0x22;
}

function isValidLabelNameContinuation(b: number, quoted: boolean): boolean {
  // Go: `quoted && utf8.ValidString(string(b))` where b is a byte, so it is
  // always true for a quoted name.
  return isValidLabelNameStart(b) || (b >= 0x30 && b <= 0x39) || quoted;
}

function isValidMetricNameStart(b: number): boolean {
  return isValidLabelNameStart(b) || b === 0x3a;
}

function isValidMetricNameContinuation(b: number, quoted: boolean): boolean {
  return isValidLabelNameContinuation(b, quoted) || b === 0x3a;
}

function endsWith(name: string, suffix: string): boolean {
  return name.length > suffix.length && name.endsWith(suffix);
}

function summaryMetricName(name: string): string {
  if (endsWith(name, '_count')) return name.slice(0, -6);
  if (endsWith(name, '_sum')) return name.slice(0, -4);
  return name;
}

function histogramMetricName(name: string): string {
  if (endsWith(name, '_count')) return name.slice(0, -6);
  if (endsWith(name, '_sum')) return name.slice(0, -4);
  if (endsWith(name, '_bucket')) return name.slice(0, -7);
  return name;
}

const LEGACY_METRIC = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LEGACY_LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function isLegacyMetricName(s: string): boolean {
  return LEGACY_METRIC.test(s);
}

export function isLegacyLabelName(s: string): boolean {
  return LEGACY_LABEL.test(s);
}

const TYPES: Record<string, MetricType> = {
  COUNTER: 'counter',
  GAUGE: 'gauge',
  SUMMARY: 'summary',
  UNTYPED: 'unknown',
  HISTOGRAM: 'histogram',
  GAUGE_HISTOGRAM: 'gaugehistogram',
  GAUGEHISTOGRAM: 'gaugehistogram',
};

class TextParser {
  private readonly buf: Uint8Array;
  private pos = 0;
  private err: null | typeof EOF | ParseError = null;
  private lineCount = 0;
  private currentByte = 0;
  private token: number[] = [];
  private readonly scheme: Scheme;

  private readonly families = new Map<string, Fam>();
  private currentMF: Fam | undefined;
  private currentName = '';

  // Go's GetType/GetName on a nil or untyped family give COUNTER and "".
  private mfType(): MetricType {
    return this.currentMF?.type ?? 'counter';
  }

  private mfName(): string {
    return this.currentMF?.name ?? '';
  }

  private hasMetric = false;
  private currentLabelPairs: Array<[string, string]> = [];
  private allLabels: Array<[string, string]> = [];
  private currentLabelName = '';
  private currentSample: Sample | null = null;

  // Summaries and histograms.
  private currentLabels = new Map<string, string>();
  private summaries = new Set<string>();
  private histograms = new Set<string>();
  private currentQuantile = NaN;
  private currentBucket = NaN;
  private isSummaryCount = false;
  private isSummarySum = false;
  private isHistogramCount = false;
  private isHistogramSum = false;
  private metricIsInsideBraces = false;
  private metricInsideBracesIsPresent = false;

  constructor(buf: Uint8Array, scheme: Scheme) {
    this.buf = buf;
    this.scheme = scheme;
  }

  run(): MetricFamily[] {
    let next: State = () => this.startOfLine();
    while (next !== null) next = next();
    if (this.err === EOF) this.parseError('unexpected end of input stream');
    if (this.err !== null && this.err !== EOF) throw this.err;
    const out: MetricFamily[] = [];
    for (const f of this.families.values()) {
      if (f.samples.length === 0) continue;
      const fam: MetricFamily = { name: f.name, type: f.type ?? 'unknown', samples: f.samples };
      if (f.help !== undefined) fam.help = f.help;
      out.push(fam);
    }
    return out;
  }

  private cb(): number {
    return this.currentByte;
  }

  private readByte(): void {
    if (this.pos >= this.buf.length) {
      this.currentByte = 0;
      this.err = EOF;
      return;
    }
    this.currentByte = this.buf[this.pos++]!;
  }

  private parseError(msg: string): void {
    this.err = new ParseError(msg, this.lineCount);
  }

  private quote(bytes: number[]): string {
    return goQuoteBytes(bytes);
  }

  private qTok(): string {
    return goQuoteBytes(this.token);
  }

  private tokenString(): string {
    return decodeLossy(this.token);
  }

  private skipBlankTab(): void {
    for (;;) {
      this.readByte();
      if (this.err !== null || !isBlankOrTab(this.currentByte)) return;
    }
  }

  private skipBlankTabIfCurrentBlankTab(): void {
    if (isBlankOrTab(this.currentByte)) this.skipBlankTab();
  }

  private readTokenUntilWhitespace(): void {
    this.token = [];
    while (this.err === null && !isBlankOrTab(this.currentByte) && this.currentByte !== NL) {
      this.token.push(this.currentByte);
      this.readByte();
    }
  }

  private readTokenUntilNewline(recognizeEscapeSequence: boolean): void {
    this.token = [];
    let escaped = false;
    while (this.err === null) {
      if (recognizeEscapeSequence && escaped) {
        switch (this.currentByte) {
          case 0x5c:
            this.token.push(0x5c);
            break;
          case 0x6e:
            this.token.push(NL);
            break;
          case 0x22:
            this.token.push(0x22);
            break;
          default:
            this.parseError(`invalid escape sequence '\\${goChar(this.currentByte)}'`);
            return;
        }
        escaped = false;
      } else {
        switch (this.currentByte) {
          case NL:
            return;
          case 0x5c:
            escaped = true;
            break;
          default:
            this.token.push(this.currentByte);
        }
      }
      this.readByte();
    }
  }

  private readTokenAsName(kind: 'metric' | 'label'): void {
    this.token = [];
    let quoted = false;
    let escaped = false;
    const start = kind === 'metric' ? isValidMetricNameStart : isValidLabelNameStart;
    const cont = kind === 'metric' ? isValidMetricNameContinuation : isValidLabelNameContinuation;
    if (!start(this.currentByte)) return;
    while (this.err === null) {
      if (escaped) {
        switch (this.currentByte) {
          case 0x5c:
            this.token.push(0x5c);
            break;
          case 0x6e:
            this.token.push(NL);
            break;
          case 0x22:
            this.token.push(0x22);
            break;
          default:
            this.parseError(`invalid escape sequence '\\${goChar(this.currentByte)}'`);
            return;
        }
        escaped = false;
      } else {
        switch (this.currentByte) {
          case 0x22:
            quoted = !quoted;
            if (!quoted) {
              this.readByte();
              return;
            }
            break;
          case NL:
            this.parseError(`${kind} name ${this.quote(this.token)} contains unescaped new-line`);
            return;
          case 0x5c:
            escaped = true;
            break;
          default:
            this.token.push(this.currentByte);
        }
      }
      this.readByte();
      if (!cont(this.currentByte, quoted) || (!quoted && this.currentByte === (kind === 'metric' ? BLANK : 0x3d))) return;
    }
  }

  private readTokenAsLabelValue(): void {
    this.token = [];
    let escaped = false;
    for (;;) {
      this.readByte();
      if (this.err !== null) return;
      if (escaped) {
        switch (this.currentByte) {
          case 0x22:
          case 0x5c:
            this.token.push(this.currentByte);
            break;
          case 0x6e:
            this.token.push(NL);
            break;
          default:
            this.parseError(`invalid escape sequence '\\${goChar(this.currentByte)}'`);
            this.currentLabelPairs = [];
            return;
        }
        escaped = false;
        continue;
      }
      switch (this.currentByte) {
        case 0x22:
          return;
        case NL:
          this.parseError(`label value ${this.quote(this.token)} contains unescaped new-line`);
          return;
        case 0x5c:
          escaped = true;
          break;
        default:
          this.token.push(this.currentByte);
      }
    }
  }

  private validName(kind: 'metric' | 'label', bytes: number[]): boolean {
    if (bytes.length === 0) return false;
    if (this.scheme === 'legacy') {
      for (const b of bytes) if (b >= 0x80) return false;
      const s = String.fromCharCode(...bytes);
      return kind === 'metric' ? isLegacyMetricName(s) : isLegacyLabelName(s);
    }
    return decodeStrict(bytes) !== undefined;
  }

  private startOfLine(): State {
    this.lineCount++;
    this.hasMetric = false;
    this.currentSample = null;
    this.metricIsInsideBraces = false;
    this.metricInsideBracesIsPresent = false;
    this.allLabels = [];
    this.skipBlankTab();
    if (this.err !== null) {
      // The only place where EOF is legitimate.
      if (this.err === EOF) this.err = null;
      return null;
    }
    switch (this.currentByte) {
      case 0x23:
        return () => this.startComment();
      case NL:
        return () => this.startOfLine();
      case 0x7b:
        this.metricIsInsideBraces = true;
        return () => this.readingLabels();
    }
    return () => this.readingMetricName();
  }

  private startComment(): State {
    this.skipBlankTab();
    if (this.err !== null) return null;
    if (this.currentByte === NL) return () => this.startOfLine();
    this.readTokenUntilWhitespace();
    if (this.err !== null) return null;
    if (this.currentByte === NL) return () => this.startOfLine();
    const keyword = this.tokenString();
    if (keyword !== 'HELP' && keyword !== 'TYPE') {
      while (this.currentByte !== NL) {
        this.readByte();
        if (this.err !== null) return null;
      }
      return () => this.startOfLine();
    }
    this.skipBlankTab();
    if (this.err !== null) return null;
    this.readTokenAsName('metric');
    if (this.err !== null) return null;
    if (this.currentByte === NL) return () => this.startOfLine();
    if (!isBlankOrTab(this.currentByte)) {
      this.parseError('invalid metric name in comment');
      return null;
    }
    this.setOrCreateCurrentMF();
    if (this.err !== null) return null;
    this.skipBlankTab();
    if (this.err !== null) return null;
    if (this.currentByte === NL) return () => this.startOfLine();
    return keyword === 'HELP' ? () => this.readingHelp() : () => this.readingType();
  }

  private readingMetricName(): State {
    this.readTokenAsName('metric');
    if (this.err !== null) return null;
    if (this.token.length === 0) {
      this.parseError('invalid metric name');
      return null;
    }
    this.setOrCreateCurrentMF();
    if (this.err !== null) return null;
    if (this.currentMF!.type === undefined) this.currentMF!.type = 'unknown';
    this.hasMetric = true;
    this.newSample();
    this.skipBlankTabIfCurrentBlankTab();
    if (this.err !== null) return null;
    return () => this.readingLabels();
  }

  private newSample(): void {
    this.currentSample = { name: this.currentName, labels: new Map(), value: NaN };
  }

  private readingLabels(): State {
    const t = this.mfType();
    if (t === 'summary' || t === 'histogram' || t === 'gaugehistogram') {
      this.currentLabels = new Map([['__name__', this.mfName()]]);
      this.currentQuantile = NaN;
      this.currentBucket = NaN;
    }
    if (this.currentByte !== 0x7b) return () => this.readingValue();
    return () => this.startLabelName();
  }

  private flushLabels(): void {
    if (this.currentSample) {
      for (const [k, v] of this.allLabels) this.currentSample.labels.set(k, v);
    }
    this.allLabels = [];
  }

  private startLabelName(): State {
    this.skipBlankTab();
    if (this.err !== null) return null;
    if (this.currentByte === 0x7d) {
      if (!this.hasMetric) {
        this.parseError('invalid metric name');
        this.currentLabelPairs = [];
        return null;
      }
      this.flushLabels();
      this.currentLabelPairs = [];
      this.skipBlankTab();
      if (this.err !== null) return null;
      return () => this.readingValue();
    }
    this.readTokenAsName('label');
    if (this.err !== null) return null;
    if (this.token.length === 0) {
      this.parseError(`invalid label name for metric ${goQuote(this.mfName())}`);
      return null;
    }
    this.skipBlankTabIfCurrentBlankTab();
    if (this.err !== null) return null;
    if (this.currentByte !== 0x3d) {
      if (this.metricIsInsideBraces) {
        if (this.metricInsideBracesIsPresent) {
          this.parseError(`multiple metric names for metric ${goQuote(this.mfName())}`);
          return null;
        }
        switch (this.currentByte) {
          case 0x2c:
            this.setOrCreateCurrentMF();
            if (this.err !== null) return null;
            if (this.currentMF!.type === undefined) this.currentMF!.type = 'unknown';
            this.hasMetric = true;
            this.newSample();
            this.metricInsideBracesIsPresent = true;
            return () => this.startLabelName();
          case 0x7d:
            this.setOrCreateCurrentMF();
            if (this.err !== null) {
              this.currentLabelPairs = [];
              return null;
            }
            if (this.currentMF!.type === undefined) this.currentMF!.type = 'unknown';
            this.hasMetric = true;
            this.newSample();
            this.flushLabels();
            this.currentLabelPairs = [];
            this.skipBlankTab();
            if (this.err !== null) return null;
            return () => this.readingValue();
          default:
            this.parseError(`unexpected end of metric name ${goQuoteByte(this.currentByte)}`);
            return null;
        }
      }
      this.parseError(`expected '=' after label name, found ${goQuoteByte(this.currentByte)}`);
      this.currentLabelPairs = [];
      return null;
    }
    const nameBytes = this.token;
    const name = this.tokenString();
    this.currentLabelName = name;
    if (name === '__name__') {
      this.parseError('label name "__name__" is reserved');
      this.currentLabelPairs = [];
      return null;
    }
    if (!this.validName('label', nameBytes)) {
      this.parseError(`invalid label name ${this.qTok()}`);
      this.currentLabelPairs = [];
      return null;
    }
    const t = this.mfType();
    const skip =
      (t === 'summary' && name === 'quantile') || ((t === 'histogram' || t === 'gaugehistogram') && name === 'le');
    if (!skip) this.currentLabelPairs.push([name, '']);
    const seen = new Set<string>();
    for (const [n] of this.currentLabelPairs) {
      if (seen.has(n)) {
        this.parseError(`duplicate label names for metric ${goQuote(this.mfName())}`);
        this.currentLabelPairs = [];
        return null;
      }
      seen.add(n);
    }
    return () => this.startLabelValue();
  }

  private startLabelValue(): State {
    this.skipBlankTab();
    if (this.err !== null) return null;
    if (this.currentByte !== 0x22) {
      this.parseError(`expected '"' at start of label value, found ${goQuoteByte(this.currentByte)}`);
      return null;
    }
    this.readTokenAsLabelValue();
    if (this.err !== null) return null;
    const value = decodeStrict(this.token);
    if (value === undefined) {
      this.parseError(`invalid label value ${this.quote(this.token)}`);
      return null;
    }
    const name = this.currentLabelName;
    const last = this.currentLabelPairs[this.currentLabelPairs.length - 1];
    if (last && last[0] === name && last[1] === '') last[1] = value;
    this.allLabels.push([name, value]);
    const t = this.mfType();
    if (t === 'summary') {
      if (name === 'quantile') {
        const q = parseGoFloat(value);
        if (q === undefined) {
          this.parseError(`expected float as value for 'quantile' label, got ${goQuote(value)}`);
          this.currentLabelPairs = [];
          return null;
        }
        this.currentQuantile = q;
      } else {
        this.currentLabels.set(name, value);
      }
    }
    if (t === 'histogram' || t === 'gaugehistogram') {
      if (name === 'le') {
        const b = parseGoFloat(value);
        if (b === undefined) {
          this.parseError(`expected float as value for 'le' label, got ${goQuote(value)}`);
          return null;
        }
        this.currentBucket = b;
      } else {
        this.currentLabels.set(name, value);
      }
    }
    this.skipBlankTab();
    if (this.err !== null) return null;
    switch (this.cb()) {
      case 0x2c:
        return () => this.startLabelName();
      case 0x7d:
        if (!this.hasMetric) {
          this.parseError('invalid metric name');
          return null;
        }
        this.flushLabels();
        this.currentLabelPairs = [];
        this.skipBlankTab();
        if (this.err !== null) return null;
        return () => this.readingValue();
      default:
        this.parseError(`unexpected end of label value ${goQuote(value)}`);
        this.currentLabelPairs = [];
        return null;
    }
  }

  private readingValue(): State {
    const mf = this.currentMF!;
    const sample = this.currentSample!;
    // Labels of a line without braces are empty; labels with braces were flushed already.
    this.flushLabels();
    mf.samples.push(sample);
    this.readTokenUntilWhitespace();
    if (this.err !== null) return null;
    const tok = this.tokenString();
    const value = parseGoFloat(tok);
    const bad = value === undefined || /[pP_]/.test(tok);
    if (bad) {
      this.parseError(`expected float as value, got ${this.qTok()}`);
      return null;
    }
    sample.value = value;
    if (mf.type === 'histogram' || mf.type === 'gaugehistogram') {
      const counted = this.isHistogramCount || (!this.isHistogramSum && !Number.isNaN(this.currentBucket));
      if (counted && value < 0) {
        this.parseError(
          `negative ${this.isHistogramCount ? 'count' : 'bucket population'} for histogram ${goQuote(mf.name)}`,
        );
        return null;
      }
    }
    if (this.currentByte === NL) return () => this.startOfLine();
    return () => this.startTimestamp();
  }

  private startTimestamp(): State {
    this.skipBlankTab();
    if (this.err !== null) return null;
    this.readTokenUntilWhitespace();
    if (this.err !== null) return null;
    const tok = this.tokenString();
    const ts = parseGoInt64(tok);
    if (ts === undefined) {
      this.parseError(`expected integer as timestamp, got ${this.qTok()}`);
      return null;
    }
    this.currentSample!.timestamp = ts;
    this.readTokenUntilNewline(false);
    if (this.err !== null) return null;
    if (this.token.length > 0) {
      this.parseError(`spurious string after timestamp: ${this.qTok()}`);
      return null;
    }
    return () => this.startOfLine();
  }

  private readingHelp(): State {
    if (this.currentMF!.help !== undefined) {
      this.parseError(`second HELP line for metric name ${goQuote(this.mfName())}`);
      return null;
    }
    this.readTokenUntilNewline(true);
    if (this.err !== null) return null;
    this.currentMF!.help = this.tokenString();
    return () => this.startOfLine();
  }

  private readingType(): State {
    if (this.currentMF!.type !== undefined) {
      this.parseError(
        `second TYPE line for metric name ${goQuote(this.mfName())}, or TYPE reported after samples`,
      );
      return null;
    }
    this.readTokenUntilNewline(false);
    if (this.err !== null) return null;
    const raw = this.tokenString();
    const t = TYPES[raw.toUpperCase()];
    if (t === undefined) {
      this.parseError(`unknown metric type ${this.qTok()}`);
      return null;
    }
    this.currentMF!.type = t;
    return () => this.startOfLine();
  }

  private setOrCreateCurrentMF(): void {
    this.isSummaryCount = false;
    this.isSummarySum = false;
    this.isHistogramCount = false;
    this.isHistogramSum = false;
    const nameBytes = this.token;
    const name = this.tokenString();
    if (!this.validName('metric', nameBytes)) {
      this.parseError(`invalid metric name ${this.qTok()}`);
      return;
    }
    this.currentName = name;
    let mf = this.families.get(name);
    if (mf) {
      this.currentMF = mf;
      return;
    }
    mf = this.families.get(summaryMetricName(name));
    if (mf && mf.type === 'summary') {
      this.currentMF = mf;
      if (endsWith(name, '_count')) this.isSummaryCount = true;
      if (endsWith(name, '_sum')) this.isSummarySum = true;
      return;
    }
    mf = this.families.get(histogramMetricName(name));
    if (mf && (mf.type === 'histogram' || mf.type === 'gaugehistogram')) {
      this.currentMF = mf;
      if (endsWith(name, '_count')) this.isHistogramCount = true;
      if (endsWith(name, '_sum')) this.isHistogramSum = true;
      return;
    }
    mf = { name, samples: [] };
    this.families.set(name, mf);
    this.currentMF = mf;
  }
}

function goChar(b: number): string {
  // Go formats the byte with %c, i.e. as the rune U+00XX.
  return String.fromCodePoint(b);
}

function goQuoteByte(b: number): string {
  // Go's %q on a byte is a quoted rune literal, e.g. 'x' or '\n'.
  if (b === 0x27) return "'\\''";
  if (b === 0x22) return "'\"'";
  return `'${quoteRune(b)}'`;
}

/** Parse Prometheus text exposition format 0.0.4. Throws `ParseError`. */
export function parsePrometheus(input: Uint8Array, scheme: Scheme): MetricFamily[] {
  return new TextParser(input, scheme).run();
}

export type { Labels };

const PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;

/** Go's `%q` for a byte string: valid UTF-8 as text, everything else as escapes. */
export function goQuoteBytes(b: ArrayLike<number>): string {
  let out = '"';
  for (let i = 0; i < b.length; ) {
    const c = b[i]!;
    let len = 0;
    let cp = 0;
    if (c < 0x80) {
      len = 1;
      cp = c;
    } else if (c >= 0xc2 && c <= 0xdf) {
      len = 2;
      cp = c & 0x1f;
    } else if (c >= 0xe0 && c <= 0xef) {
      len = 3;
      cp = c & 0x0f;
    } else if (c >= 0xf0 && c <= 0xf4) {
      len = 4;
      cp = c & 0x07;
    }
    let ok = len > 0 && i + len <= b.length;
    for (let k = 1; ok && k < len; k++) {
      const x = b[i + k]!;
      if ((x & 0xc0) !== 0x80) ok = false;
      cp = (cp << 6) | (x & 0x3f);
    }
    if (ok && len === 3 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) ok = false;
    if (ok && len === 4 && (cp < 0x10000 || cp > 0x10ffff)) ok = false;
    if (!ok) {
      out += '\\x' + c.toString(16).padStart(2, '0');
      i++;
      continue;
    }
    i += len;
    out += quoteRune(cp);
  }
  return out + '"';
}

function quoteRune(c: number): string {
  switch (c) {
    case 0x22: return '\\"';
    case 0x5c: return '\\\\';
    case 0x0a: return '\\n';
    case 0x09: return '\\t';
    case 0x0d: return '\\r';
    case 7: return '\\a';
    case 8: return '\\b';
    case 12: return '\\f';
    case 11: return '\\v';
  }
  if (c < 0x20 || c === 0x7f) return '\\x' + c.toString(16).padStart(2, '0');
  const ch = String.fromCodePoint(c);
  if (c === 0x20 || PRINTABLE.test(ch)) return ch;
  return c > 0xffff ? '\\U' + c.toString(16).padStart(8, '0') : '\\u' + c.toString(16).padStart(4, '0');
}

/** Go's `%q` for a string. */
export function goQuote(s: string): string {
  return goQuoteBytes(new TextEncoder().encode(s));
}
