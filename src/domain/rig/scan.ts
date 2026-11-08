/**
 * Hold-to-scan summarizer: turns the frames captured while the operator held the scan button
 * into one `Scan` record with per-channel statistics and quality flags.
 *
 * Acoustic channels (inlet_top_c, inlet_bottom_c, outlet_c) are de-duplicated by `beam_age_s`
 * before any statistic is computed: the firmware repeats each beam's last average in every
 * frame until that beam's next turn (~5 s), so n counts real averages, not repeated frames.
 * See `beamSamples` in ./stats. All other channels use one value per frame.
 */
import {
  MIN_HOLD_S,
  type ChannelStats,
  type FrameSource,
  type Scan,
  type ScanChannel,
  type ScanPoint,
  type StampedFrame,
} from './protocol';
import { BEAMS, beamSamples, frameSeries, mean, round, sampleSd, slopePerMin, toMs, type Sample } from './stats';

/** reservoir_raw reading that counts as 100 % full when no calibration is supplied. */
export const DEFAULT_RESERVOIR_FULL_RAW = 600;
/** floor_raw at or above this counts as a wet floor (dry sensor reads ~0). */
export const DEFAULT_FLOOR_WET_RAW = 120;
/** A temperature channel whose sample sd exceeds this (°C) had not settled during the hold. */
export const UNSETTLED_SD_C = 0.5;
/** Acoustic inlet-bottom vs DS18B20 disagreement (°C) beyond the doc's ~1 °C bias budget. */
export const ACOUSTIC_REF_DISAGREE_C = 2;
/** Pack voltage (V) below which the 6×AA pack can no longer be trusted to drive servos/fans. */
export const PACK_LOW_V = 6.0;

export interface ScanMeta {
  id: string;
  point: ScanPoint;
  operator: string;
  deviceId: string;
  firmware: string;
  startedAt: string;
  endedAt: string;
  requestId?: string;
}

export interface ScanOptions {
  reservoirFullRaw?: number;
  floorWetRaw?: number;
}

const TEMPERATURE_CHANNELS: readonly ScanChannel[] = ['inlet_top_c', 'inlet_bottom_c', 'outlet_c', 'ref_c'];

function statsOf(samples: readonly Sample[], unit: string): ChannelStats | undefined {
  if (samples.length < 1) return undefined;
  const vs = samples.map((s) => s.v);
  return {
    n: vs.length,
    mean: round(mean(vs)),
    min: round(Math.min(...vs)),
    max: round(Math.max(...vs)),
    sd: round(sampleSd(vs)),
    slopePerMin: round(slopePerMin(samples)),
    unit,
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function summarizeScan(frames: StampedFrame[], meta: ScanMeta, opts: ScanOptions = {}): Scan {
  const fullRaw = opts.reservoirFullRaw ?? DEFAULT_RESERVOIR_FULL_RAW;
  const wetRaw = opts.floorWetRaw ?? DEFAULT_FLOOR_WET_RAW;

  const durationS = Math.max(0, (toMs(meta.endedAt) - toMs(meta.startedAt)) / 1000);
  const status: Scan['status'] = frames.length === 0 ? 'no_data' : durationS < MIN_HOLD_S ? 'too_short' : 'complete';
  const source: FrameSource = frames.some((f) => f.source === 'simulated') ? 'simulated' : 'live';

  const channels: Partial<Record<ScanChannel, ChannelStats>> = {};
  const put = (ch: ScanChannel, s: ChannelStats | undefined) => {
    if (s) channels[ch] = s;
  };

  for (const beam of BEAMS) put(`${beam}_c`, statsOf(beamSamples(frames, beam), '°C'));
  put('ref_c', statsOf(frameSeries(frames, (f) => f.ref_c), '°C'));
  put(
    'delta_t_c',
    statsOf(
      frameSeries(frames, (f) => {
        const inlets = [f.inlet_top_c, f.inlet_bottom_c].filter((x): x is number => x !== null && Number.isFinite(x));
        if (f.outlet_c === null || inlets.length === 0) return null;
        return f.outlet_c - mean(inlets);
      }),
      '°C',
    ),
  );
  put('reservoir_pct', statsOf(frameSeries(frames, (f) => Number.isFinite(f.reservoir_raw) ? clamp((f.reservoir_raw / fullRaw) * 100, 0, 100) : null), '%'));
  put('floor_wet', statsOf(frameSeries(frames, (f) => Number.isFinite(f.floor_raw) ? (f.floor_raw >= wetRaw ? 1 : 0) : null), 'fraction'));
  put('vibration_detected', statsOf(frameSeries(frames, (f) => typeof f.vibrating === 'boolean' ? Number(f.vibrating) : null), 'fraction'));
  put('pack_v', statsOf(frameSeries(frames, (f) => f.pack_v), 'V'));

  // ---------------------------------------------------------------- quality flags
  const quality: string[] = [];
  const add = (q: string) => {
    if (!quality.includes(q)) quality.push(q);
  };
  if (source === 'simulated') add('simulated_device');
  for (const ch of TEMPERATURE_CHANNELS) {
    const s = channels[ch];
    if (s && s.sd > UNSETTLED_SD_C) add(`unsettled_${ch.replace(/_c$/, '')}`);
  }
  const bottom = channels.inlet_bottom_c;
  const ref = channels.ref_c;
  if (
    (bottom && ref && Math.abs(bottom.mean - ref.mean) > ACOUSTIC_REF_DISAGREE_C) ||
    frames.some((f) => f.flags.includes('ref_disagree'))
  ) {
    add('acoustic_ref_disagree');
  }
  for (const beam of BEAMS) {
    if (frames.some((f) => f.flags.includes(`${beam}_timeout`))) add(`beam_timeout_${beam}`);
  }
  for (const beam of BEAMS) {
    if (frames.some((f) => f.flags.includes(`${beam}_obstructed`))) add(`${beam}_obstructed`);
  }
  if (channels.pack_v && channels.pack_v.mean < PACK_LOW_V) add('pack_low');
  if (status === 'complete' && BEAMS.some((b) => (channels[`${b}_c`]?.n ?? 0) < 2)) add('fewer_than_two_cycles');

  return {
    assetId: meta.point.assetId,
    point: meta.point.point,
    id: meta.id,
    deviceId: meta.deviceId,
    firmware: meta.firmware,
    source,
    operator: meta.operator,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
    durationS: round(durationS, 2),
    frames: frames.length,
    status,
    channels,
    quality,
    ...(meta.requestId !== undefined ? { requestId: meta.requestId } : {}),
  };
}
