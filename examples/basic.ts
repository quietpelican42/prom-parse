import { metrics, parse, serialize } from '../src/index.ts';

const text = `# HELP req_seconds Request latency.
# TYPE req_seconds histogram
req_seconds_bucket{route="/a",le="0.1"} 1
req_seconds_bucket{route="/a",le="+Inf"} 1
req_seconds_sum{route="/a"} 0.05
req_seconds_count{route="/a"} 1
req_seconds_bucket{route="/b",le="0.1"} 0
req_seconds_bucket{route="/b",le="+Inf"} 2
req_seconds_sum{route="/b"} 5.5
req_seconds_count{route="/b"} 2
`;

const families = parse(text);
for (const family of families) {
  console.log(family.name, family.type, `${family.samples.length} samples`);
  for (const m of metrics(family)) {
    console.log(' ', Object.fromEntries(m.labels), `sum=${m.sum} count=${m.count}`, m.buckets?.map((b) => `${b.upperBound}:${b.count}`).join(' '));
  }
}

try {
  parse('up 1\ndown one\n');
} catch (e) {
  console.log((e as Error).message);
}

console.log(serialize(families, 'openmetrics'));
