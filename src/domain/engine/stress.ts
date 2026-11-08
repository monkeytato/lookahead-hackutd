/**
 * Red-team importance sampling (PREDICTION-SCIENCE.md §5 Design A).
 *
 * A proposer (Nemotron, or the cross-entropy fallback) names up to 6 "stress regions" in a closed JSON
 * grammar. The engine samples the defensive mixture q = α·b + (1 − α)·mean_k q_k (α = 0.3) and
 * re-weights every trial by p/q ≤ 1/α relative to the base sampler, so the self-normalised estimate
 * of P(failure) stays consistent whatever is proposed: a useless region costs variance, never bias.
 * The proposer never produces a reported number; every number here is engine output.
 *
 * Grammar (validateProposal rejects anything else):
 *   { label, rationale?, terms: [ { family, op, … } ] }   at most 6 regions, at most 6 terms each
 *   op 'quantile_window' {lo, hi}: 0 ≤ lo < hi ≤ 1, continuous families only
 *   op 'force' {value: 0 | 1 (or "fail"/"ok", "true"/"false")}: Bernoulli families
 *   op 'set_p' {p ≤ 0.5}: Bernoulli families
 *   op 'scale' {f ∈ [1/4, 4]}: log-scale families (lognormal, log-uniform)
 */
import { familiesFor, runEnsemble, trialWeights, weightedMean, type Ensemble, type EnsembleInput, type Family, type Mixture, type StressRegion, type StressTerm } from './ensemble';

export const MAX_REGIONS = 6;
export const MAX_TERMS = 6;
export const DEFENSIVE_ALPHA = 0.3;

export interface ProposalCheck { ok: boolean; errors: string[]; region?: StressRegion }

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validate one untrusted region against the closed grammar and the ensemble's families. */
export function validateProposal(raw: unknown, families: Family[]): ProposalCheck {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, errors: ['region must be an object {label, terms}'] };
  const r = raw as Record<string, unknown>;
  const label = typeof r.label === 'string' ? r.label.replace(/[^\x20-\x7e -ɏ‐-‰]/g, '').trim().slice(0, 80) : '';
  if (!label) errors.push('label is required (string)');
  if (!Array.isArray(r.terms) || r.terms.length === 0) return { ok: false, errors: [...errors, 'terms must be a non-empty array'] };
  if (r.terms.length > MAX_TERMS) errors.push(`at most ${MAX_TERMS} terms per region`);
  const byId = new Map(families.map((f) => [f.id, f]));
  const terms: StressTerm[] = [];
  const seen = new Set<string>();
  for (const [i, t0] of (r.terms as unknown[]).slice(0, MAX_TERMS).entries()) {
    if (typeof t0 !== 'object' || t0 === null) { errors.push(`terms[${i}] must be an object`); continue; }
    const t = t0 as Record<string, unknown>;
    const fam = typeof t.family === 'string' ? byId.get(t.family) : undefined;
    if (!fam) { errors.push(`terms[${i}]: unknown family ${JSON.stringify(t.family)}; families: ${families.map((f) => f.id).join(', ')}`); continue; }
    if (seen.has(fam.id)) { errors.push(`terms[${i}]: family ${fam.id} used twice`); continue; }
    seen.add(fam.id);
    const bern = fam.prior.kind === 'bernoulli';
    const logScale = fam.prior.kind === 'lognormal' || fam.prior.kind === 'loguniform' || fam.prior.kind === 'mixture_lognormal';
    switch (t.op) {
      case 'quantile_window':
        if (bern) { errors.push(`terms[${i}]: ${fam.id} is Bernoulli — use force or set_p`); break; }
        if (!isNum(t.lo) || !isNum(t.hi) || t.lo < 0 || t.hi > 1 || t.lo >= t.hi || t.hi - t.lo < 0.01) { errors.push(`terms[${i}]: quantile_window needs 0 ≤ lo < hi ≤ 1 (width ≥ 0.01)`); break; }
        terms.push({ family: fam.id, op: 'quantile_window', lo: t.lo, hi: t.hi }); break;
      case 'force': {
        if (!bern) { errors.push(`terms[${i}]: force applies to Bernoulli families only`); break; }
        const v = t.value === 1 || t.value === true || t.value === 'fail' || t.value === 'true' || t.value === '1' ? 1 : t.value === 0 || t.value === false || t.value === 'ok' || t.value === 'false' || t.value === '0' ? 0 : null;
        if (v === null) { errors.push(`terms[${i}]: force value must be 1/"fail"/true or 0/"ok"/false`); break; }
        terms.push({ family: fam.id, op: 'force', value: v }); break;
      }
      case 'set_p':
        if (!bern) { errors.push(`terms[${i}]: set_p applies to Bernoulli families only`); break; }
        if (!isNum(t.p) || t.p <= 0 || t.p > 0.5) { errors.push(`terms[${i}]: set_p needs 0 < p ≤ 0.5`); break; }
        terms.push({ family: fam.id, op: 'set_p', p: t.p }); break;
      case 'scale':
        if (!logScale) { errors.push(`terms[${i}]: scale applies to log-scale families only (lognormal, log-uniform)`); break; }
        if (!isNum(t.f) || t.f < 0.25 || t.f > 4) { errors.push(`terms[${i}]: scale needs f in [0.25, 4]`); break; }
        terms.push({ family: fam.id, op: 'scale', f: t.f }); break;
      default: errors.push(`terms[${i}]: op must be quantile_window, force, set_p or scale`);
    }
  }
  const rationale = typeof r.rationale === 'string' ? r.rationale.slice(0, 200) : undefined;
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], region: { label, rationale, terms } };
}

/** Validate a list; invalid regions are dropped and reported. */
export function validateProposals(raw: unknown, families: Family[]): { regions: StressRegion[]; errors: string[] } {
  if (!Array.isArray(raw)) return { regions: [], errors: ['proposals must be an array of regions'] };
  const errors: string[] = [];
  if (raw.length > MAX_REGIONS) errors.push(`at most ${MAX_REGIONS} regions; extra regions ignored`);
  const regions: StressRegion[] = [];
  raw.slice(0, MAX_REGIONS).forEach((r, i) => { const c = validateProposal(r, families); if (c.ok) regions.push(c.region!); else errors.push(...c.errors.map((e) => `regions[${i}]: ${e}`)); });
  return { regions, errors };
}

export const buildMixture = (regions: StressRegion[], alpha = DEFENSIVE_ALPHA): Mixture => ({ alpha, regions: regions.slice(0, MAX_REGIONS) });

// ------------------------------------------------------------------ digest, attribution, fallback

export interface FamilyLift { family: string; label: string; basis: string; kind: 'bernoulli' | 'continuous'; liftHigh: number; liftLow: number }
export interface FailureDigest {
  option: string;
  trials: number;
  ess: number;
  pFail: number;
  ci90: [number, number];
  failingTrials: number;
  /** families over-represented among failing trials (lift > 1), strongest first */
  lifts: FamilyLift[];
  families: { id: string; label: string; kind: string; basis: string }[];
}

/** Which families are over-represented among failing trials (lift = P(top/bottom decile | fail) / 0.1; Bernoulli: P(1 | fail) / P(1)). */
export function failureDigest(ens: Ensemble, k: number): FailureDigest {
  const out = ens.outcomes[k];
  const w = trialWeights(ens);
  const F = ens.families.length;
  const est = weightedMean(ens, out.F);
  let wf = 0, wAll = 0, nf = 0;
  for (let i = 0; i < ens.trials; i++) { wAll += w[i]; if (out.F[i]) { wf += w[i]; nf++; } }
  const lifts: FamilyLift[] = [];
  ens.families.forEach((f, j) => {
    const bern = f.prior.kind === 'bernoulli';
    let hi = 0, lo = 0, base1 = 0;
    for (let i = 0; i < ens.trials; i++) {
      const o = Math.floor(i / ens.inner);
      const uu = ens.u[o * F + j];
      if (bern) { if (uu >= 0.5) { base1 += w[i]; if (out.F[i]) hi += w[i]; } }
      else if (out.F[i]) { if (uu >= 0.9) hi += w[i]; if (uu <= 0.1) lo += w[i]; }
    }
    if (!wf) return;
    const liftHigh = bern ? (base1 ? (hi / wf) / (base1 / wAll) : 0) : hi / wf / 0.1;
    const liftLow = bern ? 0 : lo / wf / 0.1;
    if (nf >= 20 && (liftHigh > 1.5 || liftLow > 1.5)) lifts.push({ family: f.id, label: f.label, basis: f.basis, kind: bern ? 'bernoulli' : 'continuous', liftHigh: Math.round(liftHigh * 10) / 10, liftLow: Math.round(liftLow * 10) / 10 });
  });
  lifts.sort((a, b) => Math.max(b.liftHigh, b.liftLow) - Math.max(a.liftHigh, a.liftLow));
  return {
    option: ens.options[k].id, trials: ens.trials, ess: Math.round(est.ess), pFail: est.mean, ci90: est.ci90, failingTrials: nf,
    lifts: lifts.slice(0, 12),
    families: ens.families.map((f) => ({ id: f.id, label: f.label, kind: f.prior.kind, basis: f.basis })),
  };
}

export interface RegionAttribution {
  label: string;
  rationale?: string;
  /** prior probability that an incident falls in this region (engine: product of the term masses) */
  priorMass: number;
  /** "about 1 in N incidents" */
  priorOneIn: number;
  /** P(failure | region), self-normalised within the region */
  pFailGivenRegion: number;
  /** share of the total failure probability that comes from this region */
  shareOfFailure: number;
  trialsInRegion: number;
}

function inRegion(ens: Ensemble, o: number, r: StressRegion): boolean {
  const F = ens.families.length;
  const idx = new Map(ens.families.map((f, i) => [f.id, i]));
  for (const t of r.terms) {
    const j = idx.get(t.family);
    if (j === undefined) return false;
    const uu = ens.u[o * F + j], x = ens.x[o * F + j];
    if (t.op === 'quantile_window' && !(uu >= t.lo! && uu <= t.hi!)) return false;
    if (t.op === 'force' && x !== t.value) return false;
    if (t.op === 'set_p' && x !== 1) return false;
    if (t.op === 'scale') { const above = uu >= 0.5; if ((t.f! >= 1) !== above) return false; }
  }
  return true;
}

function regionMass(ens: Ensemble, r: StressRegion): number {
  let m = 1;
  for (const t of r.terms) {
    const fam = ens.families.find((f) => f.id === t.family);
    if (!fam) return 0;
    if (t.op === 'quantile_window') m *= t.hi! - t.lo!;
    else if (t.op === 'force') m *= fam.prior.kind === 'bernoulli' ? (t.value === 1 ? fam.prior.p : 1 - fam.prior.p) : 0;
    else if (t.op === 'set_p') m *= fam.prior.kind === 'bernoulli' ? fam.prior.p : 0;
    else m *= 0.5;
  }
  return m;
}

/** Per region: its prior mass, P(failure | region) and its share of the failure probability. */
export function attributeRegions(ens: Ensemble, k: number, regions: StressRegion[]): RegionAttribution[] {
  const out = ens.outcomes[k];
  const w = trialWeights(ens);
  let wf = 0;
  for (let i = 0; i < ens.trials; i++) if (out.F[i]) wf += w[i];
  return regions.map((r) => {
    let wr = 0, wrf = 0, n = 0;
    for (let o = 0; o < ens.outer; o++) {
      if (!inRegion(ens, o, r)) continue;
      for (let kk = 0; kk < ens.inner; kk++) { const i = o * ens.inner + kk; wr += w[i]; n++; if (out.F[i]) wrf += w[i]; }
    }
    const mass = regionMass(ens, r);
    return { label: r.label, rationale: r.rationale, priorMass: mass, priorOneIn: mass > 0 ? Math.round(1 / mass) : Infinity, pFailGivenRegion: wr ? wrf / wr : 0, shareOfFailure: wf ? wrf / wf : 0, trialsInRegion: n };
  });
}

/**
 * Cross-entropy fallback proposer (Rubinstein & Kroese 2004): for the families most over-represented
 * among failing trials, the elite failing trials' quantile window (or a forced Bernoulli state). With
 * no failure observed yet, it raises the rare Bernoulli families (set_p 0.5) one per region.
 */
export function crossEntropyProposals(ens: Ensemble, k: number, max = 4): StressRegion[] {
  const d = failureDigest(ens, k);
  const regions: StressRegion[] = [];
  if (d.failingTrials >= 5) {
    for (const l of d.lifts.slice(0, max)) {
      if (l.kind === 'bernoulli') { regions.push({ label: l.label, terms: [{ family: l.family, op: 'force', value: 1 }] }); continue; }
      // the elite tail: the quintile on the side where failing trials concentrate
      const high = l.liftHigh >= l.liftLow;
      regions.push({ label: `${l.label}, ${high ? 'top' : 'bottom'} fifth of its range`, terms: [{ family: l.family, op: 'quantile_window', lo: high ? 0.8 : 0, hi: high ? 1 : 0.2 }] });
    }
  }
  if (!regions.length) {
    const rare = ens.families.filter((f) => f.prior.kind === 'bernoulli' && f.prior.p < 0.1).sort((a, b) => (b.hypothesis ? 1 : 0) - (a.hypothesis ? 1 : 0));
    for (const f of rare.slice(0, max)) regions.push({ label: f.label, terms: [{ family: f.id, op: 'set_p', p: 0.5 }] });
  }
  return regions.slice(0, max);
}

export interface StressResult {
  option: string;
  provider: 'nemotron' | 'cross_entropy';
  regions: RegionAttribution[];
  rejected: string[];
  trials: number;
  ess: number;
  pFail: number;
  ci90: [number, number];
  /** max p/b weight seen (bounded by 1/α) */
  maxWeight: number;
  /** stop rule of §5: ESS > 2,000 and CI half-width < 25 % of P̂ */
  converged: boolean;
  elapsedMs: number;
}

/** Run the mixture for one option and attribute the regions. */
export function stressTest(base: EnsembleInput, optionIndex: number, regions: StressRegion[], provider: StressResult['provider'], rejected: string[] = [], size = { outer: 512, inner: 8 }): { result: StressResult; ensemble: Ensemble } {
  const started = Date.now();
  const ens = runEnsemble({ ...base, options: [base.options[optionIndex]], mixture: regions.length ? buildMixture(regions) : undefined, outer: size.outer, inner: size.inner, seed: (base.seed ?? 7) + 101 });
  const est = weightedMean(ens, ens.outcomes[0].F);
  const fams = familiesFor(base.hypotheses, base.priorOverride);
  // the p/b part (stratified hypotheses) is separated out so the bound is checked on b/q only
  let maxW = 0;
  for (let o = 0; o < ens.outer; o++) {
    let pb = 0;
    for (let j = 0; j < fams.length; j++) {
      const f = fams[j];
      if (f.hypothesis && f.prior.kind === 'bernoulli' && (f.prior.p < 0.3 || f.prior.p > 0.7)) { const x = ens.x[o * fams.length + j]; pb += Math.log(x >= 0.5 ? f.prior.p / 0.5 : (1 - f.prior.p) / 0.5); }
    }
    maxW = Math.max(maxW, ens.wOuter[o] / Math.exp(pb));
  }
  const half = (est.ci90[1] - est.ci90[0]) / 2;
  return {
    ensemble: ens,
    result: {
      option: base.options[optionIndex].id, provider, regions: attributeRegions(ens, 0, regions), rejected, trials: ens.trials, ess: Math.round(est.ess),
      pFail: est.mean, ci90: est.ci90, maxWeight: maxW, converged: est.ess > 2000 && est.mean > 0 && half < 0.25 * est.mean, elapsedMs: Date.now() - started,
    },
  };
}
