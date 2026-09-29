/**
 * Number parsing and formatting with the semantics of Go's strconv, which is
 * what expfmt uses on the wire.
 */

const DECIMAL = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const INF = /^[+-]?(?:inf|infinity)$/i;
const NAN = /^nan$/i;
const INT = /^[+-]?[0-9]+$/;

/**
 * `strconv.ParseFloat(s, 64)` after expfmt's rejection of `p`, `P` and `_`.
 * Returns `undefined` where Go returns an error (including overflow to +-Inf,
 * which Go reports as ErrRange). Hex floats need a `p` exponent, so they are
 * always rejected.
 */
export function parseGoFloat(s: string): number | undefined {
  if (DECIMAL.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  if (INF.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (NAN.test(s)) return NaN;
  return undefined;
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** `strconv.ParseInt(s, 10, 64)`. The result is a double, so values beyond 2^53 lose precision. */
export function parseGoInt64(s: string): number | undefined {
  if (!INT.test(s)) return undefined;
  const b = BigInt(s);
  if (b < INT64_MIN || b > INT64_MAX) return undefined;
  return Number(b);
}

/** `strconv.FormatFloat(f, 'g', -1, 64)` for finite, non-zero `f`. */
function formatG(f: number): string {
  const neg = f < 0;
  const [mant, expStr] = Math.abs(f).toExponential().split('e') as [string, string];
  const digits = mant.replace('.', '');
  const exp = Number(expStr);
  let out: string;
  if (exp < -4 || exp >= 6) {
    out = digits[0]! + (digits.length > 1 ? '.' + digits.slice(1) : '');
    const ae = Math.abs(exp);
    out += 'e' + (exp < 0 ? '-' : '+') + (ae < 10 ? '0' + ae : String(ae));
  } else if (exp >= 0) {
    if (digits.length <= exp + 1) out = digits + '0'.repeat(exp + 1 - digits.length);
    else out = digits.slice(0, exp + 1) + '.' + digits.slice(exp + 1);
  } else {
    out = '0.' + '0'.repeat(-exp - 1) + digits;
  }
  return neg ? '-' + out : out;
}

/** expfmt `writeFloat`. */
export function formatFloat(f: number): string {
  if (f === 1) return '1';
  if (f === 0) return '0';
  if (f === -1) return '-1';
  if (Number.isNaN(f)) return 'NaN';
  if (f === Infinity) return '+Inf';
  if (f === -Infinity) return '-Inf';
  return formatG(f);
}

/** expfmt `writeOpenMetricsFloat`: like `formatFloat` but never a bare integer. */
export function formatOpenMetricsFloat(f: number): string {
  if (f === 1) return '1.0';
  if (f === 0) return '0.0';
  if (f === -1) return '-1.0';
  if (Number.isNaN(f)) return 'NaN';
  if (f === Infinity) return '+Inf';
  if (f === -Infinity) return '-Inf';
  const s = formatG(f);
  return /[e.]/.test(s) ? s : s + '.0';
}

/** expfmt `writeInt` for an int64 held in a double. */
export function formatInt64(n: number): string {
  // A double cannot hold the int64 extremes, so parsing them rounds to +-2^63.
  if (n >= 2 ** 63) return '9223372036854775807';
  if (n <= -(2 ** 63)) return '-9223372036854775808';
  return Number.isInteger(n) ? BigInt(n).toString() : String(Math.trunc(n));
}

/**
 * Seconds to milliseconds without floating-point drift: `1.234` (as a string
 * or the double nearest to it) gives exactly `1234`.
 */
export function secondsToMs(s: string | number): number {
  const text = typeof s === 'number' ? s.toExponential() : s;
  const m = /^([+-]?[0-9]*\.?[0-9]*)(?:[eE]([+-]?[0-9]+))?$/.exec(text);
  if (!m) return Number(text) * 1000;
  return Number(`${m[1]}e${Number(m[2] ?? 0) + 3}`);
}

const TIMESTAMP = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

/** An OpenMetrics timestamp: a decimal number of seconds, no NaN, Inf or hex. */
export function isDecimal(s: string): boolean {
  return TIMESTAMP.test(s);
}
