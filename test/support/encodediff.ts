import { serialize, SerializeError } from '../../src/index.ts';
import { genFamily, toFamily } from './encodegen.ts';
import type { EFam } from './encodegen.ts';
import { Gen } from './gen.ts';
import { runOracle } from './oracle.ts';

export interface EncodeStats {
  total: number;
  identical: number;
  bothError: number;
  mismatches: string[];
}

export function encodeDifferential(bin: string, seed: number, n: number): EncodeStats {
  const g = new Gen(seed);
  const fams: EFam[] = [];
  for (let i = 0; i < n; i++) fams.push(genFamily(g));
  const cases: Array<{ fam: EFam; format: 'text' | 'om'; created: boolean }> = [];
  for (const fam of fams) {
    cases.push({ fam, format: 'text', created: false });
    cases.push({ fam, format: 'om', created: false });
    cases.push({ fam, format: 'om', created: true });
  }
  const want = runOracle<Array<{ out: string; err?: string }>>(bin, 'encode', cases);
  const stats: EncodeStats = { total: cases.length, identical: 0, bothError: 0, mismatches: [] };
  cases.forEach((c, i) => {
    const w = want[i]!;
    let got: string | undefined;
    let err: string | undefined;
    try {
      const family = toFamily(c.fam);
      got =
        c.format === 'text'
          ? serialize([family], 'prometheus')
          : serialize([family], 'openmetrics', { createdLines: c.created, eof: false });
    } catch (e) {
      if (!(e instanceof SerializeError)) throw e;
      err = e.message;
    }
    const tag = `${c.format}${c.created ? '+created' : ''} ${JSON.stringify(c.fam)}`;
    if (w.err !== undefined && w.err !== '') {
      if (err !== undefined) stats.bothError++;
      else stats.mismatches.push(`${tag}: expfmt errors (${w.err.slice(0, 80)}), we wrote ${JSON.stringify(got)}`);
    } else if (err !== undefined) {
      stats.mismatches.push(`${tag}: we error (${err}), expfmt wrote ${JSON.stringify(w.out)}`);
    } else if (got !== w.out) {
      stats.mismatches.push(`${tag}:\n  mine:   ${JSON.stringify(got)}\n  expfmt: ${JSON.stringify(w.out)}`);
    } else stats.identical++;
  });
  return stats;
}
