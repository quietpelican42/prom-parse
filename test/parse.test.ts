import assert from 'node:assert/strict';
import test from 'node:test';
import { metrics, parse, ParseError, serialize } from '../src/index.ts';

const labels = (o: Record<string, string>) => new Map(Object.entries(o));

test('a labeled histogram keeps buckets, sum and count for every label set', () => {
  const text = `# HELP req_seconds lat
# TYPE req_seconds histogram
req_seconds_bucket{le="0.1",route="/a"} 1
req_seconds_bucket{le="+Inf",route="/a"} 1
req_seconds_sum{route="/a"} 0.05
req_seconds_count{route="/a"} 1
req_seconds_bucket{le="0.1",route="/b"} 0
req_seconds_bucket{le="+Inf",route="/b"} 2
req_seconds_sum{route="/b"} 5.5
req_seconds_count{route="/b"} 2
`;
  const [fam] = parse(text);
  assert.equal(fam!.name, 'req_seconds');
  assert.equal(fam!.type, 'histogram');
  assert.equal(fam!.help, 'lat');
  assert.equal(fam!.samples.length, 8);
  const ms = metrics(fam!);
  assert.equal(ms.length, 2);
  assert.deepEqual(ms[0]!.labels, labels({ route: '/a' }));
  assert.deepEqual(ms[0]!.buckets, [{ upperBound: 0.1, count: 1 }, { upperBound: Infinity, count: 1 }]);
  assert.equal(ms[0]!.sum, 0.05);
  assert.equal(ms[0]!.count, 1);
  assert.deepEqual(ms[1]!.labels, labels({ route: '/b' }));
  assert.equal(ms[1]!.sum, 5.5);
  assert.equal(ms[1]!.count, 2);
});

test('a space after a comma in a label set is accepted', () => {
  const [fam] = parse('# TYPE a summary\na{n1="x", quantile="0.2"} 1\n');
  assert.deepEqual(metrics(fam!)[0]!.quantiles, [{ quantile: 0.2, value: 1 }]);
  assert.deepEqual(metrics(fam!)[0]!.labels, labels({ n1: 'x' }));
});

test('Prometheus: escapes, UTF-8 names, special floats, millisecond timestamps', () => {
  const text = [
    '# HELP a Help with \\\\ backslash and \\n newline',
    '# TYPE a gauge',
    'a{l="q\\"uote\\\\ \\n"} +Inf 1500',
    '{"a.b", "c d"="e"} NaN',
    'x -Inf',
    '',
  ].join('\n');
  const fams = parse(text, { format: 'prometheus' });
  assert.equal(fams[0]!.help, 'Help with \\ backslash and \n newline');
  assert.deepEqual(fams[0]!.samples[0], { name: 'a', labels: labels({ l: 'q"uote\\ \n' }), value: Infinity, timestamp: 1500 });
  assert.equal(fams[1]!.name, 'a.b');
  assert.equal(fams[1]!.type, 'unknown');
  assert.deepEqual(fams[1]!.samples[0]!.labels, labels({ 'c d': 'e' }));
  assert.ok(Number.isNaN(fams[1]!.samples[0]!.value));
  assert.equal(fams[2]!.samples[0]!.value, -Infinity);
});

test('Prometheus: errors carry the line number and expfmt message', () => {
  const cases: Array<[string, number, RegExp]> = [
    ['a 1\nb x\n', 2, /expected float as value, got "x"/],
    ['a 1', 1, /unexpected end of input stream/],
    ['# TYPE a counter\n# TYPE a gauge\n', 2, /second TYPE line/],
    ['a{b="1",b="2"} 1\n', 1, /duplicate label names/],
    ['a 1e400\n', 1, /expected float/],
    ['a 0x1\n', 1, /expected float/],
    ['a 1_0\n', 1, /expected float/],
    ['a{b="\\q"} 1\n', 1, /invalid escape sequence/],
    ['a 1 2 3\n', 1, /spurious string after timestamp/],
    ['a{b="\xff"} 1\n', 1, /invalid label value/],
    ['# TYPE h histogram\nh_count -1\n', 2, /negative count/],
  ];
  for (const [text, line, re] of cases) {
    assert.throws(() => parse(Buffer.from(text, 'latin1'), { format: 'prometheus' }), (e: unknown) => {
      assert.ok(e instanceof ParseError);
      assert.equal(e.line, line, text);
      assert.match(e.detail, re);
      return true;
    });
  }
});

test('Prometheus: legacy name validation rejects quoted UTF-8 names', () => {
  assert.doesNotThrow(() => parse('{"a.b"} 1\n', { format: 'prometheus' }));
  assert.throws(() => parse('{"a.b"} 1\n', { format: 'prometheus', nameValidation: 'legacy' }), ParseError);
});

test('OpenMetrics: units, info, stateset, gaugehistogram, exemplars, seconds to milliseconds', () => {
  const text = [
    '# TYPE lat_seconds histogram',
    '# UNIT lat_seconds seconds',
    '# HELP lat_seconds Latency.',
    'lat_seconds_bucket{le="1.0"} 1 1.5 # {trace_id="abc"} 0.7 1.25',
    'lat_seconds_bucket{le="+Inf"} 2 1.5',
    'lat_seconds_count 2 1.5',
    'lat_seconds_sum 3.5 1.5',
    'lat_seconds_created 1.0',
    '# TYPE build info',
    'build_info{version="1"} 1',
    '# TYPE mode stateset',
    'mode{mode="a"} 1',
    'mode{mode="b"} 0',
    '# TYPE g gaugehistogram',
    'g_bucket{le="-1.0"} 1',
    'g_bucket{le="+Inf"} 4',
    'g_gcount 4',
    'g_gsum -2',
    '# TYPE c counter',
    'c_total 5 # {a="b"} 1',
    '# EOF',
    '',
  ].join('\n');
  const fams = parse(text);
  assert.deepEqual(fams.map((f) => [f.name, f.type]), [
    ['lat_seconds', 'histogram'], ['build', 'info'], ['mode', 'stateset'], ['g', 'gaugehistogram'], ['c_total', 'counter'],
  ]);
  assert.equal(fams[0]!.unit, 'seconds');
  assert.equal(fams[0]!.help, 'Latency.');
  const h = fams[0]!.samples;
  assert.equal(h[0]!.timestamp, 1500);
  assert.deepEqual(h[0]!.exemplar, { labels: labels({ trace_id: 'abc' }), value: 0.7, timestamp: 1250 });
  const m = metrics(fams[0]!)[0]!;
  assert.equal(m.created, 1000);
  assert.equal(m.count, 2);
  assert.equal(m.sum, 3.5);
  assert.equal(m.buckets![0]!.exemplar!.value, 0.7);
  assert.equal(fams[3]!.samples.length, 4);
});

test('OpenMetrics: UTF-8 names in quotes, escapes, no trailing newline after EOF', () => {
  const fams = parse('# TYPE "a.b" gauge\n# HELP "a.b" h\\"q\\n\n{"a.b","x y"="z\\\\"} 1\n# EOF');
  assert.equal(fams[0]!.name, 'a.b');
  assert.equal(fams[0]!.help, 'h"q\n');
  assert.deepEqual(fams[0]!.samples[0]!.labels, labels({ 'x y': 'z\\' }));
});

test('OpenMetrics: ordering and structure rules', () => {
  const bad: Array<[string, number]> = [
    ['a 1\n', 1],
    ['a 1\n# EOF\nb 2\n', 3],
    ['# TYPE a gauge\na{x="1"} 1\na{x="2"} 1\na{x="1"} 1\n# EOF\n', 4],
    ['# TYPE a gauge\na 1 5\na 1 4\n# EOF\n', 3],
    ['# TYPE a histogram\na_bucket{le="1"} 2\na_bucket{le="+Inf"} 1\n# EOF\n', 3],
    ['# TYPE a_seconds gauge\n# UNIT a_seconds bytes\n# EOF\n', 2],
    ['# TYPE a counter\na_total 1 # {} 1\na_total{x="1"} -1\n# EOF\n', 3],
    ['a 1 \n# EOF\n', 1],
    ['a{b="c",}1\n# EOF\n', 1],
  ];
  for (const [text, line] of bad) {
    assert.throws(() => parse(text, { format: 'openmetrics' }), (e: unknown) => e instanceof ParseError && e.line === line, JSON.stringify(text));
  }
});

test('format auto-detection: a line equal to "# EOF" selects OpenMetrics', () => {
  assert.equal(parse('# TYPE a counter\na_total 1\n# EOF\n')[0]!.name, 'a_total');
  assert.equal(parse('# TYPE a counter\na 1\n')[0]!.name, 'a');
  assert.throws(() => parse('a 1\n', { format: 'openmetrics' }), /missing # EOF/);
});

test('serialize: hand-checked output', () => {
  const fams = parse('# HELP a h\n# TYPE a counter\na{x="1"} 3 1500\n# TYPE h histogram\nh_bucket{le="0.5"} 1\nh_bucket{le="+Inf"} 2\nh_sum 1.5\nh_count 2\n');
  assert.equal(
    serialize(fams, 'prometheus'),
    '# HELP a h\n# TYPE a counter\na{x="1"} 3 1500\n# TYPE h histogram\nh_bucket{le="0.5"} 1\nh_bucket{le="+Inf"} 2\nh_sum 1.5\nh_count 2\n',
  );
  assert.equal(
    serialize(fams, 'openmetrics'),
    '# HELP a h\n# TYPE a unknown\na{x="1"} 3.0 1.5\n# TYPE h histogram\nh_bucket{le="0.5"} 1\nh_bucket{le="+Inf"} 2\nh_sum 1.5\nh_count 2\n# EOF\n',
  );
  assert.equal(serialize([{ name: 'f', type: 'gauge', samples: [{ name: 'f', labels: labels({ 'a.b': 'c"d' }), value: 1e6 }] }], 'prometheus'), '# TYPE f gauge\nf{"a.b"="c\\"d"} 1e+06\n');
});

test('serialize then parse returns the same families (OpenMetrics with exemplars, units, info)', () => {
  const text = [
    '# TYPE lat_seconds histogram', '# UNIT lat_seconds seconds', '# HELP lat_seconds L.',
    'lat_seconds_bucket{le="0.5",r="a"} 1 # {t="x"} 0.25 100.5', 'lat_seconds_bucket{le="+Inf",r="a"} 3', 'lat_seconds_sum{r="a"} 2.5', 'lat_seconds_count{r="a"} 3',
    '# TYPE bi info', 'bi_info{v="1"} 1',
    '# EOF', '',
  ].join('\n');
  const fams = parse(text);
  const again = parse(serialize(fams, 'openmetrics'));
  assert.deepEqual(again, fams);
});
