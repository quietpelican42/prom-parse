/**
 * Plain-JS checks against the built package, so they run on every Node version
 * in `engines` (the TypeScript suite needs type stripping and only runs on 24+).
 *
 *   npm run build && node --test test/smoke.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { parse, serialize, metrics, ParseError, SerializeError } = await import('../dist/index.js');

const HIST = `# HELP req_seconds lat
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

test('labeled histogram keeps sum and count per label set', () => {
  const [fam] = parse(HIST);
  const ms = metrics(fam);
  assert.equal(ms.length, 2);
  assert.deepEqual(ms.map((m) => [m.labels.get('route'), m.sum, m.count]), [['/a', 0.05, 1], ['/b', 5.5, 2]]);
});

test('OpenMetrics: units, exemplars, seconds become milliseconds', () => {
  const [fam] = parse('# TYPE a_seconds counter\n# UNIT a_seconds seconds\na_seconds_total 3 1.5 # {t="x"} 1 2\n# EOF\n');
  assert.equal(fam.name, 'a_seconds_total');
  assert.equal(fam.unit, 'seconds');
  assert.equal(fam.samples[0].timestamp, 1500);
  assert.equal(fam.samples[0].exemplar.timestamp, 2000);
});

test('errors carry line numbers', () => {
  assert.throws(() => parse('a 1\nb x\n'), (e) => e instanceof ParseError && e.line === 2);
  assert.throws(() => parse('a 1\n', { format: 'openmetrics' }), ParseError);
});

test('serialize matches the expfmt layout', () => {
  const text = serialize(parse(HIST), 'prometheus');
  assert.ok(text.startsWith('# HELP req_seconds lat\n# TYPE req_seconds histogram\nreq_seconds_bucket{route="/a",le="0.1"} 1\n'));
  assert.ok(text.includes('req_seconds_sum{route="/b"} 5.5\n'));
  assert.ok(serialize(parse(HIST), 'openmetrics').endsWith('# EOF\n'));
  assert.throws(() => serialize([{ name: 'x', type: 'gauge', samples: [] }], 'prometheus'), SerializeError);
});
