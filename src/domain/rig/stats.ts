/**
 * Small, pure statistics helpers shared by the scan summarizer and the diagnosis rules.
 *
 * Acoustic de-duplication. The three HC-SR04 beams take turns: each one produces a fresh
 * ~25-ping average roughly every 5 s, and the firmware repeats ("holds") the last average in
 * every 1 Hz frame in between. Counting those repeats as samples would inflate n, shrink the
 * standard deviation and bias slopes, so `beamSamples` keeps only frames where the beam's
 * `beam_age_s` reset (a new average was taken). Each kept sample is timed at the moment the
 * average was taken (`at − beam_age_s`), not when the bridge received the frame.
 */
import type { StampedFrame } from './protocol';

export type Beam = 'inlet_top' | 'inlet_bottom' | 'outlet';
export const BEAMS: readonly Beam[] = ['inlet_top', 'inlet_bottom', 'outlet'];

export function beamChannel(beam: Beam): 'inlet_top_c' | 'inlet_bottom_c' | 'outlet_c' {
  return `${beam}_c`;
}

export interface Sample {
  /** epoch ms */
  t: number;
  v: number;
}

/**
 * Two held readings whose implied refresh instants (`at − age`) differ by more than this are
 * different averages even if the age did not visibly reset (e.g. frames were dropped across a
 * whole beam cycle). Absorbs bridge receive-time jitter.
 */
const EPOCH_TOLERANCE_MS = 1500;

export function toMs(iso: string): number {
  return Date.parse(iso);
}

/** De-duplicated fresh averages for one beam (see module comment). Nulls are skipped. */
export function beamSamples(frames: readonly StampedFrame[], beam: Beam): Sample[] {
  const out: Sample[] = [];
  let prevAge: number | null = null;
  let lastEpoch: number | null = null;
  for (const f of frames) {
    const v = f[beamChannel(beam)];
    const age = f.beam_age_s?.[beam] ?? 0;
    if (v === null || v === undefined || !Number.isFinite(v)) {
      prevAge = null;
      continue;
    }
    const epoch = toMs(f.at) - age * 1000;
    const isNew =
      lastEpoch === null || prevAge === null || age < prevAge || epoch - lastEpoch > EPOCH_TOLERANCE_MS;
    prevAge = age;
    if (!isNew) continue;
    lastEpoch = epoch;
    out.push({ t: epoch, v });
  }
  return out;
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
