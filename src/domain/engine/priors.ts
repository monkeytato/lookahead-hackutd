/**
 * Typed prior distributions for the ensemble (PREDICTION-SCIENCE.md §3 parameter table and
 * research/derived/reliability_priors.json). Every family carries its basis: published data
 * ("published"), our physics model ("model"), or an explicit assumption ("assumption").
 *
 * Each continuous family is sampled through its quantile function, u ∈ (0, 1) → x, so an
 * importance-sampling proposal can restrict u to a window (stress.ts) and the density ratio
 * q/p stays closed-form. On-demand failures are Bernoulli with p = the Beta posterior mean
 * (the Beta–Bernoulli marginal is exactly Bernoulli(mean)).
 */
export type Prior =
  | { kind: 'uniform'; lo: number; hi: number }
  | { kind: 'loguniform'; lo: number; hi: number }
  | { kind: 'triangular'; min: number; mode: number; max: number }
  | { kind: 'lognormal'; median: number; sigmaLn: number }
  | { kind: 'bernoulli'; p: number }
  | { kind: 'mixture_lognormal'; weights: number[]; medians: number[]; sigmaLn: number };

export type Basis = 'published' | 'model' | 'assumption';
export interface PriorSpec { prior: Prior; unit: string; basis: Basis; source: string; label: string }

// ------------------------------------------------------------------ normal helpers
/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf), |error| < 1.5e-7 */
export function normCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
/** Inverse standard normal CDF (Acklam), relative error < 1.2e-9 */
export function normInv(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q = Math.min(1 - 1e-12, Math.max(1e-12, p));
  if (q < 0.02425) { const r = Math.sqrt(-2 * Math.log(q)); return (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1); }
  if (q > 1 - 0.02425) { const r = Math.sqrt(-2 * Math.log(1 - q)); return -(((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1); }
  const r = q - 0.5, s = r * r;
  return (((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1);
}

// ------------------------------------------------------------------ distribution ops
export function quantile(p: Prior, u: number): number {
  switch (p.kind) {
    case 'uniform': return p.lo + (p.hi - p.lo) * u;
    case 'loguniform': return Math.exp(Math.log(p.lo) + (Math.log(p.hi) - Math.log(p.lo)) * u);
    case 'triangular': {
      const { min, mode, max } = p;
      if (max <= min) return min;
      const c = (mode - min) / (max - min);
      return u < c ? min + Math.sqrt(u * (max - min) * (mode - min)) : max - Math.sqrt((1 - u) * (max - min) * (max - mode));
    }
    case 'lognormal': return p.median * Math.exp(p.sigmaLn * normInv(u));
    case 'bernoulli': return u < p.p ? 1 : 0;
    case 'mixture_lognormal': {
      // invert the mixture CDF by bisection in log space
      let lo = Math.log(Math.min(...p.medians)) - 8 * p.sigmaLn, hi = Math.log(Math.max(...p.medians)) + 8 * p.sigmaLn;
      for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (cdf(p, Math.exp(m)) < u) lo = m; else hi = m; }
      return Math.exp((lo + hi) / 2);
    }
  }
}

export function cdf(p: Prior, x: number): number {
  switch (p.kind) {
    case 'uniform': return Math.min(1, Math.max(0, (x - p.lo) / (p.hi - p.lo)));
    case 'loguniform': return x <= p.lo ? 0 : x >= p.hi ? 1 : (Math.log(x) - Math.log(p.lo)) / (Math.log(p.hi) - Math.log(p.lo));
    case 'triangular': {
      const { min, mode, max } = p;
      if (x <= min) return 0;
      if (x >= max) return 1;
      return x <= mode ? ((x - min) ** 2) / ((max - min) * (mode - min)) : 1 - ((max - x) ** 2) / ((max - min) * (max - mode));
    }
    case 'lognormal': return x <= 0 ? 0 : normCdf(Math.log(x / p.median) / p.sigmaLn);
    case 'bernoulli': return x < 1 ? 1 - p.p : 1;
    case 'mixture_lognormal': return x <= 0 ? 0 : p.weights.reduce((s, w, i) => s + w * normCdf(Math.log(x / p.medians[i]) / p.sigmaLn), 0);
  }
}

/** log density (Bernoulli: log mass) */
export function logpdf(p: Prior, x: number): number {
  switch (p.kind) {
    case 'uniform': return x < p.lo || x > p.hi ? -Infinity : -Math.log(p.hi - p.lo);
    case 'loguniform': return x < p.lo || x > p.hi ? -Infinity : -Math.log(x) - Math.log(Math.log(p.hi) - Math.log(p.lo));
    case 'triangular': {
      const { min, mode, max } = p;
      if (x < min || x > max) return -Infinity;
      const v = x <= mode ? (2 * (x - min)) / ((max - min) * (mode - min || 1e-12)) : (2 * (max - x)) / ((max - min) * (max - mode || 1e-12));
      return Math.log(Math.max(v, 1e-300));
    }
    case 'lognormal': {
      if (x <= 0) return -Infinity;
      const z = Math.log(x / p.median) / p.sigmaLn;
      return -0.5 * z * z - Math.log(x * p.sigmaLn * Math.sqrt(2 * Math.PI));
    }
    case 'bernoulli': return Math.log(x >= 0.5 ? p.p : 1 - p.p);
    case 'mixture_lognormal': {
      if (x <= 0) return -Infinity;
      const s = p.weights.reduce((acc, w, i) => { const z = Math.log(x / p.medians[i]) / p.sigmaLn; return acc + w * Math.exp(-0.5 * z * z); }, 0);
      return Math.log(s) - Math.log(x * p.sigmaLn * Math.sqrt(2 * Math.PI));
    }
  }
}

export const sample = (p: Prior, rand: () => number) => quantile(p, rand());

// ------------------------------------------------------------------ the families

export type FamilyId =
  | 'gen_fts' | 'ats_ftt' | 'ups_transfer_fail' | 'standby_crah_fts' | 'chiller_restart_fail' | 'chiller_restart_min'
  | 'battery_soh_A' | 'battery_soh_B' | 'loop_l_per_kw' | 'coil_frac' | 'k_G' | 'it_eps' | 'rack_mass' | 'ceiling_m' | 'plenum'
  | 'mix_frac' | 't_trip' | 'leak_rate_mult' | 'retain_mm' | 'leak_lead_min' | 'crew_mult' | 'hotspot_rise' | 'hotspot_tau' | 'spread_mult';

/**
 * §3 parameter table. Values in `research/derived/reliability_priors.json` where published.
 * Inner (aleatory) draws — generator start-to-transfer, DLC throttle time, battery T_vendor and the
 * crew task time around crew_mult — are sampled per trial inside ensemble.ts and are not families.
 */
export const PRIORS: Record<FamilyId, PriorSpec> = {
  gen_fts: { prior: { kind: 'bernoulli', p: 2.22e-3 }, unit: 'per demand', basis: 'published', source: 'INL/EXT-21-65055 EDG-FTS, Beta(136.5, 61227.5) mean', label: 'generator fails to start' },
  ats_ftt: { prior: { kind: 'bernoulli', p: 1.33e-3 }, unit: 'per demand', basis: 'published', source: 'INL/EXT-21-65055 ABT-FF, Beta(4.5, 3373.5) mean', label: 'ATS fails to transfer' },
  ups_transfer_fail: { prior: { kind: 'bernoulli', p: 1.0e-3 }, unit: 'per demand', basis: 'published', source: 'Schneider WP75 (vendor model input)', label: 'UPS drops load on transfer to battery' },
  standby_crah_fts: { prior: { kind: 'bernoulli', p: 2.11e-4 + 2.5e-3 }, unit: 'per demand', basis: 'published', source: 'INL AHU-FTS-NS 2.11e-4 + 2.5e-3 test/maintenance unavailability', label: 'standby CRAH fails to start' },
  chiller_restart_fail: { prior: { kind: 'bernoulli', p: 5.09e-3 + 2.0e-2 }, unit: 'per demand', basis: 'published', source: 'INL CHL-FTS-NR 5.09e-3 + 2.0e-2 unavailable', label: 'chiller fails to restart' },
  chiller_restart_min: { prior: { kind: 'uniform', lo: 2.5, hi: 15 }, unit: 'min', basis: 'assumption', source: 'chiller type unknown: spans quick-start 2.5–5 (Trane, Daikin; vendor) to standard 10–15 min (WP179) (assumption)', label: 'chiller restart to capacity' },
  battery_soh_A: { prior: { kind: 'uniform', lo: 0.9, hi: 1.0 }, unit: 'fraction', basis: 'assumption', source: 'string A, 5 years old (assumption; IEEE 450 end of life 0.8)', label: 'battery A state of health' },
  battery_soh_B: { prior: { kind: 'uniform', lo: 0.6, hi: 0.85 }, unit: 'fraction', basis: 'assumption', source: 'string B, 11 years on a 10-year life (assumption)', label: 'battery B state of health' },
  loop_l_per_kw: { prior: { kind: 'loguniform', lo: 3, hi: 11 }, unit: 'L/kW', basis: 'assumption', source: '3–10 gal/ton chiller-stability practice, not identifiable from WP179 (assumption)', label: 'chilled-water loop volume' },
  coil_frac: { prior: { kind: 'uniform', lo: 0.1, hi: 0.3 }, unit: 'fraction', basis: 'assumption', source: 'share of loop water in coils and local pipe when pumps stop (assumption)', label: 'coil water share' },
  k_G: { prior: { kind: 'uniform', lo: 1.5, hi: 3 }, unit: '×', basis: 'model', source: 'IT–air coupling multiplier fitted to Schneider WP179 (dossier §2.1 backtest)', label: 'IT–air coupling k_G' },
  it_eps: { prior: { kind: 'uniform', lo: 0.6, hi: 0.9 }, unit: '—', basis: 'published', source: 'US10817033 (0.7–0.9), widened', label: 'IT heat-exchange effectiveness' },
  rack_mass: { prior: { kind: 'uniform', lo: 350, hi: 700 }, unit: 'kg', basis: 'published', source: 'WP179 uses 545 kg; range assumed', label: 'rack + IT mass' },
  ceiling_m: { prior: { kind: 'uniform', lo: 3.0, hi: 4.5 }, unit: 'm', basis: 'assumption', source: 'fixture has no ceiling data (assumption)', label: 'ceiling height' },
  plenum: { prior: { kind: 'bernoulli', p: 0.5 }, unit: '0.6 m', basis: 'assumption', source: 'raised-floor plenum present (assumption)', label: 'raised-floor plenum' },
  mix_frac: { prior: { kind: 'uniform', lo: 0, hi: 0.5 }, unit: 'fraction', basis: 'assumption', source: 'air exchanged with the running half of the hall (assumption)', label: 'inter-zone air mixing' },
  t_trip: { prior: { kind: 'uniform', lo: 40, hi: 45 }, unit: '°C inlet', basis: 'published', source: 'ASHRAE A3 40 / A4 45 °C; Dell iDRAC 42 / 47 °C', label: 'service-impact inlet temperature' },
  leak_rate_mult: { prior: { kind: 'lognormal', median: 1, sigmaLn: 0.15 }, unit: '× observed', basis: 'assumption', source: 'make-up-flow meter error ±15 % (assumption); rate itself is observed', label: 'leak rate vs observed' },
  retain_mm: { prior: { kind: 'uniform', lo: 1.5, hi: 4.0 }, unit: 'mm', basis: 'model', source: 'puddle thickness 2·l_c·sin(θ/2), θ 30–100° (de Gennes 2004, calc)', label: 'retained water film' },
  leak_lead_min: { prior: { kind: 'uniform', lo: 0, hi: 10 }, unit: 'min', basis: 'assumption', source: 'leak start before the flow mismatch exceeds meter noise (assumption)', label: 'leak start before detection' },
  crew_mult: { prior: { kind: 'lognormal', median: 1, sigmaLn: Math.log(2) / 1.645 }, unit: '× fixture delay', basis: 'assumption', source: 'crew task time LogNormal(median = fixture delay, error factor 2) (assumption; THERP TRC)', label: 'crew speed' },
  hotspot_rise: { prior: { kind: 'uniform', lo: 0, hi: 12 }, unit: '°C', basis: 'assumption', source: 'further rise of a local recirculation hot spot (assumption)', label: 'hot-spot further rise' },
  hotspot_tau: { prior: { kind: 'uniform', lo: 5, hi: 20 }, unit: 'min', basis: 'assumption', source: 'hot-spot time constant (assumption)', label: 'hot-spot time constant' },
  spread_mult: { prior: { kind: 'lognormal', median: 1, sigmaLn: 0.3 }, unit: '×', basis: 'assumption', source: 'fire / smoke spread speed uncertainty (assumption)', label: 'hazard spread speed' },
};

export const FAMILY_IDS = Object.keys(PRIORS) as FamilyId[];
