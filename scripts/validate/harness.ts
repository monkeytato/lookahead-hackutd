/**
 * Prediction validation harness.
 *
 * Question: when the engine says "this rack is lost at T+44 (p10–p90 38–51)", does a world whose
 * physics differ from the model's assumptions actually behave like that?
 *
 * For each scenario:
 *   1. MODEL: the unperturbed simulateScenario run (Monte Carlo, 400 runs) — what the dashboard shows.
 *      The prediction is judged at a decision time td = first observable signal + detection lag.
 *   2. REALITY: many single-outcome runs on a PERTURBED copy of the facility and scenario:
 *        - every dependency delay drawn from a wider range than the model's, with a per-iteration
 *          systematic bias (the model's ranges are assumptions; reality need not respect them)
 *        - fault / leak / hazard start times jittered
 *        - leak rate and fire/smoke spread speed scaled
 *        - detection lag from sensor noise, stale or missing readings (moves td later)
 *   3. Compare per asset lost after td: interval coverage, p50 error, misses, false alarms,
 *      first-rack accuracy; and for the best fix at td, predicted vs realized racks saved.
 *
 * Pure: no I/O. run.ts is the CLI, report.ts formats.
 */
import { facility as baseFacility, seedReadings, scenarios as fixtureScenarios } from '../../src/domain/fixture';
import { simulateScenario, type ScenarioRun } from '../../src/domain/engine/simulate';
import { fixOptionsFor, makeFix, predictFix, type FixOption } from '../../src/domain/engine/fixes';
import { mulberry32 } from '../../src/domain/engine/rng';
import { getScenario, realScenarios } from '../../src/domain/scenarios';
import type { AssetType, Facility, Fix, ID, Reading, Scenario } from '../../src/domain/types';
import { assetClocks, runEnsemble } from '../../src/domain/engine/ensemble';
import { PRIORS, type Prior } from '../../src/domain/engine/priors';

export type PerturbLevel = 'mild' | 'default' | 'harsh';

export interface Perturbation {
  /** Reality delay range = model [min, max] widened by this fraction on each side */
  widen: number;
  /** Per-iteration systematic multiplier on all delays: uniform in [1 - bias, 1 + bias] */
  bias: number;
  /** Fault / leak / hazard start jitter, ± minutes */
  startJitterMin: number;
  /** Leak rate and hazard spread scale: uniform in [1 - x, 1 + x] */
  rateSpread: number;
  /** Probability that the first signal is missed (stale / missing reading) */
  missedSignalP: number;
  /** Extra detection lag when a signal is missed, minutes (uniform 0..x); plus noise lag 0..1 min always */
  missedLagMin: number;
}

export const PERTURB: Record<PerturbLevel, Perturbation> = {
  mild: { widen: 0.15, bias: 0.1, startJitterMin: 1, rateSpread: 0.2, missedSignalP: 0.1, missedLagMin: 3 },
  default: { widen: 0.3, bias: 0.2, startJitterMin: 2, rateSpread: 0.4, missedSignalP: 0.2, missedLagMin: 5 },
  harsh: { widen: 0.5, bias: 0.35, startJitterMin: 3, rateSpread: 0.6, missedSignalP: 0.35, missedLagMin: 8 },
};

export interface ValidateOptions {
  iterations: number;
  randomSeeds: number;
  perturb: PerturbLevel;
  seed: number;
  /** Restrict to these scenario ids (tests); default: fixtures + real + random */
  scenarioIds?: string[];
  /** Model Monte Carlo runs (default 400, as the dashboard) */
  modelRuns?: number;
  /** Skip the fix check (faster) */
  skipFixes?: boolean;
  /**
   * What is judged (PREDICTION-SCIENCE.md §7.2):
   *  cascade (default): the legacy 400-run cascade (simulateScenario) — the dashboard's script run
   *  ensemble: the hierarchical physics-and-priors ensemble (per-asset weighted p10/p50/p90)
   */
  model?: 'cascade' | 'ensemble';
  /**
   * Against which reality:
   *  legacy (default): single runs of the PERTURBED legacy cascade (the harness as before)
   *  perturbed: single draws of the ensemble with every prior widened by the perturbation level, starts jittered, rates scaled
   *  prior_predictive: single draws from the model's own priors (self-consistency: should be about 80 %)
   */
  reality?: 'legacy' | 'perturbed' | 'prior_predictive';
}

export interface Tally {
  /** realized losses after td that the model also predicted (has p10..p90) */
  scored: number;
  inside: number;
  absErrSum: number;
  /** realized loss after td, model p50 says not lost within the horizon */
  misses: number;
  /** model p50 loss after td, never lost in reality */
  falseAlarms: number;
  /** losses that happened in reality after td (denominator for miss rate) */
  realLosses: number;
  /** model-predicted losses after td (denominator for false-alarm rate) */
  predictedLosses: number;
  /** signed error sum (reality − p50): > 0 means reality is slower than predicted */
  signedErrSum: number;
}

export interface FixCheck {
  label: string;
  orderedAt: number;
  predictedSaved: number;
  realizedSavedMean: number;
  realizedSavedMin: number;
  realizedSavedMax: number;
  /** share of iterations where |realized − predicted| ≤ 2 racks */
  withinTwo: number;
}

export interface ScenarioResult {
  id: string;
  name: string;
  kind: string;
  decisionT: number;
  iterations: number;
  tally: Tally;
  byType: Record<string, Tally>;
  firstRackRight: number;
  firstRackJudged: number;
  /** mean detection lag added by noise / stale readings, minutes */
  meanDetectLag: number;
  fix: FixCheck | null;
}

export interface ValidationReport {
  options: ValidateOptions & { perturbation: Perturbation };
  startedAt: string;
  elapsedMs: number;
  scenarios: ScenarioResult[];
  overall: Tally;
  byType: Record<string, Tally>;
  byKind: Record<string, Tally>;
  firstRack: { right: number; judged: number };
  fixes: { checked: number; withinTwo: number; meanPredicted: number; meanRealized: number };
}

export const emptyTally = (): Tally => ({ scored: 0, inside: 0, absErrSum: 0, misses: 0, falseAlarms: 0, realLosses: 0, predictedLosses: 0, signedErrSum: 0 });
export function addTally(a: Tally, b: Tally): Tally {
  return {
    scored: a.scored + b.scored, inside: a.inside + b.inside, absErrSum: a.absErrSum + b.absErrSum, misses: a.misses + b.misses,
    falseAlarms: a.falseAlarms + b.falseAlarms, realLosses: a.realLosses + b.realLosses, predictedLosses: a.predictedLosses + b.predictedLosses,
    signedErrSum: a.signedErrSum + b.signedErrSum,
  };
}
export const coverage = (t: Tally) => (t.scored ? t.inside / t.scored : NaN);
export const meanAbsErr = (t: Tally) => (t.scored ? t.absErrSum / t.scored : NaN);
export const meanBias = (t: Tally) => (t.scored ? t.signedErrSum / t.scored : NaN);
export const missRate = (t: Tally) => (t.realLosses ? t.misses / t.realLosses : NaN);
export const falseAlarmRate = (t: Tally) => (t.predictedLosses ? t.falseAlarms / t.predictedLosses : NaN);

// ------------------------------------------------------------------ scenarios

export function scenarioSet(o: ValidateOptions): Scenario[] {
  if (o.scenarioIds?.length) return o.scenarioIds.map(getScenario);
  const rand = mulberry32(o.seed ^ 0x5eed);
  const random: Scenario[] = [];
  for (let i = 0; i < o.randomSeeds; i++) random.push(getScenario(`rnd-${Math.floor(rand() * 1e9).toString(36)}`));
  const seen = new Set<string>();
  return [...fixtureScenarios, ...realScenarios, ...random].filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
}

/** First minute anyone could know: the earliest non-fault step, else the earliest fault/leak/hazard. */
export function firstSignal(s: Scenario): number {
  const obs = s.steps.filter((x) => x.kind !== 'fault').map((x) => x.t);
  if (obs.length) return Math.min(...obs);
  const starts = [...s.faults.map((f) => f.t), ...(s.leak ? [s.leak.startT] : []), ...(s.hazards ?? []).map((h) => h.startT)];
  return starts.length ? Math.min(...starts) : 0;
}

// ------------------------------------------------------------------ perturbation

const uni = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();

/** A reality: facility with every delay fixed to one draw, and a jittered scenario. */
export function perturb(facility: Facility, s: Scenario, p: Perturbation, r: () => number): { facility: Facility; scenario: Scenario } {
  const bias = uni(r, 1 - p.bias, 1 + p.bias);
  const edges = facility.edges.map((e) => {
    const lo = Math.max(0, e.delay.min * (1 - p.widen));
    const hi = e.delay.max * (1 + p.widen);
    // triangular over the widened range, mode kept, then the systematic bias
    const mode = Math.min(hi, Math.max(lo, e.delay.mode));
    const u = r();
    const c = hi > lo ? (mode - lo) / (hi - lo) : 0.5;
    const tri = hi <= lo ? lo : u < c ? lo + Math.sqrt(u * (hi - lo) * (mode - lo)) : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - mode));
    const d = Math.max(0, tri * bias);
    return { ...e, delay: { min: d, mode: d, max: d } };
  });
  const jit = () => uni(r, -p.startJitterMin, p.startJitterMin);
  const shiftBy = new Map<ID, number>();
  const faults = s.faults.map((f) => {
    const dt = jit();
    shiftBy.set(f.assetId, dt);
    return { ...f, t: Math.max(0, f.t + dt) };
  });
  const steps = s.steps.map((st) => ({ ...st, t: Math.max(0, st.t + (shiftBy.get(st.assetId) ?? 0)) }));
  const scale = () => uni(r, 1 - p.rateSpread, 1 + p.rateSpread);
  const leak = s.leak ? { ...s.leak, startT: Math.max(0, s.leak.startT + jit()), ratePerMin: s.leak.ratePerMin * scale() } : undefined;
  const hazards = s.hazards?.map((h) => ({ ...h, startT: Math.max(0, h.startT + jit()), spreadMPerMin: h.spreadMPerMin * scale() }));
  return { facility: { ...facility, edges }, scenario: { ...s, faults, steps, leak, hazards } };
}

// ------------------------------------------------------------------ one scenario

const typeOf = new Map<ID, AssetType>(baseFacility.assets.map((a) => [a.id, a.type]));
const rackIds = new Set(baseFacility.assets.filter((a) => a.type === 'rack').map((a) => a.id));

/** Realized loss minute per asset in a single-outcome run (runs: 1 → p50 is the outcome). */
function realized(run: ScenarioRun): Map<ID, number> {
  const m = new Map<ID, number>();
  for (const c of Object.values(run.clocks)) if (c.p50 !== null && typeOf.has(c.assetId)) m.set(c.assetId, c.p50);
  return m;
}

/**
 * The fix an operator would pick: at each signal time (+1 min) in the scenario, every root-cause option
 * on offer; keep the one the model says saves the most racks (earliest on ties).
 */
function bestFix(s: Scenario, model: ScenarioRun, readings: Reading[]): { option: FixOption; saved: number; at: number } | null {
  const times = [...new Set(s.steps.filter((x) => x.kind !== 'fault').map((x) => x.t + 1))].filter((t) => t < s.horizonMin).sort((a, b) => a - b);
  if (!times.length) times.push(firstSignal(s) + 1);
  let best: { option: FixOption; saved: number; at: number } | null = null;
  for (const t of times.slice(0, 8)) {
    const ctx = { facility: baseFacility, scenario: s, seedReadings: readings, fixes: [] as Fix[], t, run: model };
    for (const a of baseFacility.assets) {
      if (a.type === 'rack') continue; // rack-level fixes save one rack at a time; judge the root-cause fixes
      for (const o of fixOptionsFor(ctx, a.id)) {
        const p = predictFix(ctx, o);
        const saved = p.racksWithout - p.racksWith;
        if (!best || saved > best.saved) best = { option: o, saved, at: t };
      }
    }
  }
  return best;
}

/** Priors widened by the perturbation level (reality for the 'perturbed' ensemble regime). */
export function widenedPriors(p: Perturbation): Partial<Record<string, Prior>> {
  const out: Partial<Record<string, Prior>> = {};
  for (const [id, spec] of Object.entries(PRIORS)) {
    const q = spec.prior;
    if (q.kind === 'uniform') { const d = (q.hi - q.lo) * p.widen; out[id] = { kind: 'uniform', lo: q.lo > 0 ? Math.max(q.lo * 0.25, q.lo - d) : q.lo - d, hi: q.hi + d }; }
    else if (q.kind === 'loguniform') { const d = Math.log(q.hi / q.lo) * p.widen; out[id] = { kind: 'loguniform', lo: q.lo * Math.exp(-d), hi: q.hi * Math.exp(d) }; }
    else if (q.kind === 'lognormal') out[id] = { kind: 'lognormal', median: q.median, sigmaLn: q.sigmaLn * (1 + p.widen) + p.bias / 2 };
    else if (q.kind === 'triangular') { const d = (q.max - q.min) * p.widen; out[id] = { kind: 'triangular', min: Math.max(0, q.min - d), mode: q.mode, max: q.max + d }; }
  }
  // fraction families stay in [0, 1]
  for (const id of ['battery_soh_A', 'battery_soh_B', 'coil_frac', 'it_eps', 'mix_frac']) { const u = out[id]; if (u && u.kind === 'uniform') out[id] = { kind: 'uniform', lo: Math.max(0.01, u.lo), hi: Math.min(1, u.hi) }; }
  return out;
}

/** One realised world drawn from the ensemble (reality for the 'perturbed' / 'prior_predictive' regimes). */
function ensembleReality(s: Scenario, o: ValidateOptions, r: () => number): Map<ID, number> {
  const p = PERTURB[o.perturb];
  let scenario = s;
  if (o.reality === 'perturbed') {
    const jit = () => uni(r, -p.startJitterMin, p.startJitterMin);
    const shift = new Map<ID, number>();
    const faults = s.faults.map((f) => { const d = jit(); shift.set(f.assetId, d); return { ...f, t: Math.max(0, f.t + d) }; });
    const steps = s.steps.map((st) => ({ ...st, t: Math.max(0, st.t + (shift.get(st.assetId) ?? 0)) }));
    const leak = s.leak ? { ...s.leak, startT: Math.max(0, s.leak.startT + jit()), ratePerMin: s.leak.ratePerMin * uni(r, 1 - p.rateSpread, 1 + p.rateSpread) } : undefined;
    const hazards = s.hazards?.map((h) => ({ ...h, startT: Math.max(0, h.startT + jit()), spreadMPerMin: h.spreadMPerMin * uni(r, 1 - p.rateSpread, 1 + p.rateSpread) }));
    scenario = { ...s, faults, steps, leak, hazards };
  }
  const ens = runEnsemble({ facility: baseFacility, scenario, t: 0, options: [{ id: 'none', label: 'none' }], outer: 1, inner: 1, seed: Math.floor(r() * 1e9), keepAssetTimes: true, noStratify: true, priorOverride: o.reality === 'perturbed' ? widenedPriors(p) : undefined });
  const out = new Map<ID, number>();
  for (const [id, c] of Object.entries(assetClocks(ens))) if (c.p50 !== null && typeOf.has(id)) out.set(id, c.p50);
  return out;
}

export function validateScenario(s: Scenario, o: ValidateOptions, rand: () => number): ScenarioResult {
  const p = PERTURB[o.perturb];
  const readings = seedReadings();
  const ensembleModel = o.model === 'ensemble';
  const model = ensembleModel
    ? { clocks: assetClocks(runEnsemble({ facility: baseFacility, scenario: s, t: 0, options: [{ id: 'none', label: 'none' }], outer: 128, inner: 4, seed: o.seed, keepAssetTimes: true, noStratify: true })) as Record<ID, { p10: number | null; p50: number | null; p90: number | null }> }
    : simulateScenario({ facility: baseFacility, scenario: s, seedReadings: readings, runs: o.modelRuns ?? 400 });
  const signal = firstSignal(s);
  // the operator acts one minute after the first signal; the model is judged from there
  const td = signal + 1;
  const fix = o.skipFixes || ensembleModel ? null : bestFix(s, model as ScenarioRun, readings);

  const tally = emptyTally();
  const byType: Record<string, Tally> = {};
  let firstRight = 0, firstJudged = 0, lagSum = 0;
  const fixSaved: number[] = [];

  // model's first rack after td
  let modelFirst: { id: ID; t: number } | null = null;
  for (const [assetId, c] of Object.entries(model.clocks)) {
    if (!rackIds.has(assetId) || c.p50 === null || c.p50 <= td) continue;
    if (!modelFirst || c.p50 < modelFirst.t) modelFirst = { id: assetId, t: c.p50 };
  }

  for (let i = 0; i < o.iterations; i++) {
    const world = perturb(baseFacility, s, p, rand);
    // detection: noise always costs up to a minute; a missed / stale signal costs more
    const lag = rand() * 1 + (rand() < p.missedSignalP ? rand() * p.missedLagMin : 0);
    lagSum += lag;
    const legacyReality = (o.reality ?? 'legacy') === 'legacy';
    const realTd = (legacyReality ? firstSignal(world.scenario) : firstSignal(s)) + 1 + (o.reality === 'prior_predictive' ? 0 : lag);
    const reality = legacyReality ? simulateScenario({ facility: world.facility, scenario: world.scenario, seedReadings: readings, runs: 1, seed: Math.floor(rand() * 1e9) }) : null;
    const real = reality ? realized(reality) : ensembleReality(s, o, rand);

    const ids = new Set<ID>([...real.keys(), ...Object.keys(model.clocks).filter((id) => typeOf.has(id))]);
    for (const id of ids) {
      const rt = real.get(id);
      const c = model.clocks[id];
      const realAfter = rt !== undefined && rt > realTd;
      const predAfter = !!c && c.p50 !== null && c.p50 > td;
      if (!realAfter && !predAfter) continue;
      const t: Tally = emptyTally();
      if (realAfter) t.realLosses = 1;
      if (predAfter) t.predictedLosses = 1;
      if (realAfter && c && c.p50 !== null) {
        const lo = c.p10 ?? c.p50, hi = c.p90 ?? Infinity;
        t.scored = 1;
        t.inside = rt! >= lo && rt! <= hi ? 1 : 0;
        t.absErrSum = Math.abs(rt! - c.p50);
        t.signedErrSum = rt! - c.p50;
      } else if (realAfter) {
        t.misses = 1;
      } else if (predAfter && rt === undefined) {
        t.falseAlarms = 1;
      }
      Object.assign(tally, addTally(tally, t));
      const ty = typeOf.get(id) ?? 'other';
      byType[ty] = addTally(byType[ty] ?? emptyTally(), t);
    }

    // first rack: right if the model's first rack is among the racks reality loses first (±0.5 min ties)
    let realFirst = Infinity;
    for (const [id, t] of real) if (rackIds.has(id) && t > realTd) realFirst = Math.min(realFirst, t);
    if (modelFirst && realFirst < Infinity) {
      firstJudged++;
      const rt = real.get(modelFirst.id);
      if (rt !== undefined && rt <= realFirst + 0.5) firstRight++;
    }

    // fix: same perturbed world, with and without the fix, ordered as late as the realized detection lag makes it
    if (fix && reality) {
      const f = makeFix(fix.option, fix.at + lag);
      const withFix = simulateScenario({ facility: world.facility, scenario: world.scenario, seedReadings: readings, runs: 1, fixes: [f] });
      const racksLost = (m: Map<ID, number>) => [...m.keys()].filter((id) => rackIds.has(id)).length;
      fixSaved.push(racksLost(real) - racksLost(realized(withFix)));
    }
  }

  return {
    id: s.id, name: s.headline ?? s.name, kind: s.kind ?? 'what-if', decisionT: td, iterations: o.iterations, tally, byType,
    firstRackRight: firstRight, firstRackJudged: firstJudged, meanDetectLag: o.iterations ? lagSum / o.iterations : 0,
    fix: fix && fixSaved.length ? {
      label: fix.option.label, orderedAt: fix.at, predictedSaved: fix.saved,
      realizedSavedMean: fixSaved.reduce((a, b) => a + b, 0) / fixSaved.length,
      realizedSavedMin: Math.min(...fixSaved), realizedSavedMax: Math.max(...fixSaved),
      withinTwo: fixSaved.filter((x) => Math.abs(x - fix.saved) <= 2).length / fixSaved.length,
    } : null,
  };
}

export function runValidation(o: ValidateOptions, onScenario?: (r: ScenarioResult, i: number, n: number) => void): ValidationReport {
  const started = Date.now();
  const rand = mulberry32(o.seed);
  const list = scenarioSet(o);
  const results: ScenarioResult[] = [];
  list.forEach((s, i) => {
    const r = validateScenario(s, o, rand);
    results.push(r);
    onScenario?.(r, i, list.length);
  });
  let overall = emptyTally();
  const byType: Record<string, Tally> = {};
  const byKind: Record<string, Tally> = {};
  let right = 0, judged = 0;
  for (const r of results) {
    overall = addTally(overall, r.tally);
    byKind[r.kind] = addTally(byKind[r.kind] ?? emptyTally(), r.tally);
    for (const [k, t] of Object.entries(r.byType)) byType[k] = addTally(byType[k] ?? emptyTally(), t);
    right += r.firstRackRight; judged += r.firstRackJudged;
  }
  const fx = results.map((r) => r.fix).filter((f): f is FixCheck => !!f);
  return {
    options: { ...o, perturbation: PERTURB[o.perturb] },
    startedAt: new Date(started).toISOString(),
    elapsedMs: Date.now() - started,
    scenarios: results, overall, byType, byKind,
    firstRack: { right, judged },
    fixes: {
      checked: fx.length,
      withinTwo: fx.length ? fx.reduce((a, f) => a + f.withinTwo, 0) / fx.length : NaN,
      meanPredicted: fx.length ? fx.reduce((a, f) => a + f.predictedSaved, 0) / fx.length : NaN,
      meanRealized: fx.length ? fx.reduce((a, f) => a + f.realizedSavedMean, 0) / fx.length : NaN,
    },
  };
}
