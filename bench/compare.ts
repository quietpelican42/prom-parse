/**
 * Scores this package and the npm parsers on (a) the OpenMetrics parser suite
 * and (b) accept/reject agreement with expfmt over 12000 generated and mutated
 * texts, plus two small behaviour checks.
 *
 *   npm install --no-save promtext parse-prometheus-text-format @pmuir/parse-prometheus-text-format prometheus-text-to-json metrics-object-parser
 *   node bench/compare.ts
 *
 * Needs network (suite, Go modules) and Go. Packages that are not installed are skipped.
 */
import { createRequire } from 'node:module';
import { parse } from '../src/index.ts';
import { corpus } from '../test/support/differential.ts';
import { buildOracle, runOracle } from '../test/support/oracle.ts';
import { loadSuite } from '../test/support/om-suite.ts';

const require = createRequire(import.meta.url);
type Parser = (text: string) => unknown;

const impls: Record<string, Parser> = { 'prom-parse (this package)': (t) => parse(t) };
async function add(label: string, load: () => unknown): Promise<void> {
  try {
    const m = (await load()) as Record<string, unknown>;
    const f = (typeof m === 'function' ? m : (m.default ?? m.parse ?? Object.values(m)[0])) as Parser;
    impls[label] = (t) => f(t);
  } catch {
    console.log(`skipped ${label} (not installed)`);
  }
}
await add('promtext 0.1.0', () => import('promtext'));
await add('parse-prometheus-text-format 1.1.1', () => require('parse-prometheus-text-format'));
await add('@pmuir/parse-prometheus-text-format 1.2.16', () => require('@pmuir/parse-prometheus-text-format'));
await add('prometheus-text-to-json 2.0.1', () => require('prometheus-text-to-json'));
await add('metrics-object-parser 1.0.1', () => require('metrics-object-parser'));

const suite = await loadSuite();
const oracle = buildOracle();
if (typeof suite === 'string' || 'skip' in oracle) {
  console.log(typeof suite === 'string' ? suite : (oracle as { skip: string }).skip);
  process.exit(2);
}
const docs = corpus(20260929, 12000);
const want = runOracle<Array<{ utf8: { err?: unknown; panic?: string } }>>(oracle.bin, 'parse', docs.map((d) => d.toString('hex')));
const cases = docs.map((d, i) => ({ text: d.toString('utf8'), raw: d, accept: want[i]!.utf8.panic ? null : !want[i]!.utf8.err })).filter((c) => c.accept !== null);

const HIST = `# TYPE req_seconds histogram
req_seconds_bucket{le="0.1",route="/a"} 1
req_seconds_bucket{le="+Inf",route="/a"} 1
req_seconds_sum{route="/a"} 0.05
req_seconds_count{route="/a"} 1
req_seconds_bucket{le="0.1",route="/b"} 0
req_seconds_bucket{le="+Inf",route="/b"} 2
req_seconds_sum{route="/b"} 5.5
req_seconds_count{route="/b"} 2
`;

console.log('parser | OpenMetrics suite | agrees with expfmt on accept/reject | labeled histogram sum+count kept | `{n="a", quantile="0.2"}`');
for (const [name, f] of Object.entries(impls)) {
  const own = name.startsWith('prom-parse');
  let suitePass = 0;
  for (const c of suite) {
    let ok = true;
    try { own ? parse(c.metrics, { format: 'openmetrics' }) : f(c.metrics.toString('utf8')); } catch { ok = false; }
    if (ok === c.shouldParse) suitePass++;
  }
  let agree = 0;
  for (const c of cases) {
    let ok = true;
    try { own ? parse(c.raw, { format: 'prometheus' }) : f(c.text); } catch { ok = false; }
    if (ok === c.accept) agree++;
  }
  let hist = 'error';
  try {
    const j = JSON.stringify(f(HIST), (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v));
    hist = ['0.05', '5.5', '/a', '/b'].every((x) => j.includes(x)) ? 'yes' : 'no';
  } catch { hist = 'throws'; }
  let comma = 'ok';
  try { f('# TYPE a summary\na{n1="a", quantile="0.2"} 1\n'); } catch { comma = 'throws'; }
  console.log(`${name} | ${suitePass}/${suite.length} | ${agree}/${cases.length} (${((100 * agree) / cases.length).toFixed(1)}%) | ${hist} | ${comma}`);
}
