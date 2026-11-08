import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Project root (server/..): the env files are found even when the bridge is started from another directory. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env.local / .env loader (no dependency). Existing process env wins. Never logs values. */
export function loadEnv(files = ['.env.local', '.env'].map((f) => join(ROOT, f))) {
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || m[1] in process.env) continue;
      const v = m[2].replace(/^['"]|['"]$/g, '');
      if (v) process.env[m[1]] = v;
    }
  }
}
