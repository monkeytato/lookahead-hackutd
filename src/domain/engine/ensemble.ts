/**
 * Two-level (hierarchical) Monte Carlo ensemble — PREDICTION-SCIENCE.md §2.7 and §6 Step 3.
 *
 *   outer draw θ (epistemic, shared by every rack in a trial): physics parameters of the zone model,
 *     on-demand failures (generator, ATS, UPS, standby CRAH, chiller restart), battery health, crew
 *     speed, leak rate / film / start, hazard spread, hypotheses (P(real), what-ifs) …
 *   inner draws (aleatory): the remaining triangular edge delays, generator start time, DLC throttle
 *     time, battery runtime at load, which UPS drops on transfer.
 *
 * The cooling edges take their per-trial delay from the physics zone model (thermalZone.ts), one draw
 * per zone, so racks in a zone are correlated. Two clocks per rack: the 32 °C envelope crossing and the
 * service-impact crossing at T_trip. "Impacted" means the service-impact clock (or a power / water /
 * fire loss) fired within the horizon.
 *
 * Importance sampling (Design A): an optional defensive mixture q = α·b + (1 − α)·mean_k q_k over the
 * base sampler b; every trial carries w = p/q, so the self-normalised estimates stay consistent
 * whatever regions are proposed (stress.ts validates them). The base sampler b is the prior, except
 * that hypothesis families are drawn at 0.5 (stratified) so both branches are always explored.
 *
 * Every number reported here is engine output. Seeded: identical input → identical output.
 */
import type { DependencyEdge, Facility, FixAction, ID, Scenario } from '../types';
import { compileGraph, runOnce } from './cascade';
import { hazardArrival } from './hazard';
import { leakInferableAt } from './observable';
import { PRIORS, cdf, logpdf, quantile, type Basis, type FamilyId, type Prior } from './priors';
import { mulberry32, sampleTriangular } from './rng';
import { leakSource } from './simulate';
import { ENVELOPE_C, zoneClocks, zonesFor, type ThermalTheta } from './thermalZone';
import { simulateWater, waterArrival } from './water';

// ------------------------------------------------------------------ public types

export interface Family { id: string; prior: Prior; label: string; basis: Basis; source: string; hypothesis?: boolean }

export interface EnsembleOption {
  id: string;
  label: string;
  /** absent = "no action" */
  action?: FixAction;
  assetId?: ID;
  /** Fixture walk + work delay (minutes); the trial scales it by crew_mult */
  delayMin?: number;
}

export interface EnsembleHypothesis {
  /** family id becomes `h:<id>` */
  id: string;
  label: string;
  /** P(true) — a published-rate prior, an assumption, or the evidence posterior P(real) */
  p: number;
  basis: string;
  basisKind: Basis;
  /** what happens in a trial where the hypothesis is true */
  effect: { faults?: { assetId: ID; t: number }[]; leak?: boolean; hotspot?: boolean };
}

/** A local hot spot at one rack (sensor incident): only exists in trials where its hypothesis is true. */
export interface HotspotSpec { assetId: ID; nowC: number; zoneC: number }

export interface StressTerm { family: string; op: 'quantile_window' | 'force' | 'set_p' | 'scale'; lo?: number; hi?: number; value?: number; p?: number; f?: number }
export interface StressRegion { label: string; rationale?: string; terms: StressTerm[] }
export interface Mixture { alpha: number; regions: StressRegion[] }

export interface EnsembleInput {
  facility: Facility;
  /** Already forecast-filtered by the caller (observable.ts) — or a script for validation */
  scenario: Scenario;
  /** "now", scenario minutes: fixes are ordered now */
  t: number;
  options: EnsembleOption[];
  hypotheses?: EnsembleHypothesis[];
  hotspot?: HotspotSpec;
  /** Leak start is not observed: start = inferred-at − leak_lead_min (forecast). Default: scripted start. */
  leakStartUnknown?: boolean;
  outer?: number;
  inner?: number;
  seed?: number;
  mixture?: Mixture;
  /** Stop drawing new θ once this many ms have passed (outer is then smaller; reported) */
  budgetMs?: number;
  /** Keep per-trial loss times of every node (validation harness) */
  keepAssetTimes?: boolean;
  /** Replace prior families (validation: widened "perturbed" or exact "prior-predictive" realities) */
  priorOverride?: Partial<Record<string, Prior>>;
  /** Draw hypothesis families at their prior instead of 0.5 (validation realities) */
  noStratify?: boolean;
  extraEdges?: DependencyEdge[];
}

export interface Quantiles { p10: number | null; p50: number | null; p90: number | null }
export interface OptionSummary {
  id: string;
  label: string;
  trials: number;
  ess: number;
  racks: { p10: number; p50: number; p90: number; mean: number };
  /** P(any criticality ≥ 4 service has every replica impacted by the horizon) */
  pServiceDown: number;
  ci90: [number, number];
  /** minutes from now to the first rack service impact / first rack out of the 32 °C envelope */
  firstImpactMin: Quantiles | null;
  firstEnvelopeMin: Quantiles | null;
  /** P(rack impacted) and its p50 minutes from now, racks with P ≥ 0.01 */
  perRack: Record<ID, { pImpact: number; p50Min: number | null }>;
  /** expected utility (rack-equivalents, negative) and its parts */
  expectedUtility: number;
  /**
   * 100 representative futures for playback: the weighted 0.5 %, 1.5 %, … 99.5 % quantiles of the
   * minutes from now to the 32 °C envelope and to service impact (null = not within the horizon),
   * ascending. Marginal quantiles paired by rank (a quantile dotplot), not individual trials.
   */
  futures: { envelope: (number | null)[]; impact: (number | null)[] };
}

export interface OptionOutcome {
  F: Uint8Array;
  racks: Float32Array;
  score: Float32Array;
  firstImpact: Float32Array;
  firstEnvelope: Float32Array;
  crewMin: Float32Array;
  U: Float32Array;
  /** trial × node loss minute (Infinity = not lost), when keepAssetTimes */
  assetTimes?: Float32Array;
}

export interface Ensemble {
  t: number;
  horizonMin: number;
  outer: number;
  inner: number;
  trials: number;
  families: Family[];
  /** outer × families: drawn value and its CDF position */
  x: Float64Array;
  u: Float64Array;
  /** weight per outer draw (p/q); every inner trial of an outer draw shares it */
  wOuter: Float64Array;
  /** mixture component per outer draw: −1 = base sampler, k = region k */
  component: Int16Array;
  options: EnsembleOption[];
  outcomes: OptionOutcome[];
  summaries: OptionSummary[];
  nodeIds: ID[];
  rackIds: ID[];
  /** per trial absolute minute the water reaches each asset (no-action water), for scan EVSI */
  waterAt: Map<ID, Float32Array>;
  /** trial-level hypothesis tags (family index → Uint8Array per trial) */
  tags: Map<string, Uint8Array>;
  hotspotAssetId?: ID;
  mixture?: Mixture;
  elapsedMs: number;
  seed: number;
}

export const UTILITY_LAMBDA = 0.05; // rack-equivalents per crew-minute (assumption, shown in the UI)

// ------------------------------------------------------------------ helpers

/** Weighted quantile (sort by value, cumulative normalised weight). Infinity allowed. */
export function weightedQuantile(values: ArrayLike<number>, weights: ArrayLike<number>, q: number): number {
  const n = values.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b]);
  let tot = 0;
  for (let i = 0; i < n; i++) tot += weights[i];
  let c = 0;
  for (const i of idx) { c += weights[i] / tot; if (c >= q - 1e-12) return values[i]; }
  return values[idx[n - 1]];
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const fin = (x: number) => (Number.isFinite(x) ? x : null);

/** FNV-1a 32-bit — seeds from (incident, t, evidence) so a replay is identical. */
export function hashSeed(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join('|')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// water arrival offsets (minutes after leak start) per stop-offset bin, cached per leak geometry
const STOP_BINS = [3, 6, 10, 15, 22, 30];
const waterCache = new Map<string, { offsets: Map<number, Record<ID, number>>; source: ID }>();
function waterOffsets(facility: Facility, leak: NonNullable<Scenario['leak']>): { offsets: Map<number, Record<ID, number>>; source: ID } {
  const key = JSON.stringify([facility.id, leak.x, leak.z, leak.ratePerMin, leak.sourceFailsAfterMin ?? 0]);
  const hit = waterCache.get(key);
  if (hit) return hit;
  const base = { x: leak.x, z: leak.z, ratePerMin: leak.ratePerMin, startT: 0 };
  const offsets = new Map<number, Record<ID, number>>();
  offsets.set(Infinity, waterArrival(simulateWater(facility, base, 90), facility));
  for (const s of STOP_BINS) offsets.set(s, waterArrival(simulateWater(facility, { ...base, stopT: s }, 90), facility));
  const v = { offsets, source: leakSource(facility, leak) };
  waterCache.set(key, v);
  if (waterCache.size > 16) waterCache.delete(waterCache.keys().next().value!);
  return v;
}

/** Families of one ensemble: the §3 priors plus one Bernoulli per hypothesis. */
export function familiesFor(hypotheses: EnsembleHypothesis[] = [], override: Partial<Record<string, Prior>> = {}): Family[] {
  const out: Family[] = (Object.keys(PRIORS) as FamilyId[]).map((id) => ({ id, prior: override[id] ?? PRIORS[id].prior, label: PRIORS[id].label, basis: PRIORS[id].basis, source: PRIORS[id].source }));
  for (const h of hypotheses) out.push({ id: `h:${h.id}`, prior: override[`h:${h.id}`] ?? { kind: 'bernoulli', p: Math.min(1, Math.max(0, h.p)) }, label: h.label, basis: h.basisKind, source: h.basis, hypothesis: true });
  return out;
}

// ------------------------------------------------------------------ sampling

interface Sampler {
  families: Family[];
  base: Prior[];
  draw(rand: () => number, x: Float64Array, u: Float64Array, off: number): { w: number; component: number };
}

function baseOf(f: Family, noStratify: boolean): Prior {
  if (!f.hypothesis || noStratify || f.prior.kind !== 'bernoulli') return f.prior;
  const p = f.prior.p;
  return p >= 0.3 && p <= 0.7 ? f.prior : { kind: 'bernoulli', p: 0.5 };
}

/** Density ratio q_term / b for one family value (b = base sampler, p = prior). */
function termRatio(term: StressTerm, prior: Prior, base: Prior, x: number, u: number): number {
  switch (term.op) {
    case 'quantile_window': return u >= term.lo! && u <= term.hi! ? 1 / Math.max(1e-9, term.hi! - term.lo!) : 0;
    case 'force': return x === term.value ? 1 / Math.exp(logpdf(base, term.value!)) : 0;
    case 'set_p': return Math.exp(logpdf({ kind: 'bernoulli', p: term.p! }, x) - logpdf(base, x));
    case 'scale': {
      const lp = logpdf(prior, x);
      if (!Number.isFinite(lp)) return Infinity; // outside the prior's support: weight 0
      return Math.exp(logpdf(prior, x / term.f!) - Math.log(term.f!) - lp);
    }
  }
}

function makeSampler(families: Family[], mixture: Mixture | undefined, noStratify: boolean): Sampler {
  const base = families.map((f) => baseOf(f, noStratify));
  const index = new Map(families.map((f, i) => [f.id, i]));
  const regions = (mixture?.regions ?? []).map((r) => r.terms.filter((t) => index.has(t.family)).map((t) => ({ t, i: index.get(t.family)! })));
  const alpha = mixture ? Math.min(1, Math.max(0.05, mixture.alpha)) : 1;
  const K = regions.length;
  return {
    families, base,
    draw(rand, x, u, off) {
      let component = -1;
      if (K && rand() >= alpha) component = Math.min(K - 1, Math.floor(rand() * K));
      for (let i = 0; i < families.length; i++) {
        const v = rand();
        const val = quantile(base[i], v);
        x[off + i] = val;
        u[off + i] = base[i].kind === 'bernoulli' ? val : v;
      }
      if (component >= 0) {
        for (const { t, i } of regions[component]) {
          const pr = families[i].prior;
          const v = rand();
          if (t.op === 'quantile_window') { const uu = t.lo! + (t.hi! - t.lo!) * v; x[off + i] = quantile(pr, uu); u[off + i] = uu; }
          else if (t.op === 'force') { x[off + i] = t.value!; u[off + i] = t.value!; }
          else if (t.op === 'set_p') { const val = v < t.p! ? 1 : 0; x[off + i] = val; u[off + i] = val; }
          else { const val = t.f! * quantile(pr, v); x[off + i] = val; u[off + i] = pr.kind === 'bernoulli' ? val : cdf(pr, val); }
        }
      }
      // w = p/q = (p/b) · b/q,  b/q = 1 / (α + (1 − α) · mean_k Π q_k,f / b_f)  ≤ 1/α
      let lw = 0;
      for (let i = 0; i < families.length; i++) if (families[i].prior !== base[i]) lw += logpdf(families[i].prior, x[off + i]) - logpdf(base[i], x[off + i]);
      let w = Math.exp(lw);
      if (K) {
        let s = 0;
        for (const reg of regions) {
          let r = 1;
          for (const { t, i } of reg) { r *= termRatio(t, families[i].prior, base[i], x[off + i], u[off + i]); if (r === 0) break; }
          s += r;
        }
        const denom = alpha + ((1 - alpha) * s) / K;
        w = Number.isFinite(denom) ? w / denom : 0;
      }
      return { w, component };
    },
  };
}

// ------------------------------------------------------------------ the engine

const CRIT_SERVICE = 4;

type EdgeKind = 'tri' | 'chw' | 'flow' | 'off' | 'dlc' | 'battery' | 'gen';

/** Run the ensemble synchronously. */
export function runEnsemble(input: EnsembleInput): Ensemble {
  const it = ensembleSteps(input);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

/** Same as runEnsemble, yielding to the event loop between chunks (keeps a browser UI responsive). */
export async function runEnsembleAsync(input: EnsembleInput, yieldMs = 0): Promise<Ensemble> {
  const it = ensembleSteps(input);
  let r = it.next();
  while (!r.done) { await new Promise((res) => setTimeout(res, yieldMs)); r = it.next(); }
  return r.value;
}

export function* ensembleSteps(input: EnsembleInput): Generator<number, Ensemble, void> {
  const started = Date.now();
  const { facility, scenario, t: now } = input;
  const horizon = scenario.horizonMin;
  const OUTER = Math.max(1, input.outer ?? 256);
  const INNER = Math.max(1, input.inner ?? 8);
  const seed = input.seed ?? 7;
  const rand = mulberry32(seed);
  const families = familiesFor(input.hypotheses, input.priorOverride);
  const F = families.length;
  const fi = new Map(families.map((f, i) => [f.id, i]));
  const sampler = makeSampler(families, input.mixture, !!input.noStratify);
  const hall = zonesFor(facility);
  const zoneOfCrah = new Map<ID, string>();
  for (const z of hall.zones) for (const c of z.crahs) zoneOfCrah.set(c, z.id);
  const typeOf = new Map(facility.assets.map((a) => [a.id, a.type]));

  // ---- graph + per-edge delay model
  const leak = scenario.leak;
  const water = leak ? waterOffsets(facility, leak) : null;
  const faultIds = new Set<ID>([...scenario.faults.map((f) => f.assetId), 'GEN-1', 'ATS-1', 'UPS-A', 'UPS-B']);
  for (const h of input.hypotheses ?? []) for (const f of h.effect.faults ?? []) faultIds.add(f.assetId);
  if (water) faultIds.add(water.source);
  const g = compileGraph(facility, input.extraEdges ?? [], [...faultIds]);
  const { N, E, edges, index } = g;
  const kinds: EdgeKind[] = edges.map((e) => {
    const ft = typeOf.get(e.from), tt = typeOf.get(e.to);
    if (e.kind === 'cools' && ft === 'chiller') return 'chw';
    if (e.kind === 'cools' && ft === 'pump' && tt === 'crah') return 'flow';
    if (e.kind === 'cools' && ft === 'crah' && tt === 'rack') return 'off';
    if (e.kind === 'cools' && ft === 'cdu' && tt === 'rack') return 'dlc';
    if (e.kind === 'powers' && ft === 'ats' && tt === 'battery') return 'battery';
    if (e.kind === 'powers' && ft === 'generator') return 'gen';
    return 'tri';
  });
  const edgeZone = edges.map((e) => zoneOfCrah.get(typeOf.get(e.to) === 'crah' ? e.to : e.from) ?? hall.zones[0]?.id ?? '');
  const sohIdx = edges.map((e) => (e.to.endsWith('-B') ? fi.get('battery_soh_B')! : fi.get('battery_soh_A')!));

  const rackIds = facility.assets.filter((a) => a.type === 'rack').map((a) => a.id);
  const rackIdx = Int32Array.from(rackIds, (id) => index.get(id)!);
  const svc = facility.services;
  const critW = new Float32Array(rackIds.length).fill(1);
  rackIds.forEach((id, k) => { for (const s of svc) if (s.replicas.includes(id)) critW[k] = Math.max(critW[k], s.criticality); });
  const critServices = svc.filter((s) => s.criticality >= CRIT_SERVICE && s.replicas.length).map((s) => s.replicas.map((r) => rackIds.indexOf(r)).filter((k) => k >= 0));

  const utilT = Math.min(...scenario.faults.filter((f) => f.assetId === 'UTIL').map((f) => f.t), Infinity);
  const inferredAt = leak ? Math.min(leakInferableAt(facility, scenario), now) : Infinity;
  const hotIdx = input.hotspot ? rackIds.indexOf(input.hotspot.assetId) : -1;
  const hotHyp = (input.hypotheses ?? []).find((h) => h.effect.hotspot);
  const leakHyp = (input.hypotheses ?? []).find((h) => h.effect.leak);

  // ---- storage
  const opts = input.options;
  const O = opts.length;
  const maxTrials = OUTER * INNER;
  const x = new Float64Array(OUTER * F), u = new Float64Array(OUTER * F);
  const wOuter = new Float64Array(OUTER);
  const component = new Int16Array(OUTER);
  const outcomes: OptionOutcome[] = opts.map(() => ({
    F: new Uint8Array(maxTrials), racks: new Float32Array(maxTrials), score: new Float32Array(maxTrials),
    firstImpact: new Float32Array(maxTrials), firstEnvelope: new Float32Array(maxTrials), crewMin: new Float32Array(maxTrials), U: new Float32Array(maxTrials),
    assetTimes: input.keepAssetTimes ? new Float32Array(maxTrials * N) : undefined,
  }));
  const waterAt = new Map<ID, Float32Array>();
  if (water) for (const id of Object.keys(water.offsets.get(Infinity)!)) waterAt.set(id, new Float32Array(maxTrials).fill(Infinity));
  const tags = new Map<string, Uint8Array>();
  for (const f of families) if (f.hypothesis) tags.set(f.id, new Uint8Array(maxTrials));

  const dTrip = new Float64Array(E), dEnv = new Float64Array(E);
  const faultT = new Float64Array(N), fixT = new Float64Array(N);
  const loss = new Float64Array(N), rec = new Float64Array(N), cause = new Int32Array(N);
  const lossEnv = new Float64Array(N);
  const impacted = new Uint8Array(rackIds.length);
  const X = (id: string, o: number) => x[o * F + fi.get(id)!];

  let outerDone = 0;
  for (let o = 0; o < OUTER; o++) {
    if (input.budgetMs !== undefined && o >= 16 && Date.now() - started > input.budgetMs) break;
    const dr = sampler.draw(rand, x, u, o * F);
    wOuter[o] = dr.w; component[o] = dr.component;
    const th: ThermalTheta = {
      kG: X('k_G', o), eps: X('it_eps', o), rackMassKg: X('rack_mass', o), ceilingM: X('ceiling_m', o), plenumM: X('plenum', o) * 0.6,
      mixFrac: X('mix_frac', o), loopLPerKw: X('loop_l_per_kw', o), coilFrac: X('coil_frac', o), startC: 22.5, tTripC: X('t_trip', o),
    };
    const zc = zoneClocks(hall, th, horizon + 30);
    const crew = X('crew_mult', o);
    const hOn = (id: string) => X(`h:${id}`, o) >= 0.5;
    const leakOn = !!leak && (!leakHyp || hOn(leakHyp.id));
    const rateMult = X('leak_rate_mult', o);
    const fScale = (1 / rateMult) * (X('retain_mm', o) / 4); // volume-limited front: arrival ∝ film / rate (assumption)
    const leakStart = leak ? (input.leakStartUnknown ? Math.max(0, inferredAt - X('leak_lead_min', o)) : leak.startT) : Infinity;
    const spread = X('spread_mult', o);
    const hotOn = hotIdx >= 0 && !!hotHyp && hOn(hotHyp.id);
    const rise = X('hotspot_rise', o), tau = X('hotspot_tau', o);

    // fix effect time and success per option (shared by the inner draws)
    const fixAt: number[] = opts.map((op) => {
      if (!op.action) return Infinity;
      if (op.action === 'restart_chiller') return X('chiller_restart_fail', o) >= 0.5 ? Infinity : now + 3 * crew + X('chiller_restart_min', o);
      if (op.action === 'swap_crah' && X('standby_crah_fts', o) >= 0.5) return Infinity;
      if (op.action === 'manual_gen_start' && X('gen_fts', o) >= 0.5) return Infinity;
      return now + (op.delayMin ?? 5) * crew;
    });

    for (let k = 0; k < INNER; k++) {
      const trial = o * INNER + k;
      for (const [id, arr] of tags) arr[trial] = X(id, o) >= 0.5 ? 1 : 0;
      // ---- inner draws: edge delays (the trip and envelope clocks differ only on cooling edges)
      for (let ei = 0; ei < E; ei++) {
        const e = edges[ei];
        const kind = kinds[ei];
        let a: number, b: number;
        if (kind === 'off') { const z = zc.off.get(edgeZone[ei])!; a = z[0]; b = z[1]; }
        else if (kind === 'flow') { const z = zc.off.get(edgeZone[ei])!; a = Math.max(0, zc.flow[0] - z[0]); b = Math.max(0, zc.flow[1] - z[1]); }
        else if (kind === 'chw') { a = Math.max(0, zc.chw[0] - zc.flow[0]); b = Math.max(0, zc.chw[1] - zc.flow[1]); }
        else if (kind === 'dlc') { a = b = sampleTriangular(rand, 0.3, 0.6, 2.0); }
        else if (kind === 'battery') { a = b = sampleTriangular(rand, e.delay.min, e.delay.mode, e.delay.max) * x[o * F + sohIdx[ei]]; }
        else if (kind === 'gen') { a = b = sampleTriangular(rand, 0.15, 0.5, 3.2); }
        else { a = b = sampleTriangular(rand, e.delay.min, e.delay.mode, e.delay.max); }
        dEnv[ei] = Number.isNaN(a) ? Infinity : a; dTrip[ei] = Number.isNaN(b) ? Infinity : b;
      }
      const upsDrop = rand() < 0.5 ? 'UPS-A' : 'UPS-B';
      if (water && leakOn) {
        const base = water.offsets.get(Infinity)!;
        for (const [id, arr] of waterAt) { const off = base[id]; arr[trial] = off === undefined ? Infinity : leakStart + off * fScale; }
      }

      for (let oi = 0; oi < O; oi++) {
        const op = opts[oi];
        const tf = fixAt[oi];
        faultT.fill(Infinity); fixT.fill(Infinity);
        const fault = (id: ID, t: number) => { const n = index.get(id); if (n !== undefined && t < faultT[n]) faultT[n] = t; };
        for (const f of scenario.faults) fault(f.assetId, f.t);
        for (const h of input.hypotheses ?? []) if (hOn(h.id)) for (const f of h.effect.faults ?? []) fault(f.assetId, f.t);
        // on-demand failures when the utility is lost
        if (utilT < Infinity) {
          if (X('gen_fts', o) >= 0.5) fault('GEN-1', utilT);
          if (X('ats_ftt', o) >= 0.5) fault('ATS-1', utilT);
          if (X('ups_transfer_fail', o) >= 0.5) fault(upsDrop, utilT);
        }
        // water: the source fails, wet assets fail at their (scaled) arrival; isolation stops the water
        if (water && leakOn) {
          const stop = op.action === 'isolate_valve' && op.assetId === water.source ? tf : Infinity;
          let offs = water.offsets.get(Infinity)!;
          if (stop < Infinity) {
            const sRef = (stop - leakStart) / fScale;
            const bin = sRef <= 0 ? null : STOP_BINS.find((s) => s >= sRef);
            offs = bin === null ? {} : bin === undefined ? offs : water.offsets.get(bin)!;
          }
          if (!(stop <= leakStart)) fault(water.source, leakStart + (leak!.sourceFailsAfterMin ?? 0) / rateMult);
          for (const [id, off] of Object.entries(offs)) if (id !== water.source) fault(id, leakStart + off * fScale);
        }
        for (const hz of scenario.hazards ?? []) {
          if (hz.kind !== 'fire') continue;
          const stopT = op.action === 'suppress_fire' && op.assetId === hz.originAssetId ? tf : Infinity;
          const arr = hazardArrival(facility, { ...hz, spreadMPerMin: hz.spreadMPerMin * spread }, horizon, stopT);
          for (const [id, ta] of Object.entries(arr)) fault(id, ta);
        }
        if (op.action && op.assetId && tf < Infinity) { const n = index.get(op.assetId); if (n !== undefined) fixT[n] = Math.min(fixT[n], tf); }

        runOnce(g, dEnv, faultT, fixT, loss, rec, cause);
        lossEnv.set(loss);
        runOnce(g, dTrip, faultT, fixT, loss, rec, cause);

        // hot spot at one rack (sensor incident): relaxes toward nowC + rise; a rack fix pulls it back
        let hotImpact = Infinity, hotEnv = Infinity;
        if (hotOn) {
          const hs = input.hotspot!;
          const kFix = op.assetId === hs.assetId ? (op.action === 'shed_load' ? 0.5 : op.action === 'deploy_portable_cooling' ? 0.3 : 1) : 1;
          let T = hs.nowC;
          if (T >= ENVELOPE_C) hotEnv = now;
          const target0 = hs.nowC + rise;
          const target1 = hs.zoneC + (target0 - hs.zoneC) * kFix;
          const step = 1 - Math.exp(-0.25 / tau);
          for (let tt = now; tt <= horizon; tt += 0.25) {
            T += ((tt >= tf ? target1 : target0) - T) * step;
            if (hotEnv === Infinity && T >= ENVELOPE_C) hotEnv = tt;
            if (T >= th.tTripC) { hotImpact = tt; break; }
          }
        }

        const out = outcomes[oi];
        let count = 0, score = 0, first = Infinity, firstEnv = Infinity;
        impacted.fill(0);
        for (let r = 0; r < rackIds.length; r++) {
          let lt = loss[rackIdx[r]], le = lossEnv[rackIdx[r]];
          if (r === hotIdx) { lt = Math.min(lt, hotImpact); le = Math.min(le, hotEnv); }
          if (lt <= horizon) { impacted[r] = 1; count++; score += critW[r]; if (lt < first) first = lt; }
          if (le <= horizon && le < firstEnv) firstEnv = le;
        }
        let down = 0;
        for (const reps of critServices) if (reps.every((q) => impacted[q])) { down = 1; break; }
        const crewMin = op.action ? (op.delayMin ?? 5) * crew : 0;
        out.F[trial] = down; out.racks[trial] = count; out.score[trial] = score;
        out.firstImpact[trial] = first; out.firstEnvelope[trial] = firstEnv; out.crewMin[trial] = crewMin;
        out.U[trial] = -score - UTILITY_LAMBDA * crewMin;
        if (out.assetTimes) for (let n = 0; n < N; n++) out.assetTimes[trial * N + n] = loss[n] <= horizon ? loss[n] : Infinity;
      }
    }
    outerDone = o + 1;
    if ((o & 15) === 15) yield outerDone;
  }

  // ---- trim to what was drawn
  const trials = outerDone * INNER;
  for (const out of outcomes) {
    out.F = out.F.subarray(0, trials); out.racks = out.racks.subarray(0, trials); out.score = out.score.subarray(0, trials);
    out.firstImpact = out.firstImpact.subarray(0, trials); out.firstEnvelope = out.firstEnvelope.subarray(0, trials);
    out.crewMin = out.crewMin.subarray(0, trials); out.U = out.U.subarray(0, trials);
    if (out.assetTimes) out.assetTimes = out.assetTimes.subarray(0, trials * N);
  }
  for (const [id, a] of waterAt) waterAt.set(id, a.subarray(0, trials));
  for (const [id, a] of tags) tags.set(id, a.subarray(0, trials));
  const ens: Ensemble = {
    t: now, horizonMin: horizon, outer: outerDone, inner: INNER, trials, families,
    x: x.subarray(0, outerDone * F), u: u.subarray(0, outerDone * F), wOuter: wOuter.subarray(0, outerDone), component: component.subarray(0, outerDone),
    options: opts, outcomes, summaries: [], nodeIds: g.ids, rackIds, waterAt, tags, hotspotAssetId: input.hotspot?.assetId,
    mixture: input.mixture, elapsedMs: 0, seed,
  };
  ens.summaries = opts.map((_, i) => summarizeOption(ens, i));
  ens.elapsedMs = Date.now() - started;
  return ens;
}

// ------------------------------------------------------------------ estimates

/** Weight of each trial (its outer draw's weight). */
export function trialWeights(ens: Ensemble): Float64Array {
  const w = new Float64Array(ens.trials);
  for (let i = 0; i < ens.trials; i++) w[i] = ens.wOuter[Math.floor(i / ens.inner)];
  return w;
}

/**
 * Self-normalised estimate of E[v] with a 90 % interval from the outer-level (cluster) variance;
 * zero events → [0, upper] with upper = 2.3 / ESS (one-sided 90 %, rule of three).
 */
export function weightedMean(ens: Ensemble, v: ArrayLike<number>, mask?: ArrayLike<number>): { mean: number; ci90: [number, number]; ess: number; mass: number } {
  const W = ens.outer, I = ens.inner;
  let sw = 0, sw2 = 0, swv = 0;
  const means = new Float64Array(W), ws = new Float64Array(W);
  for (let o = 0; o < W; o++) {
    let s = 0, m = 0;
    for (let k = 0; k < I; k++) { const i = o * I + k; const inc = mask ? mask[i] : 1; s += inc * v[i]; m += inc; }
    const w = ens.wOuter[o] * (m / I);
    ws[o] = w; means[o] = m ? s / m : 0;
    sw += w; sw2 += w * w; swv += w * means[o];
  }
  const mean = sw > 0 ? swv / sw : 0;
  let varSum = 0;
  for (let o = 0; o < W; o++) varSum += ws[o] * ws[o] * (means[o] - mean) ** 2;
  const ess = sw2 > 0 ? (sw * sw) / sw2 : 0;
  const se = sw > 0 ? Math.sqrt(varSum) / sw : 0;
  let ci: [number, number] = [Math.max(0, mean - 1.645 * se), mean + 1.645 * se];
  if (mean === 0) ci = [0, Math.min(1, 2.3 / Math.max(1, ess))];
  return { mean, ci90: ci, ess: ess * I, mass: sw / Math.max(1e-300, ens.wOuter.reduce((a, b) => a + b, 0)) };
}

function q3(vals: ArrayLike<number>, w: ArrayLike<number>, now: number): Quantiles | null {
  const p = (q: number) => { const v = weightedQuantile(vals, w, q); return Number.isFinite(v) ? r1(Math.max(0, v - now)) : null; };
  const out = { p10: p(0.1), p50: p(0.5), p90: p(0.9) };
  return out.p10 === null ? null : out;
}

/** Weighted quantiles at (i + 0.5) / n, i = 0…n−1, in minutes from now (null past the horizon). One sort. */
export function quantileGrid(values: ArrayLike<number>, weights: ArrayLike<number>, now: number, n = 100): (number | null)[] {
  const idx = Array.from({ length: values.length }, (_, i) => i).sort((a, b) => values[a] - values[b]);
  let tot = 0;
  for (let i = 0; i < values.length; i++) tot += weights[i];
  const out: (number | null)[] = [];
  let acc = 0, j = 0;
  for (let q = 0; q < n; q++) {
    const target = ((q + 0.5) / n) * tot;
    while (j < idx.length - 1 && acc + weights[idx[j]] < target) acc += weights[idx[j++]];
    const v = idx.length ? values[idx[j]] : Infinity;
    out.push(Number.isFinite(v) ? r1(Math.max(0, v - now)) : null);
  }
  return out;
}

export function summarizeOption(ens: Ensemble, k: number): OptionSummary {
  const out = ens.outcomes[k];
  const w = trialWeights(ens);
  const fd = weightedMean(ens, out.F);
  const racks = { p10: weightedQuantile(out.racks, w, 0.1), p50: weightedQuantile(out.racks, w, 0.5), p90: weightedQuantile(out.racks, w, 0.9), mean: r1(weightedMean(ens, out.racks).mean) };
  const perRack: OptionSummary['perRack'] = {};
  if (out.assetTimes) {
    const N = ens.nodeIds.length;
    for (const id of ens.rackIds) {
      const n = ens.nodeIds.indexOf(id);
      const col = new Float64Array(ens.trials);
      let hit = 0, tot = 0;
      for (let i = 0; i < ens.trials; i++) { col[i] = out.assetTimes[i * N + n]; tot += w[i]; if (Number.isFinite(col[i])) hit += w[i]; }
      if (tot && hit / tot >= 0.01) { const m = weightedQuantile(col, w, 0.5); perRack[id] = { pImpact: Math.round((hit / tot) * 1000) / 1000, p50Min: fin(m) === null ? null : r1(m - ens.t) }; }
    }
  }
  return {
    id: ens.options[k].id, label: ens.options[k].label, trials: ens.trials, ess: Math.round(fd.ess),
    racks, pServiceDown: fd.mean, ci90: fd.ci90,
    firstImpactMin: q3(out.firstImpact, w, ens.t), firstEnvelopeMin: q3(out.firstEnvelope, w, ens.t),
    perRack, expectedUtility: weightedMean(ens, out.U).mean,
    futures: { envelope: quantileGrid(out.firstEnvelope, w, ens.t), impact: quantileGrid(out.firstImpact, w, ens.t) },
  };
}

/** Per-node loss-time percentiles (absolute minutes, Infinity = not lost) for one option — needs keepAssetTimes. */
export function assetClocks(ens: Ensemble, k = 0): Record<ID, { p10: number | null; p50: number | null; p90: number | null; prob: number }> {
  const out = ens.outcomes[k];
  if (!out.assetTimes) throw new Error('assetClocks needs keepAssetTimes');
  const N = ens.nodeIds.length;
  const w = trialWeights(ens);
  const tot = w.reduce((a, b) => a + b, 0);
  const res: Record<ID, { p10: number | null; p50: number | null; p90: number | null; prob: number }> = {};
  const col = new Float64Array(ens.trials);
  for (let n = 0; n < N; n++) {
    let hit = 0;
    for (let i = 0; i < ens.trials; i++) { col[i] = out.assetTimes[i * N + n]; if (Number.isFinite(col[i])) hit += w[i]; }
    if (!hit) continue;
    const p = (q: number) => fin(weightedQuantile(col, w, q));
    res[ens.nodeIds[n]] = { p10: p(0.1), p50: p(0.5), p90: p(0.9), prob: hit / tot };
  }
  return res;
}
