import { existsSync, readFileSync } from 'node:fs';

/** Minimal .env.local / .env loader (no dependency). Existing process env wins. Never logs values. */
export function loadEnv(files = ['.env.local', '.env']) {
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
