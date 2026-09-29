import assert from 'node:assert/strict';
import test from 'node:test';
import client from 'prom-client';
import { metrics, parse, serialize } from '../src/index.ts';

async function registry(contentType: string) {
  const reg = new client.Registry();
  const c = new client.Counter({ name: 'http_requests_total', help: 'Requests', labelNames: ['method', 'path'], registers: [reg] });
  c.inc({ method: 'GET', path: '/a"b\\c\nd' }, 3);
  c.inc({ method: 'POST', path: '/x' });
  const g = new client.Gauge({ name: 'temp_celsius', help: 'Temperature', registers: [reg] });
  g.set(-1.5e-7);
  const h = new client.Histogram({ name: 'req_seconds', help: 'Latency', labelNames: ['route'], buckets: [0.1, 1], registers: [reg] });
  h.observe({ route: '/a' }, 0.05);
  h.observe({ route: '/b' }, 0.5);
  h.observe({ route: '/b' }, 5);
  const s = new client.Summary({ name: 'payload_bytes', help: 'Size', percentiles: [0.5, 0.9], labelNames: ['kind'], registers: [reg] });
  s.observe({ kind: 'x' }, 2);
  s.observe({ kind: 'x' }, 4);
  reg.setContentType(contentType as never);
  return reg;
}

function check(text: string, format: 'prometheus' | 'openmetrics'): void {
  const fams = parse(text, { format });
  const byName = new Map(fams.map((f) => [f.name, f]));
  assert.deepEqual([...byName.keys()].sort(), ['http_requests_total', 'payload_bytes', 'req_seconds', 'temp_celsius']);

  const counters = metrics(byName.get('http_requests_total')!);
  assert.equal(counters.length, 2);
  assert.equal(counters[0]!.labels.get('path'), '/a"b\\c\nd');
  assert.equal(counters[0]!.value, 3);

  assert.equal(metrics(byName.get('temp_celsius')!)[0]!.value, -1.5e-7);

  const hist = metrics(byName.get('req_seconds')!);
  assert.equal(hist.length, 2);
  assert.deepEqual(hist.map((m) => [m.labels.get('route'), m.count, m.sum]), [['/a', 1, 0.05], ['/b', 2, 5.5]]);
  assert.deepEqual(hist[1]!.buckets!.map((b) => [b.upperBound, b.count]), [[0.1, 0], [1, 1], [Infinity, 2]]);

  const sum = metrics(byName.get('payload_bytes')!)[0]!;
  assert.equal(sum.count, 2);
  assert.equal(sum.sum, 6);
  assert.deepEqual(sum.quantiles!.map((q) => q.quantile), [0.5, 0.9]);

  // The families survive serialize and parse in both formats.
  for (const out of ['prometheus', 'openmetrics'] as const) {
    const again = parse(serialize(fams, out), { format: out });
    assert.deepEqual(again.map((f) => metrics(f)), fams.map((f) => metrics(f)));
  }
}

test('prom-client Prometheus output parses with labeled histograms and summaries intact', async () => {
  const reg = await registry(client.Registry.PROMETHEUS_CONTENT_TYPE);
  check(await reg.metrics(), 'prometheus');
});

test('prom-client OpenMetrics output parses with labeled histograms and summaries intact', async () => {
  const reg = await registry(client.Registry.OPENMETRICS_CONTENT_TYPE);
  const text = await reg.metrics();
  assert.ok(text.endsWith('# EOF\n'));
  check(text, 'openmetrics');
});
