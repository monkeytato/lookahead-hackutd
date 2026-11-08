/**
 * What could be known at scenario minute t (audit C1: no foreknowledge).
 *
 * A scenario script is the WORLD: it says what happens, including faults nobody can see yet. A
 * FORECAST at t may only use what has been observed or can be inferred by t. Every other scripted
 * fault becomes a HYPOTHESIS with a prior probability (published per-hour failure rates × the
 * remaining horizon, or an explicitly labelled assumption) that a caller may opt in, and that the
 * ensemble samples as a Bernoulli family.
 *
 * Observation rules (simple, documented):
 *  - an equipment fault at t_f is observed at the first observation step (reading / alert / note) on
 *    that asset at or after t_f; if the script has none after t_f, the fault is assumed alarmed at t_f
 *    (BMS trip alarm, assumption);
 *  - a leak is inferable only from an observation step at its source asset at or after it starts
 *    (riser leak: the make-up-flow mismatch at T+11, not the unobserved start at T+4);
 *  - a fire is observed when it starts (smoke detection within seconds, assumption) unless the script
 *    has a later observation step at the origin.
 */
import type { Facility, ID, Scenario } from '../types';
import { leakSource } from './simulate';

/** First minute anyone could know about trouble at this asset (alert/reading steps, else its fault). */
export function detectedAt(scenario: Scenario, assetId: ID): number {
  const obs = scenario.steps.filter((s) => s.assetId === assetId && s.kind !== 'fault').map((s) => s.t);
  if (obs.length) return Math.min(...obs);
  const f = scenario.faults.find((x) => x.assetId === assetId);
  return f ? f.t : Infinity;
}

const obsSteps = (s: Scenario, assetId: ID) => s.steps.filter((x) => x.assetId === assetId && x.kind !== 'fault');

/** Minute a fault at `t` on `assetId` becomes known (see the header). */
export function faultObservedAt(scenario: Scenario, assetId: ID, t: number): number {
  const after = obsSteps(scenario, assetId).filter((x) => x.t >= t).map((x) => x.t);
  return after.length ? Math.min(...after) : t;
}

/** Minute the scenario's leak becomes inferable (observation at the source after it starts), else Infinity. */
export function leakInferableAt(facility: Facility, scenario: Scenario): number {
  if (!scenario.leak) return Infinity;
  const src = leakSource(facility, scenario.leak);
  const after = obsSteps(scenario, src).filter((x) => x.t >= scenario.leak!.startT).map((x) => x.t);
  return after.length ? Math.min(...after) : Infinity;
}

export interface AssumedFault {
  assetId: ID;
  t: number;
  /** observed = known by the forecast minute; hypothesis = opted-in what-if; script = replay of the world */
  basis: 'observed' | 'hypothesis' | 'script';
  label: string;
}

export interface FaultHypothesis {
  id: string;
  assetId: ID;
  t: number;
  label: string;
  /** Probability that this happens within the remaining horizon */
  prior: number;
  /** Sensitivity range for the prior, when the prior is an assumption */
  range?: [number, number];
  basis: string;
  basisKind: 'published' | 'assumption';
}

/** Per-hour failure rates by asset type (INL/EXT-21-65055 2020 means; research/derived/reliability_priors.json). */
const RATE_PER_H: Partial<Record<string, { rate: number; basis: string; kind: 'published' | 'assumption' }>> = {
  chiller: { rate: 3.87e-5, basis: 'INL/EXT-21-65055 chiller fail-to-run 3.87e-5/h', kind: 'published' },
  crah: { rate: 2.61e-6, basis: 'INL/EXT-21-65055 AHU fail-to-run 2.61e-6/h', kind: 'published' },
  pump: { rate: 2.26e-6, basis: 'INL/EXT-21-65055 pump fail-to-run 2.26e-6/h', kind: 'published' },
  ups: { rate: 3.49e-6, basis: 'INL/EXT-21-65055 inverter 3.49e-6/h', kind: 'published' },
  battery: { rate: 4.05e-7, basis: 'INL/EXT-21-65055 battery fail-to-operate 4.05e-7/h', kind: 'published' },
  pdu: { rate: 1.73e-7, basis: 'INL/EXT-21-65055 breaker spurious open 1.73e-7/h', kind: 'published' },
  ats: { rate: 1.25e-7, basis: 'INL/EXT-21-65055 ATS spurious 1.25e-7/h', kind: 'published' },
  generator: { rate: 3.31e-3, basis: 'INL/EXT-21-65055 generator fail-to-load/run 3.31e-3/h (when running)', kind: 'published' },
  pipe: { rate: 8.67e-8, basis: 'INL/EXT-21-65055 manual-valve small external leak 8.67e-8/h', kind: 'published' },
  cdu: { rate: 2.26e-6, basis: 'pump fail-to-run 2.26e-6/h used for CDU (assumption)', kind: 'assumption' },
};
const DEFAULT_RATE = { rate: 1e-5, basis: 'no published rate found; 1e-5/h assumed', kind: 'assumption' as const };

/** P(trip within the horizon | a caution-level precursor alarm is active): no P-F interval data (A). */
export const PRECURSOR_TRIP_PRIOR = 0.02;
export const PRECURSOR_TRIP_RANGE: [number, number] = [0.005, 0.1];

/**
 * Every scripted fault that a forecast at t may NOT use, as a hypothesis with a prior:
 * future faults, and current faults nobody can see yet (including an uninferable leak).
 */
export function scriptedHypotheses(facility: Facility, scenario: Scenario, t: number): FaultHypothesis[] {
  const typeOf = new Map(facility.assets.map((a) => [a.id, a.type]));
  const hours = Math.max(0, scenario.horizonMin - t) / 60;
  const out: FaultHypothesis[] = [];
  for (const f of scenario.faults) {
    if (f.t <= t && faultObservedAt(scenario, f.assetId, f.t) <= t) continue;
    // an abnormal precursor already observed on this asset (e.g. CRAH-2 vibration) → incident-implied prior
    const precursor = obsSteps(scenario, f.assetId).some((x) => x.t <= t && x.t < f.t && x.kind === 'alert');
    if (precursor) {
      out.push({ id: `H-${f.assetId}-${f.t}`, assetId: f.assetId, t: f.t, label: `${f.assetId} also fails (precursor alarm active)`, prior: PRECURSOR_TRIP_PRIOR, range: PRECURSOR_TRIP_RANGE, basis: 'P(trip within the horizon | caution alarm) = 0.02, range 0.005–0.1: no P-F interval data found (assumption)', basisKind: 'assumption' });
      continue;
    }
    const r = RATE_PER_H[typeOf.get(f.assetId) ?? ''] ?? DEFAULT_RATE;
    out.push({ id: `H-${f.assetId}-${f.t}`, assetId: f.assetId, t: f.t, label: `${f.assetId} fails ${f.t > t ? `at T+${f.t}` : 'unobserved'}`, prior: 1 - Math.exp(-r.rate * hours), basis: `${r.basis} × ${Math.round(hours * 100) / 100} h remaining`, basisKind: r.kind });
  }
  if (scenario.leak && !(scenario.leak.startT <= t && leakInferableAt(facility, scenario) <= t)) {
    const src = leakSource(facility, scenario.leak);
    const r = RATE_PER_H.pipe!;
    out.push({ id: `H-LEAK-${src}`, assetId: src, t: scenario.leak.startT, label: `${src} leaks (not yet inferable)`, prior: 1 - Math.exp(-r.rate * hours), basis: `${r.basis} × ${Math.round(hours * 100) / 100} h remaining`, basisKind: r.kind });
  }
  return out;
}

/** Faults known at t (see the header). Fires and the leak are handled by `forecastScenario`. */
export function observedFaults(scenario: Scenario, t: number): { assetId: ID; t: number }[] {
  return scenario.faults.filter((f) => f.t <= t && faultObservedAt(scenario, f.assetId, f.t) <= t);
}

/**
 * The scenario a forecast at t may use: observed faults, the leak only once inferable, fires once
 * started, plus the explicitly opted-in hypotheses (by id). Steps (the observed world) are kept.
 */
export function forecastScenario(facility: Facility, scenario: Scenario, t: number, include: string[] = []): { scenario: Scenario; assumed: AssumedFault[]; hypotheses: FaultHypothesis[] } {
  const hypotheses = scriptedHypotheses(facility, scenario, t);
  const chosen = hypotheses.filter((h) => include.includes(h.id));
  const faults = observedFaults(scenario, t);
  const assumed: AssumedFault[] = faults.map((f) => ({ ...f, basis: 'observed', label: `${f.assetId} fault observed by T+${t}` }));
  let leak = scenario.leak && scenario.leak.startT <= t && leakInferableAt(facility, scenario) <= t ? scenario.leak : undefined;
  for (const h of chosen) {
    if (h.id.startsWith('H-LEAK-')) leak = scenario.leak;
    else faults.push({ assetId: h.assetId, t: h.t });
    assumed.push({ assetId: h.assetId, t: h.t, basis: 'hypothesis', label: `if ${h.label} (P ≈ ${h.prior.toPrecision(2)}, ${h.basisKind === 'assumption' ? 'assumption' : 'published rate'})` });
  }
  const leakHyp = chosen.some((h) => h.id.startsWith('H-LEAK-'));
  if (leak && !leakHyp) assumed.push({ assetId: leakSource(facility, leak), t: leak.startT, basis: 'observed', label: `leak at ${leakSource(facility, leak)} inferred by T+${t}` });
  const hazards = (scenario.hazards ?? []).filter((h) => h.startT <= t);
  return { scenario: { ...scenario, faults, leak, hazards: scenario.hazards ? hazards : undefined }, assumed, hypotheses };
}
