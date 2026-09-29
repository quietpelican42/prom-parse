import { ParseError } from './errors.ts';
import { parseOpenMetrics } from './openmetrics.ts';
import { decodeStrict, parsePrometheus } from './prometheus.ts';
import type { Format, MetricFamily, ParseOptions } from './types.ts';

export { ParseError, SerializeError } from './errors.ts';
export type * from './types.ts';

const encoder = new TextEncoder();

const EOF_LINE = [0x23, 0x20, 0x45, 0x4f, 0x46]; // "# EOF"

/** True when a line of `bytes` is exactly `# EOF`. */
export function detectFormat(bytes: Uint8Array): Format {
  const n = bytes.length;
  for (let i = 0; i + 5 <= n; i++) {
    if (i !== 0 && bytes[i - 1] !== 0x0a) continue;
    let ok = true;
    for (let j = 0; j < 5; j++) if (bytes[i + j] !== EOF_LINE[j]) ok = false;
    if (ok && (i + 5 === n || bytes[i + 5] === 0x0a)) return 'openmetrics';
  }
  return 'prometheus';
}

function toBytes(input: string | Uint8Array): Uint8Array {
  return typeof input === 'string' ? encoder.encode(input) : input;
}

/**
 * Parse a Prometheus text (0.0.4) or OpenMetrics 1.0 exposition into metric
 * families, in the order they appear. Throws `ParseError` (with `line`) on
 * input that expfmt or the OpenMetrics rules reject.
 */
export function parse(input: string | Uint8Array, options: ParseOptions = {}): MetricFamily[] {
  const bytes = toBytes(input);
  let format = options.format ?? 'auto';
  if (format === 'auto') format = detectFormat(bytes);
  if (format === 'prometheus') return parsePrometheus(bytes, options.nameValidation ?? 'utf8');
  if (format !== 'openmetrics') throw new TypeError(`unknown format: ${String(format)}`);
  const text = decodeStrict(bytes);
  if (text === undefined) {
    let line = 1;
    let start = 0;
    for (let i = 0; i <= bytes.length; i++) {
      if (i === bytes.length || bytes[i] === 0x0a) {
        if (decodeStrict(bytes.subarray(start, i)) === undefined) throw new ParseError('invalid UTF-8', line);
        line++;
        start = i + 1;
      }
    }
    throw new ParseError('invalid UTF-8', 1);
  }
  return parseOpenMetrics(text);
}
export { metrics } from './metrics.ts';
export { serialize } from './serialize.ts';
