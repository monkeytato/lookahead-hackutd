/**
 * Small, pure statistics helpers shared by the scan summarizer and the diagnosis rules.
 * Every channel in protocol v2 is one value per frame, so there is no de-duplication here.
 */
import type { Fan, StampedFrame } from './protocol';

export interface Sample {
  /** epoch ms */
  t: number;
  v: number;
}

export function toMs(iso: string): number {
  return Date.parse(iso);
}

/** One sample per frame from a picker; null / non-finite values are skipped. */
export function frameSeries(
  frames: readonly StampedFrame[],
  pick: (f: StampedFrame) => number | null | undefined,
): Sample[] {
  const out: Sample[] = [];
  for (const f of frames) {
    const v = pick(f);
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    out.push({ t: toMs(f.at), v });
  }
  return out;
}

/** Indicative RMS velocity series for one fan channel (mm/s). */
export function vibSeries(frames: readonly StampedFrame[], fan: Fan): Sample[] {
  return frameSeries(frames, (f) => f.vib?.[fan]?.vel_mm_s);
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n − 1); 0 for fewer than two values. */
export function sampleSd(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let ss = 0;
  for (const x of xs) ss += (x - m) ** 2;
  return Math.sqrt(ss / (xs.length - 1));
}

/** Least-squares slope in units per minute; 0 when it cannot be estimated. */
export function slopePerMin(samples: readonly Sample[]): number {
  if (samples.length < 2) return 0;
  const t0 = samples[0].t;
  const xs = samples.map((s) => (s.t - t0) / 60000);
  const ys = samples.map((s) => s.v);
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  return sxx === 0 ? 0 : sxy / sxx;
}

/** Seconds covered by a sample series (0 for fewer than two samples). */
export function spanS(samples: readonly Sample[]): number {
  return samples.length < 2 ? 0 : (samples[samples.length - 1].t - samples[0].t) / 1000;
}

export function round(x: number, dp = 3): number {
  const k = 10 ** dp;
  return Math.round(x * k) / k;
}
