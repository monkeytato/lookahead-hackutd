/**
 * Hold-to-scan summarizer: turns the frames captured while the operator held the scan button
 * into one `Scan` record with per-channel statistics and quality flags. Every channel is one
 * value per frame (protocol v2).
 */
import {
  FANS,
  MIN_HOLD_S,
  type ChannelStats,
  type FrameSource,
  type Scan,
  type ScanChannel,
  type ScanPoint,
  type StampedFrame,
} from './protocol';
import { frameSeries, mean, round, sampleSd, slopePerMin, toMs, type Sample } from './stats';

/** drip_raw at or above this counts as a wet tray (dry sensor reads ~0). TUNE on the bench. */
export const DEFAULT_DRIP_WET_RAW = 120;
/** A temperature channel whose sample sd exceeds this (°C) had not settled during the hold. */
export const UNSETTLED_SD_C = 0.5;
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
  dripWetRaw?: number;
}

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

export function summarizeScan(frames: StampedFrame[], meta: ScanMeta, opts: ScanOptions = {}): Scan {
  const wetRaw = opts.dripWetRaw ?? DEFAULT_DRIP_WET_RAW;

  const durationS = Math.max(0, (toMs(meta.endedAt) - toMs(meta.startedAt)) / 1000);
  const status: Scan['status'] = frames.length === 0 ? 'no_data' : durationS < MIN_HOLD_S ? 'too_short' : 'complete';
  const source: FrameSource = frames.some((f) => f.source === 'simulated') ? 'simulated' : 'live';

  const channels: Partial<Record<ScanChannel, ChannelStats>> = {};
  const put = (ch: ScanChannel, s: ChannelStats | undefined) => {
    if (s) channels[ch] = s;
  };

  put('temp_c', statsOf(frameSeries(frames, (f) => f.temp_c), '°C'));
  put('vib_a_mm_s', statsOf(frameSeries(frames, (f) => f.vib?.fan_a?.vel_mm_s), 'mm/s'));
  put('vib_b_mm_s', statsOf(frameSeries(frames, (f) => f.vib?.fan_b?.vel_mm_s), 'mm/s'));
  put('disp_a_mm', statsOf(frameSeries(frames, (f) => f.vib?.fan_a?.disp_mm), 'mm'));
  put('disp_b_mm', statsOf(frameSeries(frames, (f) => f.vib?.fan_b?.disp_mm), 'mm'));
  put('drip_wet', statsOf(frameSeries(frames, (f) => (f.drip_raw >= wetRaw ? 1 : 0)), 'fraction'));
  put('pack_v', statsOf(frameSeries(frames, (f) => f.pack_v), 'V'));

  // ---------------------------------------------------------------- quality flags
  const quality: string[] = [];
  const add = (q: string) => {
    if (!quality.includes(q)) quality.push(q);
  };
  if (source === 'simulated') add('simulated_device');
  const temp = channels.temp_c;
  if (temp && temp.sd > UNSETTLED_SD_C) add('unsettled_temp');
  if (frames.length && !temp) add('temp_missing');
  if (frames.some((f) => f.flags.includes('temp_missing') || f.flags.includes('temp_invalid'))) add('temp_missing');
  for (const fan of FANS) {
    if (frames.some((f) => f.flags.includes(`${fan}_timeout`))) add(`vib_timeout_${fan}`);
    if (frames.some((f) => f.flags.includes(`${fan}_obstructed`))) add(`${fan}_obstructed`);
    if (frames.some((f) => f.flags.includes(`${fan}_noisy`))) add(`vib_noisy_${fan}`);
  }
  if (frames.some((f) => f.flags.includes('uncalibrated'))) add('uncalibrated');
  if (channels.pack_v && channels.pack_v.mean < PACK_LOW_V) add('pack_low');

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
