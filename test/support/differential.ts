import { parse, ParseError } from '../../src/index.ts';
import { canon, maskUnknown, normalizeMine, normalizeOracle } from './canon.ts';
import type { CanonFamily } from './canon.ts';
import { EDGE_CASES, Gen, mutate } from './gen.ts';
import { runOracle } from './oracle.ts';

interface OracleResult {
  ok?: CanonFamily[];
  err?: { line: number; msg: string };
  panic?: string;
}

export interface Stats {
  total: number;
  bothAccept: number;
  bothReject: number;
  lineMatch: number;
  messageMatch: number;
  panics: number;
  mismatches: string[];
}

export function corpus(seed: number, n: number): Buffer[] {
  const g = new Gen(seed);
  const docs: Buffer[] = EDGE_CASES.map((s) => Buffer.from(s, 'latin1'));
  // The EDGE_CASES with non-ASCII text are written as UTF-8 on purpose.
  docs.push(...EDGE_CASES.filter((s) => /[^\x00-\xff]/.test(s)).map((s) => Buffer.from(s, 'utf8')));
  while (docs.length < n) {
    const doc = Buffer.from(g.document(), 'utf8');
    docs.push(g.chance(0.4) ? doc : mutate(g, doc));
  }
  return docs;
}

export function differential(bin: string, docs: Buffer[]): Stats {
  const results = runOracle<Array<{ utf8: OracleResult; legacy: OracleResult }>>(bin, 'parse', docs.map((d) => d.toString('hex')));
  const stats: Stats = { total: 0, bothAccept: 0, bothReject: 0, lineMatch: 0, messageMatch: 0, panics: 0, mismatches: [] };
  docs.forEach((doc, i) => {
    for (const scheme of ['utf8', 'legacy'] as const) {
      const want = results[i]![scheme];
      stats.total++;
      if (want.panic !== undefined) {
        stats.panics++;
        continue;
      }
      let got: CanonFamily[] | undefined;
      let err: ParseError | undefined;
      try {
        got = canon(parse(doc, { format: 'prometheus', nameValidation: scheme }));
      } catch (e) {
        if (!(e instanceof ParseError)) {
          stats.mismatches.push(`${scheme} ${JSON.stringify(doc.toString('latin1'))}: unexpected ${String(e)}`);
          continue;
        }
        err = e;
      }
      // A metric name inside the braces, on a line that starts with `{`, reads
      // the previous family's type in expfmt (stale parser state), which changes
      // how it groups summary and histogram series. Only accept/reject and line
      // numbers are compared for those documents.
      const staleState = /(^|\n)[ \t]*\{/.test(doc.toString('latin1')) && /summary|histogram/i.test(doc.toString('latin1'));
      const tag = `${scheme} ${JSON.stringify(doc.toString('latin1'))}`;
      if (want.err && err) {
        stats.bothReject++;
        if (want.err.line === err.line) stats.lineMatch++;
        else stats.mismatches.push(`${tag}: line ${err.line} (${err.detail}) vs expfmt ${want.err.line} (${want.err.msg})`);
        if (want.err.msg === err.detail) stats.messageMatch++;
        else if (process.env.SHOW_MSG) console.log(JSON.stringify(doc.toString('latin1')).slice(0, 100), '\n   mine:  ', err.detail, '\n   expfmt:', want.err.msg);
      } else if (want.err) {
        stats.mismatches.push(`${tag}: accepted, expfmt rejects: line ${want.err.line} ${want.err.msg}`);
      } else if (err) {
        stats.mismatches.push(`${tag}: rejected (${err.message}), expfmt accepts`);
      } else {
        stats.bothAccept++;
        const a = normalizeMine(got!);
        const b = normalizeOracle(want.ok);
        maskUnknown(a, b);
        if (!staleState && JSON.stringify(a) !== JSON.stringify(b)) stats.mismatches.push(`${tag}: families differ\n  mine:   ${JSON.stringify(a)}\n  expfmt: ${JSON.stringify(b)}`);
      }
    }
  });
  return stats;
}
