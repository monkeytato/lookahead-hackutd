/**
 * Evidence posterior: P(the reported condition is real | installed reading, portable reading).
 * PREDICTION-SCIENCE.md §2.6 (Design C). Replaces fixed thresholds ("portable ≥ 28 °C") and the fixed
 * 3 °C gap with a likelihood ratio over an explicit error budget.
 *
 *   H_real: the installed reading reflects a real condition at the point
 *   H_meas: the installed reading is a measurement problem (offset, drift, placement, recirculation)
 *   temperature:  p(y | H_real) = t_ν(y; x_installed, √(σ_inst² + σ_ref² + σ_sp²))
 *                 p(y | H_meas) = t_ν(y; μ_model,     √(σ_model² + σ_ref² + σ_sp²))
 *   water probe:  p(wet | H_real) = sensitivity, p(wet | H_meas) = 1 − specificity
 *   P(H_real | y) = LR·π / (LR·π + 1 − π)
 *
 * Student-t (ν = 4) keeps one counterfeit or mis-placed probe from producing absurd certainty.
 * The verdict describes the MEASUREMENTS, never the equipment (acceptance A04): rationales never say
 * "broken" or "safe". All numbers are engine output; the LLM may only explain them.
 */
import type { Metric, Verdict } from '../types';

export interface ErrorTerm { value: number; basis: string }
export interface ErrorModel {
  /** Installed sensor 1σ, °C */
  sigmaInstalled: ErrorTerm;
  /** Reference (portable DS18B20) 1σ, °C */
  sigmaRef: ErrorTerm;
  /** Placement / spatial 1σ between the two points, °C */
  sigmaSpatial: ErrorTerm;
  /** Model / neighbour baseline 1σ for the inlet without the alleged condition, °C */
  sigmaModel: ErrorTerm;
  /** Student-t degrees of freedom */
  nu: ErrorTerm;
  /** Prior P(alarm reflects a real condition) */
  priorReal: ErrorTerm;
  leakSensitivity: ErrorTerm;
  leakSpecificity: ErrorTerm;
  /** |slope| above which a carried probe is flagged unsettled, °C/min */
  unsettledSlope: ErrorTerm;
}

/** §3 parameter table. Replace the assumption (A) values with the 20-hold rig check (§7.3). */
export const DEFAULT_ERROR_MODEL: ErrorModel = {
  sigmaInstalled: { value: 1.0, basis: 'installed sensor 0.5 (calibrated) … 1.5 °C (drifted); IEC 60751, Khalili 2019 — mid value (published range, value assumed)' },
  sigmaRef: { value: 0.5, basis: 'DS18B20 ±0.5 °C 3σ (datasheet) widened for the 10 s hold vs the 90 s runbook settle (assumption)' },
  sigmaSpatial: { value: 0.5, basis: 'same height, 5 cm in front of the inlet: 0.3–0.5 °C (runbook RB-VERIFY-TEMP; Subzero, vendor)' },
  sigmaModel: { value: 1.5, basis: 'neighbour / zone baseline uncertainty 1–1.5 °C (assumption)' },
  nu: { value: 4, basis: 'Student-t ν = 4 to cover counterfeit DS18B20 offsets up to ±3 °C (Petrich, measured)' },
  priorReal: { value: 0.5, basis: 'no published base rate of false inlet alarms; 0.5 with sensitivity 0.2 / 0.8 (assumption)' },
  leakSensitivity: { value: 0.95, basis: 'floor probe sensitivity 0.95 (assumption)' },
  leakSpecificity: { value: 0.98, basis: 'floor probe specificity 0.98 (assumption)' },
  unsettledSlope: { value: 0.2, basis: '|slope| > 0.2 °C/min means the probe has not settled (dossier §2.6, assumption)' },
};

export interface EvidenceInput {
  metric: Metric;
  installed: { value: number };
  /** Portable reading: mean of the hold, its sd / slope and the scan's quality flags */
  reference?: { mean: number; n: number; sd?: number; slopePerMin?: number; quality?: string[] } | null;
  /** Neighbours' installed readings (same aisle); their mean is the "no condition" baseline when given */
  neighbours?: number[];
  modelBaseline: { mean: number; sd?: number };
  priorReal?: number;
  errorModel?: Partial<ErrorModel>;
}

export interface EvidenceFactor { name: string; logLR: number; basis: string }
export interface EvidencePosterior {
  pReal: number;
  logLR: number;
  factors: EvidenceFactor[];
  verdict: Verdict;
  /** false when the portable rig cannot physically measure the reported quantity */
  measurable: boolean;
  rationale: string;
  qualityFlags: string[];
  /** P(real) under the prior sensitivity range */
  sensitivity: { prior: number; pReal: number }[];
  prior: number;
}

/** log pdf of a Student-t with ν dof, location μ, scale s */
export function logStudentT(y: number, mu: number, s: number, nu: number): number {
  const z = (y - mu) / s;
  return lgamma((nu + 1) / 2) - lgamma(nu / 2) - 0.5 * Math.log(nu * Math.PI) - Math.log(s) - ((nu + 1) / 2) * Math.log1p((z * z) / nu);
}
/** Lanczos log-gamma (x > 0) */
export function lgamma(x: number): number {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

export const posteriorFrom = (logLR: number, prior: number) => {
  const lo = Math.log(prior / (1 - prior)) + logLR;
  return lo > 40 ? 1 : lo < -40 ? 0 : 1 / (1 + Math.exp(-lo));
};

const TEMP_METRICS: Metric[] = ['inlet_temp_c'];
const BAD_QUALITY = /disagree|unsettled|timeout|noisy|obstructed|fewer_than_two/;

export function verdictFor(pReal: number, measurable: boolean): Verdict {
  if (!measurable) return 'inconclusive';
  return pReal >= 0.9 ? 'corroborated_abnormal' : pReal <= 0.1 ? 'measurement_disagreement' : 'inconclusive';
}

const pct = (p: number) => (p >= 0.995 ? '> 0.99' : p <= 0.005 ? '< 0.01' : p.toFixed(2));

export function evidencePosterior(input: EvidenceInput): EvidencePosterior {
  const em: ErrorModel = { ...DEFAULT_ERROR_MODEL, ...input.errorModel };
  const prior = Math.min(0.999, Math.max(0.001, input.priorReal ?? em.priorReal.value));
  const flags: string[] = [];
  const sens = (logLR: number) => [0.2, prior, 0.8].filter((p, i, a) => a.indexOf(p) === i).map((p) => ({ prior: p, pReal: posteriorFrom(logLR, p) }));
  const notMeasurable = (why: string): EvidencePosterior => ({
    pReal: prior, logLR: 0, factors: [{ name: 'prior', logLR: 0, basis: em.priorReal.basis }], verdict: 'inconclusive', measurable: false,
    rationale: `Inconclusive: ${why} The probability stays at the prior (${pct(prior)}); the portable reading does not inform it.`, qualityFlags: [...flags, 'not_measurable'], sensitivity: sens(0), prior,
  });
  const ref = input.reference;
  if (input.metric === 'supply_temp_c' || input.metric === 'battery_temp_c' || input.metric === 'ups_autonomy_min' || input.metric === 'flow_lpm' || input.metric === 'pressure_kpa') {
    return notMeasurable(`not measurable by the portable rig (its air probe cannot read ${input.metric.replace(/_/g, ' ')}).`);
  }
  if (input.metric === 'vibration_mm_s') {
    return notMeasurable('the rig vibration channel is a motion-present switch; it cannot measure mm/s severity.');
  }
  if (!ref || !Number.isFinite(ref.mean) || ref.n < 2) {
    flags.push('no_reference');
    return { ...notMeasurable('no usable portable reading.'), measurable: true, qualityFlags: flags };
  }

  const factors: EvidenceFactor[] = [];
  let logLR = 0;
  if (input.metric === 'leak') {
    const wet = ref.mean >= 0.5;
    const se = em.leakSensitivity.value, sp = em.leakSpecificity.value;
    const l = wet ? Math.log(se / (1 - sp)) : Math.log((1 - se) / sp);
    factors.push({ name: wet ? 'probe reads wet' : 'probe reads dry', logLR: l, basis: `${em.leakSensitivity.basis}; ${em.leakSpecificity.basis}` });
    logLR = l;
  } else if (TEMP_METRICS.includes(input.metric) || input.metric === 'dew_point_c' || input.metric === 'humidity_rh') {
    let sRef = em.sigmaRef.value;
    const quality = ref.quality ?? [];
    if (quality.some((q) => BAD_QUALITY.test(q))) { sRef *= 3; flags.push('reference_quality_degraded'); }
    if (ref.slopePerMin !== undefined && Math.abs(ref.slopePerMin) > em.unsettledSlope.value) { sRef = Math.max(sRef, Math.abs(ref.slopePerMin) * 1.5); flags.push('unsettled_lag'); }
    const nb = (input.neighbours ?? []).filter(Number.isFinite);
    const mu = nb.length ? nb.reduce((a, b) => a + b, 0) / nb.length : input.modelBaseline.mean;
    const sModel = Math.max(input.modelBaseline.sd ?? em.sigmaModel.value, nb.length > 1 ? Math.sqrt(nb.reduce((a, b) => a + (b - mu) ** 2, 0) / (nb.length - 1)) : 0);
    const sReal = Math.hypot(em.sigmaInstalled.value, sRef, em.sigmaSpatial.value);
    const sMeas = Math.hypot(sModel, sRef, em.sigmaSpatial.value);
    const nu = em.nu.value;
    const l = logStudentT(ref.mean, input.installed.value, sReal, nu) - logStudentT(ref.mean, mu, sMeas, nu);
    factors.push({ name: `portable ${ref.mean.toFixed(1)} vs installed ${input.installed.value.toFixed(1)} and baseline ${mu.toFixed(1)}`, logLR: l, basis: `σ_inst ${em.sigmaInstalled.value}, σ_ref ${sRef.toFixed(2)}, σ_spatial ${em.sigmaSpatial.value}, σ_baseline ${sModel.toFixed(2)} °C, Student-t ν = ${nu}` });
    logLR = l;
  } else {
    return notMeasurable(`the portable rig has no calibrated channel for ${input.metric.replace(/_/g, ' ')}.`);
  }
  factors.push({ name: 'prior', logLR: Math.log(prior / (1 - prior)), basis: em.priorReal.basis });
  const pReal = posteriorFrom(logLR, prior);
  const verdict = verdictFor(pReal, true);
  const rationale = verdict === 'corroborated_abnormal'
    ? `Readings favour a real condition at the point (P ≈ ${pct(pReal)} under the stated error assumptions). This does not establish the cause.`
    : verdict === 'measurement_disagreement'
      ? `Readings favour a measurement problem at the installed sensor (P(real) ≈ ${pct(pReal)} under the stated error assumptions); this does not prove the sensor is faulty.`
      : `Inconclusive: P(real) ≈ ${pct(pReal)} under the stated error assumptions. Repeat the reference measurement (settle 90 s, same height) before relying on either reading.`;
  return { pReal, logLR, factors, verdict, measurable: true, rationale, qualityFlags: flags, sensitivity: sens(logLR), prior };
}
