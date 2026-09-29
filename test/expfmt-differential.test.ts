import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOracle } from './support/oracle.ts';
import { corpus, differential } from './support/differential.ts';
import { encodeDifferential } from './support/encodediff.ts';

const oracle = buildOracle();
const skip = 'skip' in oracle ? `SKIPPED LOUDLY: ${oracle.skip}` : false;

test('parse: 12000 generated and mutated texts agree with expfmt (accept/reject, line, message, families)', { skip, timeout: 280_000 }, () => {
  const { bin } = oracle as { bin: string };
  const docs = corpus(20260929, 12000);
  assert.ok(docs.length >= 12000);
  const s = differential(bin, docs);
  console.log(
    `  ${docs.length} texts x 2 name schemes: both accept ${s.bothAccept}, both reject ${s.bothReject}, ` +
      `same line ${s.lineMatch}, same message ${s.messageMatch}, expfmt panics skipped ${s.panics}`,
  );
  assert.deepEqual(s.mismatches.slice(0, 5), []);
  assert.equal(s.lineMatch, s.bothReject);
  assert.equal(s.messageMatch, s.bothReject);
  assert.ok(s.bothAccept > 5000 && s.bothReject > 5000, 'corpus must exercise both outcomes');
});

test('serialize: 3000 generated families are byte-identical to expfmt (text, OpenMetrics, OpenMetrics with _created)', { skip, timeout: 280_000 }, () => {
  const { bin } = oracle as { bin: string };
  const s = encodeDifferential(bin, 20260929, 3000);
  console.log(`  ${s.total} encodings: identical ${s.identical}, both error ${s.bothError}`);
  assert.deepEqual(s.mismatches.slice(0, 3), []);
  assert.equal(s.identical + s.bothError, s.total);
  assert.ok(s.identical > 8000);
});
