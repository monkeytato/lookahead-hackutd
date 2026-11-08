/**
 * The rig's own rule set (protocol v2): nine situations plus an unclassified-anomaly catch-all.
 * Pure and stateless — the caller passes a recent window of frames (30–60 s) and the events it
 * already holds; only NEW events come back.
 *
 * Channels: one DS18B20 at the front inlet (temp_c), two ultrasonic vibration channels (one per
 * exhaust fan), one drip-tray water sensor (drip_raw) and the pack voltage (pack_v).
 *
 * Power loss is the root cause of everything that follows it (fans and servos share the pack), so
 * when it matches, the fan / thermal symptom rules are suppressed in the same call: one alert
 * instead of four.
 */
import { FANS, type Fan, type FrameSource, type RigEvent, type RigEventKind, type StampedFrame } from './protocol';
import { frameSeries, mean, round, slopePerMin, spanS, toMs, vibSeries, type Sample } from './stats';
import { DEFAULT_DRIP_WET_RAW } from './scan';

// ---------------------------------------------------------------- thresholds
/** Frames older than this (s) before the newest frame are ignored. */
export const DIAG_WINDOW_S = 60;
/** An event of the same kind (and channel) raised within this many seconds is still active. */
export const DEDUPE_S = 60;
/** Slope rules need at least this much history (s). */
export const MIN_SLOPE_SPAN_S = 10;
/** A temperature is "rising" at or above this slope (°C/min). */
export const RISE_C_PER_MIN = 0.6;
/** Inlet above its calibrated baseline by this much (°C) with the flap open = recirculation. */
export const RECIRC_DELTA_C = 1.5;
/** Pack below this (V) cannot drive the fans and servos. */
export const PACK_LOW_V = 6.0;
/** …or a fall of this fraction against the start of the window. */
export const PACK_DROP_FRACTION = 0.2;
/**
 * Pack rises by at least this (V) with unchanged fan commands → one motor stopped drawing current
 * (each TT motor sags the 6×AA pack ~0.1–0.2 V at 70 %).
 */
export const FAN_LOAD_STEP_V = 0.05;
/** A running fan whose vibration channel reads below this (mm RMS) has stopped. */
export const FAN_STOPPED_DISP_MM = 0.005;
/**
 * Vibration alert / alarm on the indicative RMS velocity (mm/s). Loosely modelled on ISO 10816-1
 * class II zone boundaries (B/C 2.8, C/D 7.1) but the ultrasonic reading is NOT an ISO
 * measurement: treat as trend thresholds, tune on the bench.
 */
export const VIB_WARN_MM_S = 2.8;
export const VIB_ALARM_MM_S = 7.1;
/** A channel must sit above the warn line for this long (s) before it counts. */
export const VIB_HOLD_S = 5;
/** Vibration rising at least this fraction over the window counts as a trend. */
export const VIB_TREND_FRACTION = 0.5;
/** A mount distance below this (mm) means something is in front of the transducer. */
export const OBSTRUCTED_MM = 15;
/** Seconds after an actuator moved before its effect can confirm (or refute) the fix. */
export const CONFIRM_AFTER_S = 8;
/** …and after this long without the expected effect the fix is reported as not confirmed. */
export const REFUTE_AFTER_S = 20;
/** The inlet probe lags the air by ~8 s and the chamber by ~25 s, so a flap fix gets longer. */
export const FLAP_REFUTE_AFTER_S = 60;
/** ASHRAE A1 allowable inlet upper limit (°C). */
export const INLET_LIMIT_C = 32;
/** Unexplained rise at or above this (°C/min) is reported as an unclassified anomaly. */
export const ANOMALY_C_PER_MIN = 1.5;
/** …but only once it has also been visible in the window ending this many seconds earlier. */
export const UNCLASSIFIED_HOLD_S = 20;
/** A wet tray already explained by a coolant leak within this many seconds is not "outside water". */
export const WATER_EXPLAINED_S = 1800;
/** The drip sensor must have been dry at the start of the window for a NEW leak. */
export const DRY_RAW = 40;

export interface DiagnoseOptions {
  dripWetRaw?: number;
  /** Inlet temperature baseline (°C) the firmware calibrated; defaults to the window's first reading. */
  baselineC?: number;
  /** Override DEDUPE_S (seconds an event stays "active" for de-duplication). */
  dedupeS?: number;
}

/** How long (s) an inlet-rise explanation keeps covering the tail of its rise. */
export const EXPLAINED_RISE_S = 120;

const INLET_EXPLANATIONS: readonly RigEventKind[] = [
  'power_loss', 'single_fan_failure', 'cold_supply_loss', 'recirculation',
];

type Candidate = Omit<RigEvent, 'id' | 'at' | 'source'>;

const SYMPTOM_KINDS: readonly RigEventKind[] = [
  'single_fan_failure', 'fan_vibration', 'recirculation', 'cold_supply_loss', 'unclassified_anomaly',
];

const f2 = (x: number) => (Math.round(x * 100) / 100).toFixed(2);
const sgn = (x: number) => (x >= 0 ? `+${f2(x)}` : f2(x));

/** Minutes until `now` reaches `limit` at `slope` per minute; 0 if already there, null if not rising. */
export function timeToLimit(now: number, limit: number, slope: number): number | null {
  if (!Number.isFinite(now)) return null;
  if (now >= limit) return 0;
  if (!(slope > 0)) return null;
  return round((limit - now) / slope, 2);
}

function windowOf(frames: readonly StampedFrame[]): StampedFrame[] {
  if (frames.length === 0) return [];
  const end = toMs(frames[frames.length - 1].at);
  return frames.filter((f) => toMs(f.at) >= end - DIAG_WINDOW_S * 1000);
}

function last(samples: readonly Sample[]): number {
  return samples.length ? samples[samples.length - 1].v : NaN;
}
function headMean(samples: readonly Sample[], k = 5): number {
  return mean(samples.slice(0, k).map((s) => s.v));
}
function tailMean(samples: readonly Sample[], k = 5): number {
  return mean(samples.slice(-k).map((s) => s.v));
}

/** Index of the first frame in which `key` went open → closed (or the firmware reported it). */
function closeIndex(frames: readonly StampedFrame[], key: 'flap' | 'valve'): number {
  const ev = key === 'flap' ? 'flap_closed' : 'valve_closed';
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].event === ev) return i;
    if (i > 0 && frames[i - 1][key] === 'open' && frames[i][key] === 'closed') return i;
  }
  return -1;
}

// ---------------------------------------------------------------- action confirmation

/** Recirculation fix: after the flap closed, did the inlet come back down? */
function confirmFlap(post: readonly StampedFrame[]): { confirmed: boolean | null; evidence: string } {
  const temp = frameSeries(post, (f) => f.temp_c);
  const span = spanS(temp);
  if (span < CONFIRM_AFTER_S || temp.length < 3) return { confirmed: null, evidence: 'flap closed; waiting for the inlet to respond' };
  const slope = slopePerMin(temp);
  if (slope < 0) return { confirmed: true, evidence: `after flap closed: inlet ${sgn(slope)} °C/min` };
  if (span >= FLAP_REFUTE_AFTER_S) return { confirmed: false, evidence: `flap closed ${Math.round(span)} s ago but inlet still ${sgn(slope)} °C/min` };
  return { confirmed: null, evidence: 'flap closed; inlet not yet falling' };
}

/** Leak fix: after the valve closed, did the tray stop getting wetter? */
function confirmValve(post: readonly StampedFrame[]): { confirmed: boolean | null; evidence: string } {
  const drip = frameSeries(post, (f) => f.drip_raw);
  const span = spanS(drip);
  if (span < CONFIRM_AFTER_S) return { confirmed: null, evidence: 'valve closed; waiting for the tray to settle' };
  const slope = slopePerMin(drip);
  if (slope <= 30) return { confirmed: true, evidence: `after valve closed: drip sensor ${sgn(slope)} raw/min over ${Math.round(span)} s (no longer rising)` };
  if (span >= REFUTE_AFTER_S) return { confirmed: false, evidence: `valve closed but tray still wetting at ${sgn(slope)} raw/min (plug may not seal)` };
  return { confirmed: null, evidence: 'valve closed; tray still rising' };
}

// ---------------------------------------------------------------- the rules

export function diagnose(
  window: StampedFrame[],
  prev: RigEvent[],
  now: string,
  opts: DiagnoseOptions = {},
): RigEvent[] {
  const frames = windowOf(window);
  if (frames.length === 0) return [];
  const wetRaw = opts.dripWetRaw ?? DEFAULT_DRIP_WET_RAW;
  const source: FrameSource = frames.some((f) => f.source === 'simulated') ? 'simulated' : 'live';
  const nowMs = toMs(now);
  const lf = frames[frames.length - 1];

  const sensorCands: Candidate[] = [];
  const waterCands: Candidate[] = [];
  const symptoms: Candidate[] = [];
  let power: Candidate | null = null;

  // ---------------------------------------------------- sensor faults / obstruction
  const untrustedVib = new Set<Fan>();
  for (const fan of FANS) {
    const obs = frames.filter((f) => f.flags.includes(`${fan}_obstructed`) || ((f.vib?.[fan]?.dist_mm ?? Infinity) < OBSTRUCTED_MM)).length;
    if (obs > 0) {
      untrustedVib.add(fan);
      const d = frames.map((f) => f.vib?.[fan]?.dist_mm).filter((x): x is number => x !== null && x !== undefined);
      sensorCands.push({
        kind: 'obstruction', channel: fan, confidence: 'high',
        rootCause: `Something is in front of the ${fan.replace('_', ' ')} vibration sensor`,
        action: 'flag blocked sensor', actionConfirmed: null, timeToLimitMin: null, route: 'it',
        evidence: [`${obs}/${frames.length} frames obstructed (distance ${d.length ? f2(Math.min(...d)) : '—'} mm < ${OBSTRUCTED_MM} mm)`],
      });
    }
    const timeouts = frames.filter((f) => f.flags.includes(`${fan}_timeout`) || f.flags.includes(`${fan}_noisy`)).length;
    if (timeouts > 0) {
      untrustedVib.add(fan);
      sensorCands.push({
        kind: 'sensor_fault', channel: fan, confidence: 'high',
        rootCause: `Bad data, not a real event: ${fan} ultrasonic timeout / noisy`,
        action: `mark ${fan} vibration untrusted; no page`, actionConfirmed: null, timeToLimitMin: null, route: 'none',
        evidence: [`${timeouts}/${frames.length} frames flagged ${fan}_timeout or ${fan}_noisy`],
      });
    }
  }
  const tempFlagged = frames.filter((f) => f.flags.includes('temp_missing') || f.flags.includes('temp_invalid')).length;
  // any flagged frame in the window poisons the slope, so the thermal rules sit out until it clears
  const tempUntrusted = tempFlagged > 0 || frames.every((f) => f.temp_c === null);
  if (tempFlagged > 0) {
    sensorCands.push({
      kind: 'sensor_fault', channel: 'temp_c', confidence: 'high',
      rootCause: 'Bad data, not a real event: inlet probe missing or invalid',
      action: 'mark temp_c untrusted; no page', actionConfirmed: null, timeToLimitMin: null, route: 'none',
      evidence: [`${tempFlagged}/${frames.length} frames flagged temp_missing / temp_invalid`],
    });
  }
  const vibOk = (fan: Fan) => !untrustedVib.has(fan);

  // ---------------------------------------------------- shared series
  const temp = frameSeries(frames, (f) => (tempUntrusted ? null : f.temp_c));
  const tempSlope = slopePerMin(temp);
  const tempNow = last(temp);
  const tempSpan = spanS(temp);
  const baseline = opts.baselineC ?? (temp.length ? temp[0].v : NaN);
  const pack = frameSeries(frames, (f) => f.pack_v);
  const packStart = headMean(pack);
  const packEnd = tailMean(pack, 3);
  const packEv = pack.length ? `pack_v ${f2(packStart)} → ${f2(packEnd)} V` : 'pack_v not fitted';
  const fansConstant = frames.every((f) => f.fan_pct[0] === frames[0].fan_pct[0] && f.fan_pct[1] === frames[0].fan_pct[1]);
  const loadStep = pack.length >= 4 ? packEnd - packStart : 0;

  // ---------------------------------------------------- power
  if (pack.length >= 2 && (packEnd < PACK_LOW_V || packEnd <= packStart * (1 - PACK_DROP_FRACTION))) {
    const ev = [`pack_v ${f2(packStart)} V → ${f2(packEnd)} V (low < ${PACK_LOW_V} V or −${PACK_DROP_FRACTION * 100} %)`, `fan_pct now ${lf.fan_pct[0]}/${lf.fan_pct[1]} %`];
    if (temp.length) ev.push(`inlet ${f2(tempNow)} °C, slope ${sgn(tempSlope)} °C/min`);
    power = {
      kind: 'power_loss', confidence: 'high',
      rootCause: 'Power is the root cause; fan and temperature changes are symptoms',
      action: 'automatic fixes unavailable — actuators share the pack',
      actionConfirmed: null,
      timeToLimitMin: temp.length ? timeToLimit(tempNow, INLET_LIMIT_C, tempSlope) : null,
      route: 'it', evidence: ev,
    };
  }

  // ---------------------------------------------------- water
  const drip = frameSeries(frames, (f) => f.drip_raw);
  const wetFrames = frames.filter((f) => f.drip_raw >= wetRaw).length;
  const dripNow = lf.drip_raw;
  const startedDry = headMean(drip, 3) < DRY_RAW;
  const vClose = closeIndex(frames, 'valve');
  const valveWasOpen = frames.some((f) => f.valve === 'open');
  if (wetFrames > 0 && valveWasOpen) {
    let confirmed: boolean | null = null;
    const ev = [`drip_raw ≥ ${wetRaw} in ${wetFrames}/${frames.length} frames (now ${dripNow})`, `isolation valve was open in window${startedDry ? '; tray was dry at window start' : ''}`];
    if (vClose >= 0) {
      const c = confirmValve(frames.slice(vClose));
      confirmed = c.confirmed;
      ev.push(`valve closed at ${frames[vClose].at}${frames[vClose].event === 'valve_closed' ? ' by firmware' : ''}`, c.evidence);
    }
    waterCands.push({
      kind: 'coolant_leak_at_rack', confidence: startedDry ? 'high' : 'medium', rootCause: 'Coolant dripping from the loop at this rack',
      action: 'close isolation valve', actionConfirmed: confirmed, timeToLimitMin: null, route: 'it', evidence: ev,
    });
  } else if (dripNow >= wetRaw) {
    const explained = prev.some(
      (p) => p.kind === 'coolant_leak_at_rack' && nowMs - toMs(p.at) <= WATER_EXPLAINED_S * 1000,
    );
    if (!explained) {
      waterCands.push({
        kind: 'outside_water', confidence: 'medium', rootCause: 'Water in the tray with the coolant loop isolated: condensate, pipe or roof, not coolant',
        action: null, actionConfirmed: null, timeToLimitMin: null, route: 'facilities',
        evidence: [`drip_raw ${dripNow} ≥ ${wetRaw}`, 'isolation valve closed throughout the window', 'routed to facilities instead of IT'],
      });
    }
  }

  // ---------------------------------------------------- fans: vibration and failure
  let fanMatched = false;
  for (const fan of FANS) {
    if (!vibOk(fan)) continue;
    const idx = fan === 'fan_a' ? 0 : 1;
    const commanded = lf.fan_pct[idx] > 0;
    const disp = frameSeries(frames, (f) => f.vib?.[fan]?.disp_mm);
    const vel = vibSeries(frames, fan);
    if (!disp.length) continue;
    // stopped: commanded on but the mount is still
    const stillFrames = frames.filter((f) => (f.vib?.[fan]?.disp_mm ?? Infinity) < FAN_STOPPED_DISP_MM && f.fan_pct[idx] > 0).length;
    if (commanded && fansConstant && stillFrames >= 3 && tailMean(disp, 3) < FAN_STOPPED_DISP_MM) {
      fanMatched = true;
      const other = fan === 'fan_a' ? 'fan_b' : 'fan_a';
      symptoms.push({
        kind: 'single_fan_failure', channel: fan, confidence: loadStep >= FAN_LOAD_STEP_V ? 'high' : 'medium',
        rootCause: `${fan.replace('_', ' ')} commanded ${lf.fan_pct[idx]} % but its mount is still: fan stopped`,
        action: `ramp ${other.replace('_', ' ')} to max (firmware caps PWM at 70 %); log reduced redundancy`, actionConfirmed: null,
        timeToLimitMin: temp.length ? timeToLimit(tempNow, INLET_LIMIT_C, tempSlope) : null,
        route: 'it',
        evidence: [
          `${fan} displacement ${f2(tailMean(disp, 3) * 1000) } µm RMS < ${FAN_STOPPED_DISP_MM * 1000} µm in ${stillFrames}/${frames.length} frames`,
          loadStep >= FAN_LOAD_STEP_V ? `${packEv}: +${f2(loadStep)} V with unchanged commands → one motor stopped drawing current` : `${packEv} (no load step seen)`,
        ],
      });
      continue;
    }
    if (!commanded || vel.length < 3) continue;
    // vibration: over the warn line and held, or trending up fast
    const held = frames.filter((f) => (f.vib?.[fan]?.vel_mm_s ?? 0) >= VIB_WARN_MM_S);
    const heldS = held.length > 1 ? (toMs(held[held.length - 1].at) - toMs(held[0].at)) / 1000 : 0;
    const velNow = tailMean(vel, 3);
    const velStart = headMean(vel, 3);
    const trending = velStart > 0 && velNow >= velStart * (1 + VIB_TREND_FRACTION) && velNow >= VIB_WARN_MM_S / 2;
    if ((velNow >= VIB_WARN_MM_S && heldS >= VIB_HOLD_S) || trending) {
      fanMatched = true;
      const alarm = velNow >= VIB_ALARM_MM_S;
      const freq = lf.vib?.[fan]?.freq_hz;
      const slope = slopePerMin(vel);
      symptoms.push({
        kind: 'fan_vibration', channel: fan, confidence: alarm ? 'high' : 'medium', severity: alarm ? 'high' : 'medium',
        rootCause: `${fan.replace('_', ' ')} vibration ${alarm ? 'in the alarm zone' : trending && velNow < VIB_WARN_MM_S ? 'rising fast' : 'above the warn line'}: imbalance, loose mount or bearing wear`,
        action: alarm ? 'reduce this fan and lean on the other; inspect mount and blades' : 'inspect at next opportunity; trend against baseline', actionConfirmed: null,
        timeToLimitMin: alarm ? 0 : timeToLimit(velNow, VIB_ALARM_MM_S, slope),
        route: 'it',
        evidence: [
          `${fan} ${f2(velNow)} mm/s indicative RMS velocity (warn ${VIB_WARN_MM_S}, alarm ${VIB_ALARM_MM_S}); ${f2(velStart)} → ${f2(velNow)} over ${Math.round(spanS(vel))} s`,
          `displacement ${f2(tailMean(disp, 3) * 1000)} µm RMS${freq ? ` at ${f2(freq)} Hz` : ''}`,
          'ultrasonic displacement, not an ISO 10816 measurement — trend thresholds',
        ],
      });
    }
  }

  // ---------------------------------------------------- thermal (single inlet probe)
  const hasSpan = temp.length >= 3 && tempSpan >= MIN_SLOPE_SPAN_S;
  const fClose = closeIndex(frames, 'flap');
  const flapWasOpen = frames.some((f) => f.flap === 'open');
  if (!tempUntrusted && hasSpan) {
    const pre = fClose >= 0 ? frames.slice(0, fClose + 1) : frames;
    const preTemp = frameSeries(pre, (f) => f.temp_c);
    const preSlope = slopePerMin(preTemp);
    const preNow = last(preTemp);
    const above = Number.isFinite(baseline) ? preNow - baseline : NaN;
    if (flapWasOpen && (above >= RECIRC_DELTA_C || (preSlope >= RISE_C_PER_MIN && above >= RECIRC_DELTA_C / 2))) {
      const ev = [
        `inlet ${f2(preNow)} °C, ${sgn(preSlope)} °C/min; ${f2(above)} °C above baseline ${f2(baseline)} (limit ${RECIRC_DELTA_C})`,
        `flap ${pre[pre.length - 1].flap} at detection`,
      ];
      let confirmed: boolean | null = null;
      if (fClose >= 0) {
        const c = confirmFlap(frames.slice(fClose));
        confirmed = c.confirmed;
        ev.push(`flap closed at ${frames[fClose].at}${frames[fClose].event === 'flap_closed' ? ' by firmware' : ''}`, c.evidence);
      }
      symptoms.push({
        kind: 'recirculation', confidence: 'high',
        rootCause: 'Hot exhaust reaching the inlet: a missing blanking panel',
        action: 'close flap', actionConfirmed: confirmed,
        timeToLimitMin: timeToLimit(preNow, INLET_LIMIT_C, preSlope),
        route: 'it', evidence: ev,
      });
    } else if (!flapWasOpen && tempSlope >= RISE_C_PER_MIN && !fanMatched) {
      symptoms.push({
        kind: 'cold_supply_loss', confidence: 'medium', rootCause: 'Inlet warming with the flap shut and fans healthy: room cooling failing upstream',
        action: 'page IT with time-to-limit', actionConfirmed: null,
        timeToLimitMin: timeToLimit(tempNow, INLET_LIMIT_C, tempSlope),
        route: 'it',
        evidence: [
          `inlet ${f2(tempNow)} °C, ${sgn(tempSlope)} °C/min (rising ≥ ${RISE_C_PER_MIN})`,
          `flap closed throughout; fans ${lf.fan_pct[0]}/${lf.fan_pct[1]} % ${fansConstant ? 'unchanged' : 'changed'}; both fans vibrating normally`,
          `limit ${INLET_LIMIT_C} °C (ASHRAE A1 allowable)`,
        ],
      });
    }
  }

  // unclassified: inlet rising fast or over the limit and no rule explains it
  if (symptoms.length === 0 && !tempUntrusted && hasSpan) {
    const holdEnd = toMs(lf.at) - UNCLASSIFIED_HOLD_S * 1000;
    const earlier = frameSeries(frames.filter((f) => toMs(f.at) <= holdEnd), (f) => f.temp_c);
    const oddNow = tempSlope >= ANOMALY_C_PER_MIN || tempNow >= INLET_LIMIT_C;
    const oddEarlier = earlier.length >= 3 && (slopePerMin(earlier) >= ANOMALY_C_PER_MIN || last(earlier) >= INLET_LIMIT_C);
    if (oddNow && oddEarlier) {
      symptoms.push({
        kind: 'unclassified_anomaly', confidence: 'low', rootCause: 'Pattern outside the rule set',
        action: null, actionConfirmed: null,
        timeToLimitMin: timeToLimit(tempNow, INLET_LIMIT_C, tempSlope),
        route: 'it',
        evidence: [`inlet ${f2(tempNow)} °C, ${sgn(tempSlope)} °C/min (anomaly ≥ ${ANOMALY_C_PER_MIN} or ≥ ${INLET_LIMIT_C} °C)`, packEv, 'no rule in the nine-situation set matched'],
      });
    }
  }
  // ---------------------------------------------------- assemble: power suppresses symptoms
  const cands: Candidate[] = [];
  if (power) {
    const suppressed = symptoms.filter((c) => SYMPTOM_KINDS.includes(c.kind)).map((c) => c.kind);
    if (suppressed.length) power.evidence.push(`suppressed symptom rules: ${[...new Set(suppressed)].join(', ')}`);
    cands.push(power, ...sensorCands, ...waterCands);
  } else {
    cands.push(...sensorCands, ...waterCands, ...symptoms);
  }

  const key = (k: RigEventKind, ch?: string) => `${k}|${ch ?? ''}`;
  const dedupeMs = (opts.dedupeS ?? DEDUPE_S) * 1000;
  const active = new Set(prev.filter((p) => nowMs - toMs(p.at) <= dedupeMs).map((p) => key(p.kind, p.channel)));
  const recentExplanations = new Set(
    prev.filter((p) => INLET_EXPLANATIONS.includes(p.kind) && nowMs - toMs(p.at) <= EXPLAINED_RISE_S * 1000).map((p) => p.kind),
  );
  const explainedElsewhere = (k: RigEventKind) =>
    (k === 'cold_supply_loss' || k === 'unclassified_anomaly') && [...recentExplanations].some((e) => e !== k);
  return cands
    .filter((c) => !active.has(key(c.kind, c.channel)) && !explainedElsewhere(c.kind))
    .map((c) => ({ id: `rig-${c.kind}${c.channel ? `-${c.channel}` : ''}-${nowMs}`, at: now, source, ...c }));
}

/**
 * Follow-up for events whose fix was still unconfirmed when they were raised (diagnose only
 * returns NEW events). Returns updated copies — same `id` — of `prev` recirculation /
 * coolant_leak_at_rack events whose `actionConfirmed` can now be decided from `window`.
 */
export function followUp(window: StampedFrame[], prev: RigEvent[], _opts: DiagnoseOptions = {}): RigEvent[] {
  const frames = windowOf(window);
  if (frames.length === 0) return [];
  const out: RigEvent[] = [];
  for (const p of prev) {
    if (p.actionConfirmed !== null) continue;
    if (p.kind !== 'recirculation' && p.kind !== 'coolant_leak_at_rack') continue;
    const key = p.kind === 'recirculation' ? 'flap' : 'valve';
    let idx = closeIndex(frames, key);
    if (idx < 0 && frames.every((f) => f[key] === 'closed') && toMs(frames[0].at) >= toMs(p.at)) idx = 0;
    if (idx < 0) continue;
    const c = key === 'flap' ? confirmFlap(frames.slice(idx)) : confirmValve(frames.slice(idx));
    if (c.confirmed === null) continue;
    out.push({ ...p, actionConfirmed: c.confirmed, evidence: [...p.evidence, `${key} closed at ${frames[idx].at}`, c.evidence] });
  }
  return out;
}
