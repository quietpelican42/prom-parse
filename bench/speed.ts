/** Parse throughput on a synthetic exposition. `node bench/speed.ts` */
import { parse, serialize } from '../src/index.ts';

let text = '';
for (let f = 0; f < 200; f++) {
  text += `# HELP svc_${f}_seconds Latency of service ${f}.\n# TYPE svc_${f}_seconds histogram\n`;
  for (let r = 0; r < 25; r++) {
    for (const le of ['0.005', '0.01', '0.05', '0.1', '0.5', '1', '5', '+Inf']) text += `svc_${f}_seconds_bucket{route="/r${r}",method="GET",le="${le}"} ${r * 3}\n`;
    text += `svc_${f}_seconds_sum{route="/r${r}",method="GET"} ${r * 1.25}\nsvc_${f}_seconds_count{route="/r${r}",method="GET"} ${r * 3}\n`;
  }
}
const mb = Buffer.byteLength(text) / 1e6;
const time = (label: string, fn: () => unknown) => {
  fn();
  const runs: number[] = [];
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    fn();
    runs.push(performance.now() - t);
  }
  runs.sort((a, b) => a - b);
  console.log(`${label}: ${mb.toFixed(1)} MB, median ${runs[3]!.toFixed(0)} ms (${(mb / (runs[3]! / 1000)).toFixed(0)} MB/s), range ${runs[0]!.toFixed(0)}-${runs[6]!.toFixed(0)} ms`);
};
const fams = parse(text);
time('parse prometheus ', () => parse(text, { format: 'prometheus' }));
const om = serialize(fams, 'openmetrics');
time('parse openmetrics', () => parse(om, { format: 'openmetrics' }));
time('serialize        ', () => serialize(fams, 'prometheus'));
