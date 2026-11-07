/**
 * Reference-probe verification: compares an installed-sensor reading against one or more
 * reference-probe readings and returns a verdict.
 *
 * Language rule: a verdict describes the MEASUREMENTS, never the equipment. A disagreement does
 * not establish which instrument is wrong, and "not corroborated in this session" does not clear
 * the equipment — rationales are written accordingly (acceptance A04).
 */
import type { Metric, Reading, Threshold, Verdict } from '../types';
import { freshness, severityFor } from './readings';

export interface CompareContext { now: number; thresholds: Threshold[] }
export interface CompareResult { verdict: Verdict; rationale: string; qualityFlags: string[] }

/** Is the gap between installed and reference material for this metric? */
function materialGap(metric: Metric, installed: number, reference: number): { material: boolean; text: string } {
  const abs = Math.abs(installed - reference);
  if (metric === 'inlet_temp_c' || metric === 'supply_temp_c' || metric === 'battery_temp_c' || metric === 'dew_point_c') {
    return { material: abs > 3, text: `${abs.toFixed(1)} °C (material gap > 3 °C)` };
  }
  const rel = reference === 0 ? (abs === 0 ? 0 : Infinity) : abs / Math.abs(reference);
  const limit = metric === 'vibration_mm_s' ? 0.3 : 0.2;
  const pct = Number.isFinite(rel) ? `${Math.round(rel * 100)} %` : 'undefined %';
  return { material: rel > limit, text: `${pct} (material gap > ${Math.round(limit * 100)} %)` };
}

const isAbnormal = (metric: Metric, v: number, th: Threshold[]) => severityFor(metric, v, th) !== 'normal';

const fmt = (r: Reading) => `${r.value} ${r.unit}`;

export function compareReadings(installed: Reading, references: Reading[], ctx: CompareContext): CompareResult {
  const flags: string[] = [];
  const inconclusive = (why: string): CompareResult => ({
    verdict: 'inconclusive',
    rationale: `Inconclusive: ${why} Repeat the reference measurement before relying on either reading.`,
    qualityFlags: flags,
  });

  if (references.length === 0) {
    flags.push('no_reference');
    return inconclusive('no reference-probe reading was captured.');
  }
  if (references.some((r) => r.assetId !== installed.assetId)) {
    flags.push('asset_mismatch');
    return inconclusive(`a reference reading was taken on a different asset than ${installed.assetId}.`);
  }
  if (references.some((r) => r.metric !== installed.metric)) {
    flags.push('metric_mismatch');
    return inconclusive(`a reference reading measures a different quantity than the installed ${installed.metric} sensor.`);
  }
  const stale = references.filter((r) => freshness(r, ctx.now) !== 'fresh');
  if (stale.length) {
    flags.push('reference_stale');
    return inconclusive(`reference reading ${stale[0].id} is ${Math.round(ctx.now - stale[0].t)} min old — older than twice its ${stale[0].expectedIntervalMin} min interval.`);
  }
  if (freshness(installed, ctx.now) !== 'fresh') flags.push('installed_stale');
  if (references.length === 1) flags.push('single_reference_sample');
  if (references.some((r) => r.source !== 'reference_probe')) flags.push('reference_not_probe_source');

  // Use the median of the reference samples (robust to one bad placement).
  const vals = references.map((r) => r.value).sort((a, b) => a - b);
  const mid = vals.length >> 1;
  const refValue = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  const ref = references[references.length - 1];
  const refDesc = `reference probe${ref.probeId ? ` ${ref.probeId}` : ''}${ref.point ? ` at "${ref.point}"` : ''} reads ${refValue} ${ref.unit}`;
  const instDesc = `installed sensor reads ${fmt(installed)}`;

  const instAb = isAbnormal(installed.metric, installed.value, ctx.thresholds);
  const refAb = isAbnormal(installed.metric, refValue, ctx.thresholds);
  const gap = materialGap(installed.metric, installed.value, refValue);

  if (instAb && refAb) {
    return {
      verdict: 'corroborated_abnormal',
      rationale: `Corroborated: ${instDesc} and ${refDesc}; both are beyond the warning threshold. The abnormal condition is supported by an independent measurement.`,
      qualityFlags: flags,
    };
  }
  if (instAb && !refAb) {
    if (gap.material) {
      return {
        verdict: 'measurement_disagreement',
        rationale: `Measurement disagreement: ${instDesc} but ${refDesc}; gap ${gap.text}. This does not show which measurement is wrong — check sensor placement and mounting, then repeat with a second reference sample.`,
        qualityFlags: flags,
      };
    }
    flags.push('gap_not_material');
    return inconclusive(`${instDesc} (abnormal) and ${refDesc} (within band), but the gap of ${gap.text} is too small to separate the two.`);
  }
  if (!instAb && refAb) {
    flags.push('reference_abnormal_only');
    return {
      verdict: 'measurement_disagreement',
      rationale: `Measurement disagreement: ${instDesc} (within band) but ${refDesc}, beyond the warning threshold. Treat the condition as possible and repeat the reference measurement at the installed sensor's point.`,
      qualityFlags: flags,
    };
  }
  return {
    verdict: 'not_corroborated_in_session',
    rationale: `Not corroborated in this session: ${instDesc} and ${refDesc}; both are within band at the time and point measured. This covers only this measurement point and time.`,
    qualityFlags: flags,
  };
}
