/**
 * Post-validation of a director recommendation. The rule: the director never produces an
 * authoritative number. Every clock-like number in its text ("T−14", "T+44", "14 min",
 * "12–20 min") must match (± rounding) a number some CITED run produced — a run's own clocks or a
 * delta computed from it by compare_runs / scan_value. Anything else is replaced with
 * "[unsupported]" and reported. Unknown run ids are dropped and reported.
 */
import type { Recommendation } from './types';
import type { Session } from './tools';

const TOLERANCE = 1; // ± rounding (engine values carry one decimal; text often rounds to whole minutes)
const RUN_ID = /\brun-\d+\b/g;
// T−14 / T+44 / T-14   |   14 min, 14-min, 14 minutes, 12–20 min
const CLOCK = /\bT\s*[−–+-]\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)(?:\s*(?:–|-|to)\s*(\d+(?:\.\d+)?))?\s*-?\s*(?:minutes|minute|mins|min)\b/g;

export interface ValidationResult { recommendation: Recommendation; warnings: string[] }

export function validateRecommendation(rec: Recommendation, session: Session): ValidationResult {
  const warnings: string[] = [];
  const known = (id: string) => session.runs.has(id);

  // 1. run ids: hypotheses must cite runs that exist
  const hypotheses = rec.hypotheses.map((h) => {
    const bad = h.runIds.filter((r) => !known(r));
    for (const r of bad) warnings.push(`unknown_run_id: ${r} cited by hypothesis "${h.label.slice(0, 60)}" — removed`);
    return { ...h, runIds: h.runIds.filter(known) };
  });

  const texts = [rec.summary, rec.nextAction, rec.nextScan?.reason ?? '', ...hypotheses.flatMap((h) => [h.label, h.support])];
  const mentioned = new Set<string>();
  for (const t of texts) for (const m of t.match(RUN_ID) ?? []) mentioned.add(m);
  for (const r of mentioned) if (!known(r)) warnings.push(`unknown_run_id: ${r} mentioned in text`);

  const cited = new Set<string>([...hypotheses.flatMap((h) => h.runIds), ...[...mentioned].filter(known)]);
  const allowed: number[] = [];
  for (const id of cited) for (const v of session.numbers.get(id) ?? []) allowed.push(v);
  const supported = (x: number) => allowed.some((a) => Math.abs(Math.abs(a) - x) <= TOLERANCE);

  const scrub = (text: string, field: string): string =>
    text.replace(CLOCK, (match: string, tNum?: string, a?: string, b?: string) => {
      const nums = [tNum, a, b].filter((v): v is string => v !== undefined).map(Number);
      const bad = nums.filter((n) => !supported(n));
      if (!bad.length) return match;
      warnings.push(`unsupported_number: "${match.trim()}" in ${field} is not in any cited run (${[...cited].join(', ') || 'none cited'}) — stripped`);
      return '[unsupported]';
    });

  const out: Recommendation = {
    nextScan: rec.nextScan ? { ...rec.nextScan, reason: scrub(rec.nextScan.reason, 'nextScan.reason') } : null,
    nextAction: scrub(rec.nextAction, 'nextAction'),
    hypotheses: hypotheses.map((h, i) => ({ ...h, label: scrub(h.label, `hypotheses[${i}].label`), support: scrub(h.support, `hypotheses[${i}].support`) })),
    summary: scrub(rec.summary, 'summary'),
  };
  return { recommendation: out, warnings };
}
