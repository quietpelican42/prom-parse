import assert from 'node:assert/strict';
import test from 'node:test';
import { metrics, parse, ParseError, serialize } from '../src/index.ts';
import { EDGE_CASES, Gen, mutate } from './support/gen.ts';

const ITERATIONS = Number(process.env.PROMPARSE_FUZZ ?? 60_000);

test(`fuzz: ${ITERATIONS} random and mutated inputs only ever produce families or ParseError, and accepted input re-serializes`, () => {
  const g = new Gen(0xf00d);
  let accepted = 0;
  let rejected = 0;
  let reparsed = 0;
  const seeds = [...EDGE_CASES.map((s) => Buffer.from(s, 'latin1')), ...Array.from({ length: 200 }, () => Buffer.from(g.document(), 'utf8'))];
  const omSeed = Buffer.from('# TYPE a histogram\n# UNIT a seconds\na_bucket{le="1.0"} 1 1.5 # {t="x"} 0.5 2\na_bucket{le="+Inf"} 2\na_count 2\na_sum 1\n# TYPE b info\nb_info{v="1"} 1\n# EOF\n');
  seeds.push(omSeed, Buffer.from(omSeed.toString().replace('seconds', 'a').replace('# UNIT a a', '# UNIT a_a a'), 'utf8'));
  for (let i = 0; i < ITERATIONS; i++) {
    let input = mutate(g, g.pick(seeds));
    if (g.chance(0.05)) input = Buffer.from(Array.from({ length: g.int(40) }, () => g.int(256)));
    const format = g.chance(0.5) ? 'prometheus' : 'openmetrics';
    let fams;
    try {
      fams = parse(input, { format });
    } catch (e) {
      assert.ok(e instanceof ParseError, `non-ParseError for ${JSON.stringify(input.toString('latin1'))}: ${String(e)}`);
      assert.ok(Number.isInteger(e.line) && e.line >= 1);
      rejected++;
      continue;
    }
    accepted++;
    for (const f of fams) metrics(f);
    // Whatever expfmt-style parsing accepted must serialize without a crash.
    try {
      const out = serialize(fams, format);
      reparsed++;
      // Families whose names differ only by a _sum/_count/_bucket suffix regroup when parsed again, in expfmt as here.
      const names = new Set(fams.map((f) => f.name));
      const suffixed = fams.some((f) => ['_sum', '_count', '_bucket'].some((x) => names.has(f.name + x)));
      // expfmt writes a label name such as `b:` unquoted (it applies the metric-name rule); we match it byte for byte.
      const colonLabel = fams.some((f) => f.samples.some((x) => [...x.labels.keys()].some((k) => /^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(k) && k.includes(':'))));
      if (format === 'prometheus' && !suffixed && !colonLabel) {
        try {
          parse(out, { format });
        } catch (e) {
          assert.fail(`re-parse failed: ${String(e)}\n input ${JSON.stringify(input.toString('latin1'))}\n output ${JSON.stringify(out)}`);
        }
      }
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
      assert.ok(e instanceof Error && e.name === 'SerializeError', String(e));
    }
  }
  console.log(`  fuzz: accepted ${accepted}, rejected ${rejected}, serialized ${reparsed}`);
  assert.ok(accepted > 500 && rejected > 500);
});

test('fuzz: pathological long lines finish quickly', () => {
  const t = Date.now();
  const long = 'a{' + 'b="' + 'x'.repeat(200_000) + '"} 1\n';
  parse(long, { format: 'prometheus' });
  parse(long + '# EOF\n', { format: 'openmetrics' });
  const many = 'a{' + Array.from({ length: 5000 }, (_, i) => `l${i}="v"`).join(',') + '} 1\n';
  parse(many, { format: 'prometheus' });
  parse(many + '# EOF\n', { format: 'openmetrics' });
  assert.ok(Date.now() - t < 5000, `took ${Date.now() - t}ms`);
});
