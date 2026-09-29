import assert from 'node:assert/strict';
import test from 'node:test';
import { parse, ParseError } from '../src/index.ts';
import { loadSuite } from './support/om-suite.ts';

const suite = await loadSuite();

test('OpenMetrics suite: every valid case parses and every invalid case is rejected', { skip: typeof suite === 'string' ? `SKIPPED LOUDLY: ${suite}` : false }, () => {
  const cases = suite as Exclude<typeof suite, string>;
  assert.equal(cases.length, 211);
  assert.equal(cases.filter((c) => c.shouldParse).length, 44);
  const wrong: string[] = [];
  for (const c of cases) {
    let accepted = true;
    try {
      parse(c.metrics, { format: 'openmetrics' });
    } catch (e) {
      assert.ok(e instanceof ParseError, `${c.name}: expected ParseError, got ${String(e)}`);
      assert.ok(e.line >= 1, `${c.name}: error has no line number`);
      accepted = false;
    }
    if (accepted !== c.shouldParse) wrong.push(`${c.name} (should${c.shouldParse ? '' : ' not'} parse)`);
  }
  assert.deepEqual(wrong, []);
});

test('OpenMetrics suite: auto-detection picks OpenMetrics for every case', { skip: typeof suite === 'string' ? `SKIPPED LOUDLY: ${suite}` : false }, () => {
  const cases = suite as Exclude<typeof suite, string>;
  for (const c of cases) {
    if (!c.shouldParse) continue;
    // Cases that end in `# EOF` with no newline are still detected.
    parse(c.metrics);
  }
});
