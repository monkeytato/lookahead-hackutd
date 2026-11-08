/**
 * Latest interval-coverage results from `npm run validate` (scripts/validate), surfaced in the UI so a
 * range is never presented as a calibrated p10–p90 before validation shows it is one (audit S1).
 * Update after each validation run (36 scenarios × 50 iterations, perturb = default, seed 1).
 */
export const LATEST_COVERAGE = {
  date: '2026-11-08',
  /** ensemble judged against single draws of itself with priors widened ±30 %, starts ±2 min, rates ±40 % */
  ensemblePerturbed: 0.52 as number | null,
  /** ensemble judged against draws from its own priors (self-consistency check; target 80 ± 3 %) */
  ensemblePriorPredictive: 0.82,
  /** the legacy cascade judged against its own perturbed copy (the 24 % of the audit) */
  legacy: 0.24,
  target: 0.8,
  report: 'reports/validation-2026-11-08-default-ensemble-perturbed.md',
};

/** "model range" until validated coverage is within 75–85 %. */
export function coverageNote(): string {
  const c = LATEST_COVERAGE.ensemblePerturbed;
  if (c === null) return `Model range, not a calibrated p10–p90: ensemble coverage not yet validated (legacy model ${Math.round(LATEST_COVERAGE.legacy * 100)} % against the 80 % target).`;
  const ok = c >= 0.75 && c <= 0.85;
  return `${ok ? 'p10–p90' : 'Model range, not a calibrated p10–p90'}: validated coverage ${Math.round(c * 100)} % against the 80 % target when reality departs from the priors (${Math.round(LATEST_COVERAGE.ensemblePriorPredictive * 100)} % when it does not; validation ${LATEST_COVERAGE.date}).`;
}
