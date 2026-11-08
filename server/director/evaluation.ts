/**
 * Evaluation tools for one workflow incident (PREDICTION-SCIENCE.md §5–§6): the hierarchical
 * ensemble, the red-team stress loop and the EVSI scan table, exposed to the director (Nemotron or
 * the local planner) as three extra tools:
 *
 *   get_context   structured log context (audit C6 — never appended to the capped question)
 *   stress_digest round-0 ensemble per response option + failure digest + EVSI table (cited as stress-1)
 *   stress_test   up to 6 stress regions in a closed JSON grammar → defensive-mixture importance
 *                 sampling; estimates and per-region attribution (cited as stress-N, at most 2 calls)
 *
 * Proposals only steer which trials run; every reported number comes from the engine.
 */
import { facility } from '../../src/domain/fixture';
import { incidentModel, type IncidentModel } from '../../src/domain/scenarios';
import { hashSeed, runEnsemble, runEnsembleAsync, type Ensemble, type EnsembleInput, type OptionSummary } from '../../src/domain/engine/ensemble';
import { scanEvsi, type ScanEvsi } from '../../src/domain/engine/evsi';
import { crossEntropyProposals, failureDigest, stressTest, validateProposals, MAX_REGIONS, type StressResult } from '../../src/domain/engine/stress';
import type { EvaluationOptionLite, EvaluationOutput, EvaluationRequest } from './types';

export const MAX_STRESS_ROUNDS = 2;
const ROUND0 = { outer: 256, inner: 8 };
const STRESS = { outer: 512, inner: 8 };

export interface EvaluationState {
  request: EvaluationRequest;
  model: IncidentModel;
  base: EnsembleInput;
  round0?: Ensemble;
  evsi?: ScanEvsi[];
  stress: { result: StressResult; id: string }[];
  digestId?: string;
  started: number;
}

/** Minimal view of the director session this module needs (avoids a circular import with tools.ts). */
export interface EvalSessionView {
  evaluation?: EvaluationState;
  stressRuns: Map<string, unknown>;
  numbers: Map<string, Set<number>>;
}

export function createEvaluationState(req: EvaluationRequest): EvaluationState {
  const pReal = Math.min(0.999, Math.max(0.001, req.pReal));
  const model = incidentModel(req.kind, pReal, req.installed);
  const base: EnsembleInput = {
    facility, scenario: model.scenario, t: model.t, options: model.options, hypotheses: model.hypotheses, hotspot: model.hotspot,
    leakStartUnknown: model.leakStartUnknown, seed: req.seed ?? hashSeed(req.kind, model.t, pReal.toFixed(4)), ...ROUND0,
  };
  return { request: { ...req, pReal }, model, base, stress: [], started: Date.now() };
}

const pct = (p: number) => Math.round(p * 1000) / 10;
/** Register a value under a cite id: the value, its rounding, and percent forms of probabilities. */
export function registerNumbers(s: EvalSessionView, id: string, values: (number | null | undefined)[], probabilities: (number | null | undefined)[] = []) {
  let set = s.numbers.get(id);
  if (!set) { set = new Set(); s.numbers.set(id, set); }
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) { set.add(v); set.add(Math.round(Math.abs(v) * 10) / 10); set.add(Math.round(Math.abs(v))); }
  for (const p of probabilities) if (typeof p === 'number' && Number.isFinite(p)) { set.add(p); set.add(pct(p)); set.add(Math.round(p * 100)); set.add(Math.round(p * 10000) / 100); }
}

const lite = (s: OptionSummary): EvaluationOptionLite => ({ id: s.id, label: s.label, racks: s.racks, pServiceDown: s.pServiceDown, ci90: s.ci90, firstImpactMin: s.firstImpactMin, firstEnvelopeMin: s.firstEnvelopeMin, expectedUtility: Math.round(s.expectedUtility * 100) / 100 });

function ensureRound0(s: EvalSessionView): Ensemble {
  const ev = s.evaluation!;
  if (!ev.round0) {
    ev.round0 = runEnsemble(ev.base);
    ev.evsi = scanEvsi(ev.round0, ev.model.scanCandidates, ev.model.evsi);
  }
  return ev.round0;
}

/** Round 0 without blocking a browser page: yields every 16 parameter draws (static artifact). */
export async function prepareRound0Async(s: EvalSessionView): Promise<void> {
  const ev = s.evaluation;
  if (!ev || ev.round0) return;
  ev.round0 = await runEnsembleAsync(ev.base);
  ev.evsi = scanEvsi(ev.round0, ev.model.scanCandidates, ev.model.evsi);
}

/** The response compared against "no response": best expected utility among the real actions. */
export function bestResponseIndex(ens: Ensemble): number {
  let best = -1;
  ens.summaries.forEach((x, i) => { if (ens.options[i].action && (best < 0 || x.expectedUtility > ens.summaries[best].expectedUtility)) best = i; });
  return best;
}

export function stressDigest(s: EvalSessionView) {
  const ev = s.evaluation!;
  const ens = ensureRound0(s);
  const id = ev.digestId ?? `stress-${s.stressRuns.size + 1}`;
  const k = bestResponseIndex(ens);
  const digests = [0, ...(k > 0 ? [k] : [])].map((i) => failureDigest(ens, i));
  const content = {
    id,
    incident: { kind: ev.request.kind, scenario: ev.model.scenario.id, now: ev.model.t, horizonMin: ev.model.scenario.horizonMin, pReal: ev.request.pReal, pRealBasis: ev.request.pRealBasis ?? 'evidence posterior (engine)' },
    hypotheses: ev.model.hypotheses.map((h) => ({ family: `h:${h.id}`, label: h.label, p: h.p, basis: h.basis })),
    trials: ens.trials,
    options: ens.summaries.map(lite),
    suggestedOption: k > 0 ? ens.options[k].id : null,
    failure: 'any criticality ≥ 4 service with every replica impacted (inlet ≥ T_trip ~ U(40, 45) °C, or power / water / fire loss) within the horizon',
    digests: digests.map((d) => ({ option: d.option, trials: d.trials, ess: d.ess, pFail: d.pFail, ci90: d.ci90, failingTrials: d.failingTrials, lifts: d.lifts })),
    evsi: (ev.evsi ?? []).slice(0, 5).map((r) => ({ assetId: r.assetId, metric: r.metric, point: r.point, evsi: Math.round(r.evsi * 1000) / 1000, forecastShift: Math.round(r.forecastShift * 1000) / 1000, informs: r.informs, bestActionIfNoScan: r.bestActionIfNoScan })),
    families: {
      bernoulli_use_force_or_set_p: ens.families.filter((f) => f.prior.kind === 'bernoulli').map((f) => ({ id: f.id, label: f.label, p: f.prior.kind === 'bernoulli' ? f.prior.p : null, basis: f.basis })),
      continuous_use_quantile_window: ens.families.filter((f) => f.prior.kind === 'uniform' || f.prior.kind === 'triangular').map((f) => ({ id: f.id, label: f.label, basis: f.basis })),
      log_scale_use_scale_or_quantile_window: ens.families.filter((f) => f.prior.kind === 'lognormal' || f.prior.kind === 'loguniform' || f.prior.kind === 'mixture_lognormal').map((f) => ({ id: f.id, label: f.label, basis: f.basis })),
    },
    grammar: `stress_test proposals: up to ${MAX_REGIONS} regions {label, rationale, terms:[{family, op, …}]} (≤ 6 terms); op quantile_window {lo,hi} (continuous families), force {value: 1|0} or set_p {p ≤ 0.5} (Bernoulli families), scale {f in [0.25, 4]} (lognormal / log-uniform families). Proposals only steer sampling; the engine re-weights every trial (defensive mixture, α = 0.3), so a wrong proposal costs variance, never bias.`,
    units: 'pServiceDown / pFail are probabilities (0–1); racks are counts of racks impacted; *Min are minutes from now; evsi in rack-equivalents (λ = 0.05 per crew-minute)',
  };
  if (!ev.digestId) {
    ev.digestId = id;
    s.stressRuns.set(id, content);
    registerNumbers(s, id, ev.model.hypotheses.flatMap((h) => [...(h.label.match(/d+(?:.d+)?/g) ?? []).map(Number), ...(h.effect.faults ?? []).map((f) => f.t)]));
    registerNumbers(s, id, [ens.trials, ev.model.t, ...ens.summaries.flatMap((x) => [x.racks.p10, x.racks.p50, x.racks.p90, x.racks.mean, x.ess, x.firstImpactMin?.p10, x.firstImpactMin?.p50, x.firstImpactMin?.p90, x.firstEnvelopeMin?.p10, x.firstEnvelopeMin?.p50, x.firstEnvelopeMin?.p90, x.expectedUtility]),
      ...digests.flatMap((d) => [d.ess, d.failingTrials, ...d.lifts.flatMap((l) => [l.liftHigh, l.liftLow])]), ...(ev.evsi ?? []).flatMap((r) => [r.evsi, Math.round(r.evsi * 1000) / 1000])],
      [ev.request.pReal, ...ens.summaries.flatMap((x) => [x.pServiceDown, ...x.ci90]), ...ev.model.hypotheses.map((h) => h.p), ...digests.flatMap((d) => [d.pFail, ...d.ci90])]);
  }
  return content;
}

export function runStressTest(s: EvalSessionView, optionId: unknown, proposals: unknown, by: StressResult['provider']): { ok: true; id: string; result: StressResult } | { ok: false; error: string } {
  const ev = s.evaluation!;
  if (ev.stress.length >= MAX_STRESS_ROUNDS) return { ok: false, error: `stress_test is limited to ${MAX_STRESS_ROUNDS} rounds; cite the stress runs you have and call recommend` };
  const ens = ensureRound0(s);
  const k = typeof optionId === 'string' ? ens.options.findIndex((o) => o.id === optionId) : bestResponseIndex(ens);
  if (k < 0) return { ok: false, error: `unknown option ${JSON.stringify(optionId)}; options: ${ens.options.map((o) => o.id).join(', ')}` };
  const { regions, errors } = validateProposals(proposals, ens.families);
  if (!regions.length) return { ok: false, error: `no valid stress region: ${errors.slice(0, 6).join('; ') || 'empty'}` };
  const { result } = stressTest(ev.base, k, regions, by, errors, STRESS);
  const id = `stress-${s.stressRuns.size + 1}`;
  s.stressRuns.set(id, result);
  ev.stress.push({ result, id });
  registerNumbers(s, id, [result.trials, result.ess, ...result.regions.flatMap((r) => [r.priorOneIn, r.trialsInRegion])], [result.pFail, ...result.ci90, ...result.regions.flatMap((r) => [r.priorMass, r.pFailGivenRegion, r.shareOfFailure])]);
  return { ok: true, id, result };
}

/** Cross-entropy fallback round (used by the local planner, and when Nemotron ran no stress test). */
export function crossEntropyRound(s: EvalSessionView): { id: string; result: StressResult } | null {
  const ev = s.evaluation!;
  if (ev.stress.length >= MAX_STRESS_ROUNDS) return null;
  const ens = ensureRound0(s);
  const k = Math.max(0, bestResponseIndex(ens));
  const r = runStressTest(s, ens.options[k].id, crossEntropyProposals(ens, k), 'cross_entropy');
  return r.ok ? { id: r.id, result: r.result } : null;
}

/** The region to report as the biggest remaining risk: largest share of the failure probability, preferring specific (prior mass < 0.5) regions. */
export function dominantRegion<R extends { shareOfFailure: number; priorMass: number }>(regions: R[]): R | null {
  const cands = regions.filter((r) => r.shareOfFailure > 0);
  if (!cands.length) return null;
  const specific = cands.filter((r) => r.priorMass < 0.5);
  return [...(specific.length ? specific : cands)].sort((a, b) => b.shareOfFailure - a.shareOfFailure || a.priorMass - b.priorMass)[0];
}

/** JSON summary for the workflow (comparison.ensemble). Runs the CE round if no stress test ran. */
export function evaluationOutput(s: EvalSessionView): EvaluationOutput | undefined {
  const ev = s.evaluation;
  if (!ev) return undefined;
  const ens = ensureRound0(s);
  if (!ev.digestId) stressDigest(s);
  if (!ev.stress.length) crossEntropyRound(s);
  const k = bestResponseIndex(ens);
  const last = [...ev.stress].reverse().find((x) => x.result.option === ens.options[Math.max(0, k)].id) ?? ev.stress.at(-1);
  const top = (ev.evsi ?? []).find((r) => r.evsi > 0 || r.forecastShift > 0);
  return {
    kind: ev.request.kind, scenarioId: ev.model.scenario.id, t: ev.model.t,
    pReal: ev.request.pReal, pRealBasis: ev.request.pRealBasis ?? 'evidence posterior (engine)', citeId: ev.digestId!,
    trials: ens.trials, ess: Math.min(...ens.summaries.map((x) => x.ess)),
    options: ens.summaries.map(lite), withOptionId: k >= 0 ? ens.options[k].id : null,
    stress: last ? {
      by: last.result.provider, option: last.result.option, rounds: ev.stress.length, trials: last.result.trials, ess: last.result.ess, pFail: last.result.pFail, ci90: last.result.ci90,
      converged: last.result.converged, maxWeight: last.result.maxWeight, regions: last.result.regions.map((r) => ({ ...r, priorOneIn: Number.isFinite(r.priorOneIn) ? r.priorOneIn : 0 })), rejected: last.result.rejected, citeId: last.id,
    } : null,
    nextScan: top ? { assetId: top.assetId, metric: top.metric, point: top.point, evsi: top.evsi, forecastShift: top.forecastShift, informs: top.informs, bestActionIfNoScan: top.bestActionIfNoScan, bestActionByOutcome: top.bestActionByOutcome } : null,
    hypotheses: ev.model.hypotheses.map((h) => ({ id: h.id, label: h.label, p: h.p, basis: h.basis, basisKind: h.basisKind })),
    elapsedMs: Date.now() - ev.started,
  };
}

export const EVALUATION_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'get_context',
      description: 'Structured log context for this incident: recent recorded events (id, time, summary) and operator notes. Context only: cite event ids, never infer causation from timing.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stress_digest',
      description: 'Round-0 physics-and-priors ensemble for the incident (thousands of trials per response option): P(critical service down) with 90 % interval, racks impacted p10/p50/p90, minutes to first impact and to the 32 °C envelope, the failure digest (families over-represented among failing trials, with lift), the EVSI scan table, and the stress-region grammar. Cited as stress-1. Call once, before stress_test.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stress_test',
      description: `Red-team the chosen response: propose up to ${MAX_REGIONS} stress regions (compound failures most likely to break it) in the closed grammar from stress_digest. The engine samples a defensive mixture and re-weights every trial (estimates stay unbiased), and returns P(failure) with its interval, ESS, and per region its prior probability ("1 in N incidents"), P(failure | region) and share of the failure probability. Cited as stress-N. At most ${MAX_STRESS_ROUNDS} calls.`,
      parameters: {
        type: 'object',
        properties: {
          option: { type: 'string', description: 'Response option id from stress_digest.options (default: suggestedOption)' },
          proposals: {
            type: 'array', maxItems: MAX_REGIONS,
            items: { type: 'object', properties: { label: { type: 'string' }, rationale: { type: 'string' }, terms: { type: 'array', maxItems: 6, items: { type: 'object', properties: { family: { type: 'string' }, op: { type: 'string', enum: ['quantile_window', 'force', 'set_p', 'scale'] }, lo: { type: 'number' }, hi: { type: 'number' }, value: { type: ['number', 'string', 'boolean'] }, p: { type: 'number' }, f: { type: 'number' } }, required: ['family', 'op'] } } }, required: ['label', 'terms'] },
          },
        },
        required: ['proposals'],
      },
    },
  },
] as const;
export const EVALUATION_TOOL_NAMES = EVALUATION_TOOL_DEFS.map((t) => t.function.name) as string[];
