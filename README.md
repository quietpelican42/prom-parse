# prom-parse

Parser and serializer for the Prometheus text exposition format (0.0.4) and OpenMetrics 1.0 text, with no runtime dependencies.

```ts
import { parse, metrics, serialize } from 'prom-parse';

const families = parse(await (await fetch('http://app:9090/metrics')).text());
for (const family of families) {
  for (const m of metrics(family)) console.log(family.name, Object.fromEntries(m.labels), m.sum, m.count);
}
const text = serialize(families, 'openmetrics'); // same bytes as Go's expfmt
```

## Why

The npm parsers for this format do not agree with Prometheus about what a valid exposition is, and several drop data from ordinary output. `parse-prometheus-text-format` (last release 2019) returns one histogram entry per family and loses `_sum`, `_count` and the labels of a labeled histogram. It throws on `{n="a", quantile="0.2"}` (a space after the comma). The four older packages reject 10 to 14 of the 167 invalid cases in the OpenMetrics suite (no `# EOF` requirement, no ordering rules). `promtext` parses OpenMetrics metadata and exemplars but rejects 37 of the 167.

This package follows two references:

- Go's `prometheus/common` `expfmt` (v0.72.0) for the Prometheus text format. The parser is a port of its state machine, and the serializer reproduces its encoders byte for byte.
- The official OpenMetrics parser test suite (`prometheus/OpenMetrics`, 211 cases, pinned by commit and content digest) for OpenMetrics.

Packages checked: `parse-prometheus-text-format`, `@pmuir/parse-prometheus-text-format`, `prometheus-text-to-json`, `metrics-object-parser` and `promtext`.

Measured: `node bench/compare.ts`

```
parser | OpenMetrics suite | agrees with expfmt on accept/reject | labeled histogram sum+count kept | `{n="a", quantile="0.2"}`
prom-parse (this package) | 211/211 | 11990/11990 (100.0%) | yes | ok
promtext 0.1.0 | 81/211 | 7989/11990 (66.6%) | yes | ok
parse-prometheus-text-format 1.1.1 | 55/211 | 6535/11990 (54.5%) | no | throws
@pmuir/parse-prometheus-text-format 1.2.16 | 54/211 | 6105/11990 (50.9%) | yes | throws
prometheus-text-to-json 2.0.1 | 55/211 | 6466/11990 (53.9%) | yes | throws
metrics-object-parser 1.0.1 | 54/211 | 6550/11990 (54.6%) | no | throws
```

The accept/reject column runs each parser over 12000 generated and byte-mutated texts (10 of the 12000 are skipped because expfmt itself panics on them) and counts how often it makes the same accept or reject decision as expfmt. Most of that corpus is deliberately malformed, so the percentage measures agreement with expfmt on hard inputs, not the failure rate on real endpoints. The suite column is the pass count over all 211 cases (44 must parse, 167 must be rejected).

## Installation

```sh
npm install prom-parse
```

Node 20.6 or later. No runtime dependencies.

## Usage

### Parse

`parse` takes a string or bytes and returns metric families in the order they appear. Each family has a name, type, optional help and unit, and a flat list of samples.

```ts
const [fam] = parse('# TYPE up gauge\nup{job="a"} 1 1700000000000\n');
fam.samples[0]; // { name: 'up', labels: Map { 'job' => 'a' }, value: 1, timestamp: 1700000000000 }
```

Timestamps are always milliseconds. Prometheus text writes milliseconds and OpenMetrics writes seconds; both are converted, and OpenMetrics decimals are converted without floating-point drift (`1.234` becomes exactly `1234`).

Counter families are named after their `_total` series in both formats (`http_requests_total`), as in expfmt and prom-client.

### Formats

`format` is `'prometheus'`, `'openmetrics'` or `'auto'` (default). Auto selects OpenMetrics when a line equals `# EOF`, and Prometheus text otherwise.

### Label sets

`metrics(family)` attaches samples to their label set the way expfmt's `dto.Metric` does. Histogram `_bucket`, `_sum`, `_count` and `_created` series and summary quantiles share one entry per label set (`le` and `quantile` excluded from the labels).

```ts
metrics(histogramFamily);
// [ { labels: Map { 'route' => '/a' }, buckets: [...], sum: 0.05, count: 1 },
//   { labels: Map { 'route' => '/b' }, buckets: [...], sum: 5.5,  count: 2 } ]
```

Other types get one entry per sample, with `value`, `timestamp` and (for OpenMetrics counters) `exemplar`.

### Errors

Invalid input throws `ParseError` with the 1-based `line`. For Prometheus text, accept and reject decisions, line numbers and messages equal expfmt's.

```ts
try { parse('up 1\ndown one\n'); } catch (e) { e.line; e.message; }
// 2  text format parsing error in line 2: expected float as value, got "one"
```

### Serialize

`serialize(families, 'prometheus' | 'openmetrics', options)` writes families in the order given. Output is identical to expfmt's `MetricFamilyToText` and `MetricFamilyToOpenMetrics`, including its float formatting (`1e+06`, `1.0` in OpenMetrics), label escaping, quoted UTF-8 names and the `# EOF` line. Families are grouped with `metrics()` first, so a family parsed from one format can be written in the other.

## Reference

### `parse(input, options?)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `format` | `'prometheus' \| 'openmetrics' \| 'auto'` | `'auto'` | Format of the input. |
| `nameValidation` | `'utf8' \| 'legacy'` | `'utf8'` | Prometheus text only. `'utf8'` accepts any valid UTF-8 name in quotes; `'legacy'` accepts only `[a-zA-Z_:][a-zA-Z0-9_:]*` for metric names and `[a-zA-Z_][a-zA-Z0-9_]*` for label names. |

### `serialize(families, format, options?)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `createdLines` | `boolean` | `false` | OpenMetrics: write `_created` lines for metrics that have `created`. |
| `eof` | `boolean` | `true` | OpenMetrics: append `# EOF`. |

Throws `SerializeError` where expfmt returns an error: a Prometheus family with no metrics, a family without a name, and OpenMetrics histograms with fractional counts.

### Types

| Type | Fields |
| --- | --- |
| `MetricFamily` | `name`, `type` (`counter`, `gauge`, `histogram`, `gaugehistogram`, `summary`, `info`, `stateset`, `unknown`), `help?`, `unit?`, `samples` |
| `Sample` | `name` (with suffix), `labels: Map`, `value`, `timestamp?` (ms), `exemplar?` |
| `Exemplar` | `labels: Map`, `value`, `timestamp?` (ms) |
| `Metric` (from `metrics()`) | `labels`, `timestamp?`, `value?`, `exemplar?`, `buckets?`, `quantiles?`, `sum?`, `count?`, `created?` (ms) |

`detectFormat(bytes)` is also exported.

## How it works

The Prometheus parser is a byte-level state machine that mirrors `text_parse.go` in expfmt, including its quirks (a `"` inside an unquoted name toggles quoting, `TYPE` after samples is an error, a last line without a newline is an error, `1e400` is rejected as Go's `ParseFloat` does). Numbers use Go's grammar: no hex floats, no underscores, `Inf` and `NaN` in any case.

The OpenMetrics parser is line-based and follows the specification: strict single spaces, `# EOF` last, metadata before samples, one contiguous group per label set, non-decreasing timestamps, histogram bucket, count and sum consistency, exemplar placement and size, units matching the family name. It accepts unknown escape sequences in HELP and label values (`\z` stays `\z`), as the reference implementations do.

The differential tests generate expositions and byte-level mutations from a seeded generator, run them through a small Go program linked against expfmt v0.72.0, and compare accept or reject, line number, message and the parsed families. The serializer is tested the same way against `MetricFamilyToText` and `MetricFamilyToOpenMetrics`.

## Limitations

- OpenMetrics 2.0 draft features (native histograms, new escaping) are not supported. expfmt's 2.0 support is encode-only and experimental, and there is no oracle to check a parser against.
- In Prometheus text, expfmt's stale-state behavior is not reproduced for a metric name inside braces on a line that starts with `{` when the previous family is a summary or histogram: expfmt reads the previous family's type while it reads the labels. Accept and reject decisions still match; only the grouping of such a line into a label set can differ.
- expfmt panics on a few inputs (a nil map write). Those inputs are not compared.
- Summary counts and histogram counts go through Go's `uint64` conversion in expfmt. Values that are negative, fractional in summaries, or at least 2^64 are not compared with expfmt.
- Timestamps are JavaScript numbers. Prometheus integer timestamps beyond 2^53 lose precision.
- `HELP` text with invalid UTF-8 is decoded with U+FFFD replacement characters. Label values and names must be valid UTF-8 (as in expfmt).
- The OpenMetrics parser is validated against the official suite. Beyond the suite, one-off runs against the Python `prometheus_client` parser agreed on 99.6% and 99.7% of two sets of 6000 generated and mutated OpenMetrics texts (the disagreements were inspected; that script is not part of the repository). Duplicate series without timestamps are accepted, as in that parser.
- `serialize` inherits expfmt's label-name quirk: a label name containing `:` is written unquoted.
- The serializer writes `info` and `stateset` families in OpenMetrics and as gauges in Prometheus text. expfmt has no encoder for them, so that output is checked only by parsing it again.
- Input is parsed whole. There is no streaming API and no lenient mode that skips bad lines.
- `auto` treats any line equal to `# EOF` as a sign of OpenMetrics.

## Compatibility

Run here: Node 24.20 on macOS (arm64), Go 1.27 for the oracle, prom-client 15.1.3. The built `dist` smoke tests run on Node 24 locally; the CI workflow lists Node 20.6, 22 and 24 for them, which have not been run.

## Development

```sh
npm install
npm run typecheck
npm test              # needs network and Go for the OpenMetrics suite and the expfmt oracle; skips loudly without them
npm run build && npm run test:dist
node bench/compare.ts # see the header of the file for the comparison packages
node bench/speed.ts
```

The OpenMetrics suite (Apache-2.0) is fetched from a pinned commit and checked against a sha256 of its contents. It is cached under `.cache/` and never committed. The Go oracle builds from `test/oracle/`; its modules are downloaded by `go`.

Parse throughput on a synthetic 3.0 MB exposition (`node bench/speed.ts`, median of 7 runs): Prometheus text about 24 MB/s, OpenMetrics about 43 MB/s, serialize about 72 MB/s.

## License

MIT. See [LICENSE](LICENSE).

The Prometheus parser and both serializers are derived from `text_parse.go`, `text_create.go` and `openmetrics_create.go` in [prometheus/common](https://github.com/prometheus/common) (Copyright The Prometheus Authors, Apache License 2.0). Their license and notice are in [LICENSE-prometheus-common](LICENSE-prometheus-common) and [NOTICE-prometheus-common](NOTICE-prometheus-common).
