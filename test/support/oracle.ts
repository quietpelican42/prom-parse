import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const oracleDir = path.resolve(here, '../oracle');
const cacheDir = path.resolve(here, '../../.cache');

/** Build the Go helper (prometheus/common expfmt v0.72.0). Returns undefined, with a reason, when Go is unavailable. */
export function buildOracle(): { bin: string } | { skip: string } {
  const which = spawnSync('go', ['version'], { timeout: 20_000 });
  if (which.status !== 0) return { skip: 'go is not installed; skipping the expfmt differential' };
  fs.mkdirSync(cacheDir, { recursive: true });
  const bin = path.join(cacheDir, 'oracle-bin');
  try {
    execFileSync('go', ['build', '-o', bin, '.'], {
      cwd: oracleDir,
      timeout: 300_000,
      env: { ...process.env, GOFLAGS: '-mod=mod' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { skip: `could not build the Go oracle (needs network for modules): ${(e as Error).message.slice(0, 200)}` };
  }
  return { bin };
}

export function runOracle<T>(bin: string, mode: 'parse' | 'encode', input: unknown): T {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'promparse-')), 'in.json');
  fs.writeFileSync(f, JSON.stringify(input));
  const out = execFileSync(bin, [mode, f], { timeout: 300_000, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
  return JSON.parse(out.toString('utf8')) as T;
}
