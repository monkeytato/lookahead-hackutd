/**
 * Post-validation of a director recommendation. The rule: the director never produces an
 * authoritative number. Every clock-like number in its text ("T−14", "T+44", "14 min",
 * "12–20 min"), every percentage ("3.2 %"), every count of racks / services / assets and every
 * "1 in N" must match (± rounding) a number some CITED run produced — a run's own clocks, a delta
 * computed from it by compare_runs / scan_value, or a stress-N ensemble result — or a number quoted
 * from the inputs (incident text, context, scans). Anything else is replaced with "[unsupported]" and
 * reported. Unknown run ids are dropped and reported.
 *
 * Direction check (audit C13): a sentence that says "later", "more time" or "buys" next to a cited
 * shift whose sign is negative (or "earlier" / "less time" next to a positive one) is replaced by the
 * engine's own templated sentence. Provenance check: claims that the rig is trustworthy, a sensor is
 * broken / faulty, or equipment is safe are removed (acceptance A04).
 */
import type { Recommendation } from './types';
import type { Session } from './tools';

const TOLERANCE = 1; // ± rounding (engine values carry one decimal; text often rounds to whole minutes)
const RUN_ID = /\b(?:run|stress)-\d+\b/g;
// T−14 / T+44 / T-14   |   14 min, 14-min, 14 minutes, 12–20 min
const CLOCK = /\bT\s*[−–+-]\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)(?:\s*(?:–|-|to)\s*(\d+(?:\.\d+)?))?\s*-?\s*(?:minutes|minute|mins|min)\b/g;
const PERCENT = /(\d+(?:\.\d+)?)\s*%/g;
const COUNT = /\b(\d+)\s+(?:racks?|services?|assets?)\b/g;
const ODDS = /\b1\s+in\s+(\d[\d,]*)/g;
const LATER = /\b(later|more time|buys?|gains?|delays? the)\b/i;
const EARLIER = /\b(earlier|sooner|less time|brings? forward|loses?)\b/i;
const PROVENANCE = /\b(?:rig|probe|sensor|reading|instrument)s?\s+(?:is|are|was|were)\s+(?:trustworthy|reliable|accurate|broken|faulty|defective|bad|wrong|fine)\b|\b(?:equipment|rack|unit|chiller|fan|it)\s+(?:is|are)\s+safe\b|\bsensor\s+(?:failure|fault)\s+(?:confirmed|proven)\b/i;

export interface ValidationResult { recommendation: Recommendation; warnings: string[] }

export function validateRecommendation(rec: Recommendation, session: Session): ValidationResult {
  const warnings: string[] = [];
  const stress = session.stressRuns ?? new Map<string, unknown>();
  const known = (id: string) => session.runs.has(id) || stress.has(id);

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
  const observed = [...(session.observedNumbers ?? [])];
  const supported = (x: number) => allowed.some((a) => Math.abs(Math.abs(a) - x) <= TOLERANCE);
  const supportedPct = (x: number) => [...allowed, ...observed].some((a) => Math.abs(Math.abs(a) - x) <= Math.max(0.15, 0.05 * x));
  const supportedCount = (x: number) => [...allowed, ...observed].some((a) => Math.abs(a) === x);
  const supportedOdds = (x: number) => allowed.some((a) => Math.abs(a - x) <= Math.max(1, 0.05 * x));
  const cites = [...cited].join(', ') || 'none cited';

  const scrub = (text: string, field: string): string => {
    let out = text.replace(CLOCK, (match: string, tNum?: string, a?: string, b?: string) => {
      const nums = [tNum, a, b].filter((v): v is string => v !== undefined).map(Number);
      const bad = nums.filter((n) => !supported(n) && !observed.includes(n));
      if (!bad.length) return match;
      warnings.push(`unsupported_number: "${match.trim()}" in ${field} is not in any cited run (${cites}) — stripped`);
      return '[unsupported]';
    });
    out = out.replace(PERCENT, (match: string, v: string) => {
      if (supportedPct(Number(v))) return match;
      warnings.push(`unsupported_number: "${match.trim()}" in ${field} is not in any cited run (${cites}) — stripped`);
      return '[unsupported]';
    });
    out = out.replace(COUNT, (match: string, v: string) => {
      if (supportedCount(Number(v))) return match;
      warnings.push(`unsupported_number: "${match.trim()}" in ${field} is not in any cited run (${cites}) — stripped`);
      return '[unsupported]';
    });
    out = out.replace(ODDS, (match: string, v: string) => {
      if (supportedOdds(Number(v.replace(/,/g, '')))) return match;
      warnings.push(`unsupported_number: "${match.trim()}" in ${field} is not in any cited run (${cites}) — stripped`);
      return '[unsupported]';
    });
    // sentence-level checks
    return out.split(/(?<=[.;!?])\s+/).map((sentence) => {
      if (PROVENANCE.test(sentence)) {
        warnings.push(`provenance_claim: "${sentence.slice(0, 80)}" in ${field} — removed (readings describe measurements, not equipment)`);
        return '[removed: unsupported claim about the equipment or instrument]';
      }
      const later = LATER.test(sentence), earlier = EARLIER.test(sentence);
      if (later === earlier) return sentence;
      for (const sh of session.shifts ?? []) {
        if (sh.value === 0 || !(cited.has(sh.a) || cited.has(sh.b))) continue;
        const m = Math.abs(sh.value);
        const hit = (sentence.match(/\d+(?:\.\d+)?/g) ?? []).some((n) => Math.abs(Number(n) - m) <= 0.05 + 1e-9);
        if (!hit) continue;
        if ((later && sh.value < 0) || (earlier && sh.value > 0)) {
          warnings.push(`direction_mismatch: "${sentence.slice(0, 80)}" in ${field} contradicts the signed shift ${sh.value} min (${sh.b} − ${sh.a}) — replaced`);
          return `Engine: the ${sh.what} is ${m} min ${sh.value < 0 ? 'earlier (less time)' : 'later (more time)'} in ${sh.b} than in ${sh.a}.`;
        }
      }
      return sentence;
    }).join(' ');
  };

  const out: Recommendation = {
    nextScan: rec.nextScan ? { ...rec.nextScan, reason: scrub(rec.nextScan.reason, 'nextScan.reason') } : null,
    nextAction: scrub(rec.nextAction, 'nextAction'),
    hypotheses: hypotheses.map((h, i) => ({ ...h, label: scrub(h.label, `hypotheses[${i}].label`), support: scrub(h.support, `hypotheses[${i}].support`) })),
    summary: scrub(rec.summary, 'summary'),
  };
  return { recommendation: out, warnings };
}
