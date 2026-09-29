/**
 * Seeded generator of Prometheus text expositions: valid documents built from
 * random families, and byte-level mutations of them.
 */

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Gen {
  readonly r: () => number;
  constructor(seed: number) {
    this.r = rng(seed);
  }
  int(n: number): number {
    return Math.floor(this.r() * n);
  }
  chance(p: number): boolean {
    return this.r() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }

  private static readonly NAMES = ['req', 'http_requests', 'rpc', 'a', 'x', 'up', 'req_count', 'req_sum', 'lat', 'lat_bucket', 'go_gc', 'x_total', 'temp:c', '_priv'];
  private static readonly UTF8_NAMES = ['a.b', 'héllo', 'with space', 'q"uote', 'new\nline', 'back\\slash', '日本語', '1starts'];
  private static readonly LABELS = ['job', 'instance', 'code', 'method', 'path', 'quantile', 'le', 'a', 'b', 'Z9', '_x'];
  private static readonly VALUES = ['', 'x', 'GET', '/a/b', 'a b', 'a"b', 'a\\b', 'a\nb', 'é', '日本', '}', '{', ',', '=', '#', ' ', 'a,b="c"', '\\\\', '\\n', '😀', '1e3', '\t'];

  metricName(): string {
    return this.chance(0.1) ? this.pick(Gen.UTF8_NAMES) : this.pick(Gen.NAMES);
  }
  labelName(): string {
    return this.chance(0.05) ? this.pick(Gen.UTF8_NAMES) : this.pick(Gen.LABELS);
  }
  labelValue(): string {
    return this.chance(0.15) ? this.pick(Gen.VALUES) + this.pick(Gen.VALUES) : this.pick(Gen.VALUES);
  }

  number(): string {
    const k = this.int(14);
    switch (k) {
      case 0: return '0';
      case 1: return '1';
      case 2: return String(this.int(1000));
      case 3: return (this.r() * 1000).toFixed(this.int(6));
      case 4: return String(this.r() * 10 ** (this.int(30) - 12));
      case 5: return '+Inf';
      case 6: return '-Inf';
      case 7: return 'NaN';
      case 8: return '-' + String(this.int(100));
      case 9: return this.pick(['1e3', '1E-3', '.5', '5.', '+7', '00012', 'inf', 'Infinity', '-infinity', 'nan', '1e-400', '0.000001', '123456789', '1234567.5']);
      case 10: return String(2 ** this.int(60));
      default: return String(this.int(50));
    }
  }
  count(): string {
    return this.chance(0.9) ? String(this.int(500)) : this.pick(['3.5', '1e2', '+Inf', '0', '2.0']);
  }

  esc(v: string, quote: boolean): string {
    let o = v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
    if (quote) o = o.replace(/"/g, '\\"');
    return o;
  }
  name(n: string): string {
    return /^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(n) ? n : `"${this.esc(n, true)}"`;
  }
  labelKey(n: string): string {
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(n) ? n : `"${this.esc(n, true)}"`;
  }

  ws(): string {
    return this.chance(0.1) ? this.pick([' ', '\t', '  ']) : '';
  }

  labels(extra: Array<[string, string]>, base: Array<[string, string]>): string {
    const all = [...base, ...extra];
    if (all.length === 0) return this.chance(0.05) ? '{}' : '';
    const parts = all.map(([k, v]) => `${this.ws()}${this.labelKey(k)}${this.ws()}=${this.ws()}"${this.esc(v, true)}"${this.ws()}`);
    return '{' + parts.join(',') + (this.chance(0.03) ? ',' : '') + '}';
  }

  line(metric: string, labels: string, value: string, ts: number | undefined): string {
    let head: string;
    if (this.chance(0.05)) {
      // Metric name inside the braces.
      const inner = labels.slice(1, -1);
      head = `{"${this.esc(metric, true)}"${inner ? ',' + inner : ''}}`;
    } else {
      head = this.name(metric) + labels;
    }
    const sp = () => this.pick([' ', ' ', ' ', '\t', '  ']);
    return (this.chance(0.03) ? ' ' : '') + head + sp() + value + (ts !== undefined ? sp() + ts : '') + (this.chance(0.03) ? ' ' : '');
  }

  help(): string {
    return this.pick(['Total requests.', 'a\\nb', 'back\\\\slash', 'quote"d', 'é日本', '', 'trailing space ', ' leading', 'x\\ty', '#hash']);
  }

  family(): string[] {
    const out: string[] = [];
    const type = this.pick(['counter', 'gauge', 'untyped', 'summary', 'histogram', 'gauge_histogram', 'gaugehistogram', 'COUNTER', 'Gauge', 'HISTOGRAM', 'Summary', 'none'] as const);
    const kind = type.toLowerCase().replace('_', '');
    const mname = this.metricName();
    const meta: string[] = [];
    if (this.chance(0.7)) meta.push(`# HELP ${this.name(mname)} ${this.help()}`);
    if (type !== 'none') meta.push(`# TYPE ${this.name(mname)} ${type}`);
    if (this.chance(0.2)) meta.reverse();
    if (this.chance(0.05)) meta.push(this.pick(['# comment', '#nospace', '#', '# UNIT x y', '# EOF']));
    out.push(...meta);
    const nsets = 1 + this.int(3);
    const sets: Array<Array<[string, string]>> = [];
    for (let i = 0; i < nsets; i++) {
      const s: Array<[string, string]> = [];
      const n = this.int(3);
      const used = new Set<string>();
      for (let j = 0; j < n; j++) {
        const k = this.labelName();
        if (used.has(k) || k === 'le' || k === 'quantile') continue;
        used.add(k);
        s.push([k, this.labelValue()]);
      }
      sets.push(s);
    }
    const ts = () => (this.chance(0.3) ? this.int(2 ** 31) * 1000 : undefined);
    const lines: string[] = [];
    for (const base of sets) {
      if (kind === 'histogram' || kind === 'gaugehistogram') {
        const t = ts();
        const nb = this.int(4);
        let c = 0;
        for (let b = 0; b < nb; b++) {
          c += this.int(10);
          const le = this.pick(['0.005', '0.5', '1', '2.5', '1e-3', '10', String(b + 1)]);
          lines.push(this.line(mname + '_bucket', this.labels([['le', le]], base), String(c), t));
        }
        if (this.chance(0.9)) lines.push(this.line(mname + '_bucket', this.labels([['le', '+Inf']], base), String(c + this.int(5)), t));
        if (this.chance(0.9)) lines.push(this.line(mname + '_sum', this.labels([], base), this.number(), t));
        if (this.chance(0.9)) lines.push(this.line(mname + '_count', this.labels([], base), this.count(), t));
      } else if (kind === 'summary') {
        const t = ts();
        const nq = this.int(4);
        for (let q = 0; q < nq; q++) lines.push(this.line(mname, this.labels([['quantile', this.pick(['0.5', '0.9', '0.99', '1', '0'])]], base), this.number(), t));
        if (this.chance(0.9)) lines.push(this.line(mname + '_sum', this.labels([], base), this.number(), t));
        if (this.chance(0.9)) lines.push(this.line(mname + '_count', this.labels([], base), this.count(), t));
      } else {
        lines.push(this.line(mname, this.labels([], base), this.number(), ts()));
      }
    }
    if (this.chance(0.15)) {
      for (let i = lines.length - 1; i > 0; i--) {
        const j = this.int(i + 1);
        [lines[i], lines[j]] = [lines[j]!, lines[i]!];
      }
    }
    out.push(...lines);
    if (this.chance(0.1)) out.push('');
    return out;
  }

  document(): string {
    const nf = 1 + this.int(4);
    const lines: string[] = [];
    for (let i = 0; i < nf; i++) lines.push(...this.family());
    let doc = lines.join('\n');
    if (!this.chance(0.03)) doc += '\n';
    return doc;
  }
}

const DICT = ['"', '\\', '{', '}', ',', '=', '#', ' ', '\t', '\n', '\r', '0', '1', 'e', 'p', '_', 'x', '+', '-', '.', 'N', 'I', 'n', ':', '\0', '\xff', '\x80', '\xc3', '\xed\xa0\x80'];

/** Byte-level mutations of a document. */
export function mutate(g: Gen, doc: Buffer): Buffer {
  let b = Buffer.from(doc);
  const n = 1 + g.int(3);
  for (let i = 0; i < n && b.length > 0; i++) {
    const pos = g.int(b.length);
    switch (g.int(7)) {
      case 0: // delete a byte
        b = Buffer.concat([b.subarray(0, pos), b.subarray(pos + 1)]);
        break;
      case 1: // insert dictionary bytes
        b = Buffer.concat([b.subarray(0, pos), Buffer.from(g.pick(DICT), 'latin1'), b.subarray(pos)]);
        break;
      case 2: // replace a byte
        b = Buffer.concat([b.subarray(0, pos), Buffer.from(g.pick(DICT), 'latin1'), b.subarray(pos + 1)]);
        break;
      case 3: { // delete a line
        const s = b.toString('latin1').split('\n');
        s.splice(g.int(s.length), 1);
        b = Buffer.from(s.join('\n'), 'latin1');
        break;
      }
      case 4: { // duplicate a line
        const s = b.toString('latin1').split('\n');
        const k = g.int(s.length);
        s.splice(k, 0, s[k]!);
        b = Buffer.from(s.join('\n'), 'latin1');
        break;
      }
      case 5: { // swap two lines
        const s = b.toString('latin1').split('\n');
        const x = g.int(s.length);
        const y = g.int(s.length);
        [s[x], s[y]] = [s[y]!, s[x]!];
        b = Buffer.from(s.join('\n'), 'latin1');
        break;
      }
      default: // truncate
        b = b.subarray(0, pos);
    }
  }
  return b;
}

/** Hand-picked inputs where expfmt's parser does something unusual. */
export const EDGE_CASES: string[] = [
  '{"a"} 1\n', '{"a",b="c"} 1\n', '{b="c"} 1\n', '{}\n', '{} 1\n', '{"a","b"} 1\n', '{b="c","a"} 1\n', '{"a" , b="c" } 1 5\n',
  'a"b c" 1\n', 'a"b"c 1\n', '"a b" 1\n', '"a" 1\n', 'a{"b"="c"} 1\n', 'a{"b.c"="d"} 1\n', 'a{b="c"}1\n', 'a{b="c"} 1 2 3\n', 'a{b="c"} 1 2.5\n',
  'a 1', 'a 1\n\n\n', '\n\n', '', '   \n', '# HELP', '# HELP\n', '# HELP a', '# HELP a\n', '# HELP a b\n# HELP a c\n', '# TYPE a counter\n# TYPE a gauge\n',
  'a 1\n# TYPE a counter\n', '# TYPE a gauge\na 1\n# HELP a x\n', '# TYPE a histogram\na_bucket{le="1"} 1\na_bucket{le="+Inf"} 2\na_sum 1\na_count 2\n',
  '# TYPE a histogram\na_bucket{le="1"} -1\n', '# TYPE a histogram\na_count -1\n', '# TYPE a histogram\na_count 1.5\n', '# TYPE a histogram\na_count -0.5\n', '# TYPE a histogram\na_sum -1\n',
  '# TYPE a histogram\na{le="1"} 3\n', '# TYPE a histogram\na_bucket 3\n', '# TYPE a histogram\na_bucket{le="x"} 3\n', '# TYPE a histogram\na_bucket{le="NaN"} 3\n',
  '# TYPE a summary\na{quantile="0.5"} 1\na_sum 3\na_count 2\n', '# TYPE a summary\na{quantile="x"} 1\n', '# TYPE a summary\na{quantile="NaN"} 1\n', '# TYPE a summary\na 1\n',
  '# TYPE a summary\na_count -1\n', '# TYPE a untyped\na_count 1\n', '# TYPE a gauge_histogram\na_bucket{le="+Inf"} 1\n', '# TYPE a GAUGEHISTOGRAM\na_bucket{le="+Inf"} 1\n',
  '# TYPE a Histogram\na_bucket{le="+Inf"} 1\n', '# TYPE a meh\n', '# TYPE a\n', '# TYPE a counter \n', '# TYPE a counter\t\n', '# TYPE\n', '# TYPE a  counter\n',
  'a{b="c",b="d"} 1\n', 'a{__name__="c"} 1\n', 'a{b="\\q"} 1\n', 'a{b="\\"} 1\n', 'a{b="c} 1\n', 'a{b=c} 1\n', 'a{b="c",} 1\n', 'a{b="c",,d="e"} 1\n', 'a{,b="c"} 1\n', 'a{b="c"',
  'a{b="\xff"} 1\n', 'a{b="\xc3\x28"} 1\n', '# HELP a \xff\n', 'a 1e400\n', 'a 1e-400\n', 'a 0x1\n', 'a 1_0\n', 'a 1p3\n', 'a Inf\n', 'a +inf\n', 'a -INFINITY\n', 'a nan\n', 'a +NaN\n', 'a 1.\n', 'a .5\n', 'a .\n', 'a 1e\n', 'a +\n',
  'a 1 +5\n', 'a 1 -5\n', 'a 1 0x5\n', 'a 1 1_0\n', 'a 1 9223372036854775807\n', 'a 1 9223372036854775808\n', 'a 1 # x\n', 'a 1 2 # x\n', 'a 1\r\n', 'a 1 2\r\n', '# HELP a x\r\n',
  '# a\n', '#a\n', '#\n', '# \n', '##\n', '\t# HELP a b\n', '# HELP a b\\\n', '# HELP a b\\', '# HELP a \\t\n', '# HELP a \\"\n', '# HELP "a b" c\n', '# HELP "a\\nb" c\n', '# TYPE "a" counter\n"a" 1\n',
  'a:b 1\n', ':a 1\n', '_a 1\n', '1a 1\n', 'a-b 1\n', 'a.b 1\n', 'é 1\n', 'a{é="1"} 1\n', 'a{"é"="1"} 1\n', 'a{1="1"} 1\n',
];
