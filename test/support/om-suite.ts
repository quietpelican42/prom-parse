import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/** prometheus/OpenMetrics (Apache-2.0), pinned. The suite is fetched at test time and never committed. */
export const OM_SHA = '42cbeb674d91064a1ca5cab72741d87159064550';
/** sha256 over the sorted `path NUL content NUL` of every file under tests/testdata/parsers. */
export const OM_DIGEST = '33eea959747a66f01b75e84d11fe9f59139dccb3173a0d4206f62e0a24a8bb99';
const PREFIX = `OpenMetrics-${OM_SHA}/tests/testdata/parsers/`;

const here = path.dirname(fileURLToPath(import.meta.url));
const cache = path.resolve(here, '../../.cache/openmetrics', OM_SHA);

export interface SuiteCase {
  name: string;
  shouldParse: boolean;
  metrics: Buffer;
}

function untar(tar: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let off = 0;
  let longName: string | undefined;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    let name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(h[156]!);
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      if (m) longName = m[1];
      continue;
    }
    if (longName) {
      name = longName;
      longName = undefined;
    }
    if (type === '0' || type === '\0') files.set(name, Buffer.from(body));
  }
  return files;
}

function digest(files: Map<string, Buffer>): string {
  const h = createHash('sha256');
  for (const name of [...files.keys()].sort()) {
    h.update(name);
    h.update('\0');
    h.update(files.get(name)!);
    h.update('\0');
  }
  return h.digest('hex');
}

/** Fetch (or read from `.cache`) the parser test cases. Returns a reason string when unavailable. */
export async function loadSuite(): Promise<SuiteCase[] | string> {
  let files: Map<string, Buffer> | undefined;
  const cached = path.join(cache, 'parsers.json');
  try {
    const j = JSON.parse(fs.readFileSync(cached, 'utf8')) as Record<string, string>;
    files = new Map(Object.entries(j).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
  } catch {
    try {
      const res = await fetch(`https://codeload.github.com/prometheus/OpenMetrics/tar.gz/${OM_SHA}`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) return `could not fetch the OpenMetrics suite: HTTP ${res.status}`;
      const all = untar(gunzipSync(Buffer.from(await res.arrayBuffer())));
      files = new Map([...all].filter(([k]) => k.startsWith(PREFIX)).map(([k, v]) => [k.slice(PREFIX.length), v]));
    } catch (e) {
      return `could not fetch the OpenMetrics suite (${(e as Error).message}); run with network access to check the 211 cases`;
    }
    const got = digest(files);
    if (got !== OM_DIGEST) return `OpenMetrics suite digest mismatch: expected ${OM_DIGEST}, got ${got}`;
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(cached, JSON.stringify(Object.fromEntries([...files].map(([k, v]) => [k, v.toString('base64')]))));
  }
  if (digest(files) !== OM_DIGEST) return 'cached OpenMetrics suite failed its digest check; delete .cache and retry';
  const cases: SuiteCase[] = [];
  const dirs = new Set([...files.keys()].map((k) => k.split('/')[0]!));
  for (const d of [...dirs].sort()) {
    const tj = files.get(`${d}/test.json`);
    const metrics = files.get(`${d}/metrics`);
    if (!tj || !metrics) continue;
    cases.push({ name: d, shouldParse: (JSON.parse(tj.toString('utf8')) as { shouldParse: boolean }).shouldParse, metrics });
  }
  return cases;
}
