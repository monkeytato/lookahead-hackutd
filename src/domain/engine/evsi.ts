/**
 * Expected value of sample information for a portable scan (PREDICTION-SCIENCE.md §5 Design B),
 * computed from the ensemble's own trials — no new trials.
 *
 *   EVSI(s) = Σ_y max_a Σ_i w_i L_y(i) U_a(i) / Σ_i w_i  −  max_a Σ_i w_i U_a(i) / Σ_i w_i
 *
 * L_y(i) = P(scan outcome y | trial i): a floor probe reads wet with the detector's sensitivity where
 * the trial's water front has already arrived, else with 1 − specificity; an inlet probe reads near the
 * installed value in trials where the reported hot spot is real, near the neighbours' baseline
 * otherwise (Student-t error budget of evidence.ts). U = −Σ impacted racks × service criticality
 * − λ × crew-minutes. Units: rack-equivalents. EVSI ≥ 0 and is exactly 0 when no outcome changes the
 * best action. Only scans the rig can physically make are candidates (inlet temperature, floor water).
 */
import type { ID } from '../types';
import { DEFAULT_ERROR_MODEL, logStudentT, type ErrorModel } from './evidence';
import { trialWeights, type Ensemble } from './ensemble';

export interface ScanCandidate { assetId: ID; metric: 'inlet_temp_c' | 'leak'; point: string }
export interface ScanEvsi {
  assetId: ID; metric: 'inlet_temp_c' | 'leak'; point: string;
  /** rack-equivalents gained by scanning before acting */
  evsi: number;
  bestActionIfNoScan: string;
  bestActionByOutcome: { bin: string; pBin: number; action: string }[];
  /** what the reading discriminates between in the ensemble */
  informs: string;
  /** Σ_y p(y)·|P(service down | y) − P(service down)| with no action: how far the reading moves the forecast (tie-break) */
  forecastShift: number;
}

export interface EvsiContext {
  /** inlet scans: the installed reading and the no-condition baseline at the hot-spot rack */
  installedC?: number;
  baselineC?: number;
  /** family id of the hypothesis "the alarm is real" (tags in the ensemble) */
  realFamily?: string;
  leakSourceId?: ID;
  errorModel?: Partial<ErrorModel>;
}

function outcomeLikelihoods(ens: Ensemble, c: ScanCandidate, ctx: EvsiContext): { bins: string[]; L: Float64Array[]; informs: string } {
  const n = ens.trials;
  const em = { ...DEFAULT_ERROR_MODEL, ...ctx.errorModel };
  const realTags = ctx.realFamily ? ens.tags.get(ctx.realFamily) : undefined;
  if (c.metric === 'leak') {
    const se = em.leakSensitivity.value, sp = em.leakSpecificity.value;
    const wet = new Float64Array(n), dry = new Float64Array(n);
    const arr = ens.waterAt.get(c.assetId);
    for (let i = 0; i < n; i++) {
      const isWet = c.assetId === ctx.leakSourceId ? (realTags ? realTags[i] === 1 : ens.waterAt.size > 0) : !!arr && arr[i] <= ens.t;
      wet[i] = isWet ? se : 1 - sp; dry[i] = 1 - wet[i];
    }
    return { bins: ['wet', 'dry'], L: [wet, dry], informs: c.assetId === ctx.leakSourceId ? 'leak real vs flow-meter problem' : 'how far the water front has spread' };
  }
  // inlet temperature: only the hot-spot rack's reading depends on a trial parameter
  const hot = ens.hotspotAssetId === c.assetId && realTags && ctx.installedC !== undefined && ctx.baselineC !== undefined;
  const inst = ctx.installedC ?? 30, base = ctx.baselineC ?? 22.5;
  const sReal = Math.hypot(em.sigmaInstalled.value, em.sigmaRef.value, em.sigmaSpatial.value);
  const sMeas = Math.hypot(em.sigmaModel.value, em.sigmaRef.value, em.sigmaSpatial.value);
  const step = (inst - base) / 5;
  const edges = [-Infinity, base + step, base + 2 * step, base + 3 * step, base + 4 * step, Infinity];
  const binMass = (mu: number, s: number) => edges.slice(0, -1).map((lo, k) => {
    const hi = edges[k + 1];
    const a = Number.isFinite(lo) ? lo : mu - 40 * s, b = Number.isFinite(hi) ? hi : mu + 40 * s;
    let m = 0;
    const N = 400, h = (b - a) / N;
    for (let j = 0; j < N; j++) m += Math.exp(logStudentT(a + (j + 0.5) * h, mu, s, em.nu.value)) * h;
    return m;
  });
  const pr = binMass(inst, sReal), pm = binMass(base, sMeas);
  const L = pr.map(() => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    const real = hot ? realTags![i] === 1 : false;
    for (let k = 0; k < pr.length; k++) L[k][i] = real ? pr[k] : pm[k];
  }
  const bins = edges.slice(0, -1).map((lo, k) => (Number.isFinite(lo) ? (Number.isFinite(edges[k + 1]) ? `${lo.toFixed(1)}–${edges[k + 1].toFixed(1)} °C` : `≥ ${lo.toFixed(1)} °C`) : `< ${edges[1].toFixed(1)} °C`));
  return { bins, L, informs: hot ? 'real hot spot vs installed-sensor problem' : 'nothing the ensemble is uncertain about' };
}

export function scanEvsi(ens: Ensemble, candidates: ScanCandidate[], ctx: EvsiContext = {}): ScanEvsi[] {
  const w = trialWeights(ens);
  let sw = 0;
  for (let i = 0; i < ens.trials; i++) sw += w[i];
  const O = ens.options.length;
  const prior = ens.outcomes.map((o) => { let s = 0; for (let i = 0; i < ens.trials; i++) s += w[i] * o.U[i]; return s / sw; });
  const bestNo = prior.indexOf(Math.max(...prior));
  const out: ScanEvsi[] = candidates.map((c) => {
    const { bins, L, informs } = outcomeLikelihoods(ens, c, ctx);
    let total = 0, shift = 0;
    const F0 = ens.outcomes[0].F;
    let pF = 0;
    for (let i = 0; i < ens.trials; i++) pF += w[i] * F0[i];
    pF /= sw;
    const byOutcome = bins.map((bin, k) => {
      let py = 0, fy = 0;
      const eu = new Float64Array(O);
      for (let i = 0; i < ens.trials; i++) { const lw = w[i] * L[k][i]; py += lw; fy += lw * F0[i]; for (let a = 0; a < O; a++) eu[a] += lw * ens.outcomes[a].U[i]; }
      if (py > 0) shift += (py / sw) * Math.abs(fy / py - pF);
      let best = 0;
      for (let a = 1; a < O; a++) if (eu[a] > eu[best] + 1e-12) best = a;
      total += eu[best] / sw;
      return { bin, pBin: py / sw, action: ens.options[best].id };
    });
    const evsi = Math.max(0, total - prior[bestNo]);
    return { ...c, evsi: evsi < 1e-9 ? 0 : evsi, bestActionIfNoScan: ens.options[bestNo].id, bestActionByOutcome: byOutcome, informs, forecastShift: shift < 1e-12 ? 0 : shift };
  });
  return out.sort((a, b) => b.evsi - a.evsi || b.forecastShift - a.forecastShift || a.assetId.localeCompare(b.assetId));
}
