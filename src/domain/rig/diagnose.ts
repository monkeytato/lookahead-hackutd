/**
 * The rig's own rule set: the ten situations in the wiring doc ("What it detects and does") plus
 * an unclassified-anomaly catch-all. Pure and stateless — the caller passes a recent window of
 * frames (30–60 s) and the events it already holds; only NEW events come back.
 *
 * Rules see acoustic beams through `beamSamples` (held repeats removed, see ./stats), so slopes
 * are fitted to real averages. Slopes are per minute. Channels the firmware marks as timed out,
 * obstructed, or disagreeing with the reference are untrusted and ignored by every other rule.
 *
 * Power loss is the root cause of everything thermal that follows it (fans and servos share the
 * pack), so when it matches, the fan/heat/airflow symptom rules are suppressed in the same call:
 * one alert instead of four.
 */
import type { FrameSource, RigEvent, RigEventKind, StampedFrame } from './protocol';
import { BEAMS, beamChannel, beamSamples, frameSeries, mean, round, slopePerMin, spanS, toMs, type Beam, type Sample } from './stats';
import { DEFAULT_FLOOR_WET_RAW, DEFAULT_RESERVOIR_FULL_RAW } from './scan';

// ---------------------------------------------------------------- thresholds
/** Frames older than this (s) before the newest frame are ignored. */
export const DIAG_WINDOW_S = 60;
/** An event of the same kind (and channel) raised within this many seconds is still active. */
export const DEDUPE_S = 60;
/** Slope rules need at least this much acoustic history (s): two full beam cycles. */
export const MIN_SLOPE_SPAN_S = 10;
/** A temperature is "rising" at or above this slope (°C/min). ~4σ of the slope noise over 60 s. */
export const RISE_C_PER_MIN = 0.6;
/** A temperature is "flat" when |slope| is at or below this (°C/min). */
export const FLAT_C_PER_MIN = 0.4;
/** inlet_top − inlet_bottom spread that signals hot air over the divider (°C); same as firmware. */
export const RECIRC_SPREAD_C = 1.5;
/** The spread must also be growing at least this fast (°C/min) unless inlet_top itself is rising. */
export const RECIRC_GROWTH_C_PER_MIN = 0.5;
/** "Bottom flat" for recirculation: bottom slope ≤ max(FLAT_C_PER_MIN, this × top slope). The
 *  pre-flap-close segment can be only ~20 s (4 bottom averages), too short for an absolute test. */
export const BOTTOM_FLAT_FRACTION = 0.5;
/** "Together": inlet slopes may differ by at most this (°C/min) for a cold-supply loss. */
export const INLETS_TOGETHER_C_PER_MIN = 0.8;
/** Pack below this (V) cannot drive the fans and servos. */
export const PACK_LOW_V = 6.0;
/** …or a fall of this fraction against the start of the window. */
export const PACK_DROP_FRACTION = 0.2;
/**
 * Pack rises by at least this (V) with unchanged fan commands → one motor stopped drawing current.
 * This is how the rig tells a fan failure from a heat spike without a tachometer (each TT motor
 * sags the 6×AA pack ~0.1–0.2 V at 70 % through its internal resistance); still only medium confidence.
 */
export const FAN_LOAD_STEP_V = 0.05;
/** Reservoir drop over the window (percentage points) that counts as "dropping"… */
export const RESERVOIR_DROP_PCT = 2;
/** …together with a fitted slope at or below this (%/min). */
export const RESERVOIR_DROP_SLOPE_PCT_PER_MIN = -1;
/** "Steady" reservoir: |slope| below this (%/min) and net change below RESERVOIR_STEADY_PCT. */
export const RESERVOIR_STEADY_SLOPE_PCT_PER_MIN = 0.5;
export const RESERVOIR_STEADY_PCT = 1;
/** After the valve closes, "stopped dropping" = net change < RESERVOIR_STEADY_PCT and slope at or
 *  above this (%/min). Looser than "steady" because only ~10 s of noisy level are available; a
 *  real leak through the open valve runs at tens of %/min. */
export const RESERVOIR_STOPPED_SLOPE_PCT_PER_MIN = -3;
/** A leak elsewhere must keep the reservoir dropping this long (s) with the tray dry; a leak at
 *  this rack reaches the floor sensor within ~10 s, so shorter drops are still ambiguous. */
export const LEAK_ELSEWHERE_HOLD_S = 20;
/** Seconds after an actuator moved before its effect can confirm (or refute) the fix. */
export const CONFIRM_AFTER_S = 8;
/** …and after this long without the expected effect the fix is reported as not confirmed. */
export const REFUTE_AFTER_S = 20;
/** An echo shorter than this (µs) would mean air above ~100 °C over 178 mm: something is in the beam. */
export const OBSTRUCTED_ECHO_US = 900;
/** Acoustic vs DS18B20 disagreement (°C) the doc calls bad data. */
export const REF_DISAGREE_C = 2;
/** ASHRAE A1 allowable inlet upper limit (°C). */
export const INLET_LIMIT_C = 32;
/** Outlet / hot-aisle limit (°C). ASSUMPTION — not from the doc; a conservative exhaust ceiling. */
export const OUTLET_LIMIT_C = 45;
/** Unexplained rise at or above this (°C/min) is reported as an unclassified anomaly. */
export const ANOMALY_C_PER_MIN = 1.5;
/** Heat spike also needs delta_t up at least this much (°C, last 5 vs first 5 frames) so slope
 *  noise on a flat outlet cannot trigger it. */
export const HEAT_MIN_RISE_C = 1.0;
/** …but only once it has also been visible in the window ending this many seconds earlier, so
 *  the named rules get a chance to match a developing pattern first. */
export const UNCLASSIFIED_HOLD_S = 20;
/** A floor already explained by a coolant leak within this many seconds is not "outside water". */
export const WATER_EXPLAINED_S = 1800;

export interface DiagnoseOptions {
  reservoirFullRaw?: number;
  floorWetRaw?: number;
  /** Override DEDUPE_S (seconds an event stays "active" for de-duplication). */
  dedupeS?: number;
}

/** How long (s) an outlet-rise explanation keeps covering the tail of its rise: ~3 time constants
 *  of the rise plus one window. */
export const EXPLAINED_RISE_S = 120;

/**
 * Outlet-rise explanations. While one of these was raised within the last EXPLAINED_RISE_S, a
 * *different* one (or an unclassified anomaly) is not raised: the tail of the same rise would
 * otherwise be re-explained once the triggering step (e.g. the pack load step) leaves the window.
 */
const OUTLET_EXPLANATIONS: readonly RigEventKind[] = [
  'power_loss', 'single_fan_failure', 'heat_load_spike', 'cold_supply_loss', 'recirculation',
];

type Candidate = Omit<RigEvent, 'id' | 'at' | 'source'>;

const THERMAL_KINDS: readonly RigEventKind[] = [
  'single_fan_failure', 'recirculation', 'heat_load_spike', 'cold_supply_loss', 'unclassified_anomaly',
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

interface BeamView {
  samples: Sample[];
  slope: number;
  now: number;
  span: number;
}

function beamView(frames: readonly StampedFrame[], beam: Beam): BeamView {
  const samples = beamSamples(frames, beam);
  return { samples, slope: slopePerMin(samples), now: last(samples), span: spanS(samples) };
}

function spreadSeries(frames: readonly StampedFrame[]): Sample[] {
  return frameSeries(frames, (f) =>
    f.inlet_top_c === null || f.inlet_bottom_c === null ? null : f.inlet_top_c - f.inlet_bottom_c,
  );
}

// ---------------------------------------------------------------- action confirmation

/** Recirculation fix: after the flap closed, did inlet_top recover? */
function confirmFlap(post: readonly StampedFrame[]): { confirmed: boolean | null; evidence: string } {
  const top = beamSamples(post, 'inlet_top');
  const spread = spreadSeries(post);
  const span = post.length > 1 ? (toMs(post[post.length - 1].at) - toMs(post[0].at)) / 1000 : 0;
  if (span < CONFIRM_AFTER_S || top.length < 2) return { confirmed: null, evidence: 'flap closed; waiting for inlet_top to respond' };
  const slope = slopePerMin(top);
  const spreadNow = last(spread);
  const recovering = slope < 0 || spreadNow < RECIRC_SPREAD_C;
  if (recovering) {
    return { confirmed: true, evidence: `after flap closed: inlet_top slope ${sgn(slope)} °C/min, spread now ${f2(spreadNow)} °C` };
  }
  if (span >= REFUTE_AFTER_S) {
    return { confirmed: false, evidence: `flap closed ${Math.round(span)} s ago but inlet_top still ${sgn(slope)} °C/min` };
  }
  return { confirmed: null, evidence: 'flap closed; inlet_top not yet recovering' };
}

/** Leak fix: after the valve closed, did the reservoir stop dropping? */
function confirmValve(post: readonly StampedFrame[], fullRaw: number): { confirmed: boolean | null; evidence: string } {
  const res = frameSeries(post, (f) => (f.reservoir_raw / fullRaw) * 100);
  const span = spanS(res);
  if (span < CONFIRM_AFTER_S) return { confirmed: null, evidence: 'valve closed; waiting for reservoir to settle' };
  const slope = slopePerMin(res);
  const drop = headMean(res, 3) - tailMean(res, 3);
  if (slope >= RESERVOIR_STOPPED_SLOPE_PCT_PER_MIN && drop < RESERVOIR_STEADY_PCT) {
    return { confirmed: true, evidence: `after valve closed: reservoir ${sgn(slope)} %/min over ${Math.round(span)} s` };
  }
  if (span >= REFUTE_AFTER_S) {
    return { confirmed: false, evidence: `valve closed but reservoir still ${sgn(slope)} %/min (plug may not seal)` };
  }
  return { confirmed: null, evidence: 'valve closed; reservoir not yet steady' };
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
  const fullRaw = opts.reservoirFullRaw ?? DEFAULT_RESERVOIR_FULL_RAW;
  const wetRaw = opts.floorWetRaw ?? DEFAULT_FLOOR_WET_RAW;
  const source: FrameSource = frames.some((f) => f.source === 'simulated') ? 'simulated' : 'live';
  const nowMs = toMs(now);

  const sensorCands: Candidate[] = [];
  const waterCands: Candidate[] = [];
  const thermal: Candidate[] = [];
  let power: Candidate | null = null;

  // ---------------------------------------------------- sensor fault / obstruction (untrusted channels)
  const untrusted = new Set<Beam>();
  for (const beam of BEAMS) {
    const ch = beamChannel(beam);
    const obsFlag = frames.filter((f) => f.flags.includes(`${beam}_obstructed`)).length;
    const shortEchoes = frames.map((f) => f.echo_us[beam]).filter((e): e is number => e !== null && e < OBSTRUCTED_ECHO_US);
    if (obsFlag > 0 || shortEchoes.length > 0) {
      untrusted.add(beam);
      const ev: string[] = [];
      if (obsFlag) ev.push(`${obsFlag}/${frames.length} frames flagged ${beam}_obstructed`);
      if (shortEchoes.length) ev.push(`${beam} echo ${f2(Math.min(...shortEchoes))} µs < ${OBSTRUCTED_ECHO_US} µs (≈1040 µs expected; no air temperature explains it)`);
      sensorCands.push({
        kind: 'obstruction', channel: ch, confidence: 'high',
        rootCause: `Something is blocking the ${beam.replace('_', ' ')} beam / aisle`,
        action: 'flag blocked aisle', actionConfirmed: null, timeToLimitMin: null, route: 'it', evidence: ev,
      });
    }
    const timeouts = frames.filter((f) => f.flags.includes(`${beam}_timeout`)).length;
    if (timeouts > 0) {
      untrusted.add(beam);
      sensorCands.push({
        kind: 'sensor_fault', channel: ch, confidence: 'high',
        rootCause: `Bad data, not a real event: ${beam} echo timeout`,
        action: `mark ${ch} untrusted; no page`, actionConfirmed: null, timeToLimitMin: null, route: 'none',
        evidence: [`${timeouts}/${frames.length} frames flagged ${beam}_timeout`],
      });
    }
  }
  {
    const flagged = frames.filter((f) => f.flags.includes('ref_disagree'));
    const named = BEAMS.filter((b) => frames.some((f) => f.flags.includes(`${b}_ref_disagree`)));
    const bottom = beamSamples(frames, 'inlet_bottom');
    const ref = frameSeries(frames, (f) => f.ref_c);
    const gap = bottom.length && ref.length ? mean(bottom.map((s) => s.v)) - mean(ref.map((s) => s.v)) : NaN;
    const computed = Number.isFinite(gap) && Math.abs(gap) > REF_DISAGREE_C;
    const beams: Beam[] = named.length ? named : flagged.length || computed ? ['inlet_bottom'] : [];
    for (const beam of beams) {
      if (untrusted.has(beam) && sensorCands.some((c) => c.kind === 'sensor_fault' && c.channel === beamChannel(beam))) continue;
      untrusted.add(beam);
      const ch = beamChannel(beam);
      const ev: string[] = [];
      if (flagged.length) ev.push(`${flagged.length}/${frames.length} frames flagged ref_disagree${named.includes(beam) ? ` (${beam}_ref_disagree)` : ''}`);
      const bs = beamSamples(frames, beam);
      if (bs.length && ref.length) {
        ev.push(`mean ${ch} ${f2(mean(bs.map((s) => s.v)))} °C vs ref_c ${f2(mean(ref.map((s) => s.v)))} °C (limit ±${REF_DISAGREE_C} °C)`);
      }
      sensorCands.push({
        kind: 'sensor_fault', channel: ch, confidence: 'medium',
        rootCause: `Bad data, not a real event: ${ch} disagrees with the reference probe`,
        action: `mark ${ch} untrusted; no page`, actionConfirmed: null, timeToLimitMin: null, route: 'none', evidence: ev,
      });
    }
  }
  const trusted = (b: Beam) => !untrusted.has(b);

  // ---------------------------------------------------- power
  const pack = frameSeries(frames, (f) => f.pack_v);
  const packStart = headMean(pack);
  const packEnd = tailMean(pack, 3);
  const top = beamView(frames, 'inlet_top');
  const bottom = beamView(frames, 'inlet_bottom');
  const outlet = beamView(frames, 'outlet');
  if (pack.length >= 2 && (packEnd < PACK_LOW_V || packEnd <= packStart * (1 - PACK_DROP_FRACTION))) {
    const ev = [`pack_v ${f2(packStart)} V → ${f2(packEnd)} V (low < ${PACK_LOW_V} V or −${PACK_DROP_FRACTION * 100} %)`];
    const lf = frames[frames.length - 1];
    ev.push(`fan_pct now ${lf.fan_pct[0]}/${lf.fan_pct[1]} %`);
    if (trusted('outlet') && outlet.samples.length) ev.push(`outlet_c ${f2(outlet.now)} °C, slope ${sgn(outlet.slope)} °C/min`);
    if (trusted('inlet_top') && top.samples.length) ev.push(`inlet_top_c ${f2(top.now)} °C, slope ${sgn(top.slope)} °C/min`);
    power = {
      kind: 'power_loss', confidence: 'high',
      rootCause: 'Power is the root cause; the temperature rise is a symptom',
      action: 'automatic fixes unavailable — actuators share the pack',
      actionConfirmed: null,
      timeToLimitMin: trusted('outlet') ? timeToLimit(outlet.now, OUTLET_LIMIT_C, outlet.slope) : null,
      route: 'it', evidence: ev,
    };
  }

  // ---------------------------------------------------- water
  const res = frameSeries(frames, (f) => (f.reservoir_raw / fullRaw) * 100);
  const wetFrames = frames.filter((f) => f.floor_raw >= wetRaw).length;
  const floorNow = frames[frames.length - 1].floor_raw;
  const vClose = closeIndex(frames, 'valve');
  const preValve = vClose >= 0 ? frames.slice(0, vClose + 1) : frames;
  const resPre = frameSeries(preValve, (f) => (f.reservoir_raw / fullRaw) * 100);
  const resDrop = headMean(resPre, 3) - tailMean(resPre, 3);
  const resSlope = slopePerMin(resPre);
  const dropping = resPre.length >= 3 && resDrop >= RESERVOIR_DROP_PCT && resSlope <= RESERVOIR_DROP_SLOPE_PCT_PER_MIN;
  const resEv = `reservoir ${f2(headMean(resPre, 3))} % → ${f2(tailMean(resPre, 3))} % (${sgn(resSlope)} %/min; dropping ≥ ${RESERVOIR_DROP_PCT} pts & ≤ ${RESERVOIR_DROP_SLOPE_PCT_PER_MIN} %/min)`;
  if (dropping && wetFrames > 0) {
    let confirmed: boolean | null = null;
    const ev = [resEv, `floor_raw ≥ ${wetRaw} in ${wetFrames}/${frames.length} frames (now ${floorNow})`];
    if (vClose >= 0) {
      const c = confirmValve(frames.slice(vClose), fullRaw);
      confirmed = c.confirmed;
      ev.push(`valve closed at ${frames[vClose].at}${frames[vClose].event === 'valve_closed' ? ' by firmware' : ''}`, c.evidence);
    } else if (frames[frames.length - 1].valve === 'closed') {
      const c = confirmValve(frames, fullRaw);
      confirmed = c.confirmed === true ? true : c.confirmed === null ? null : false;
      ev.push('valve already closed', c.evidence);
    }
    const resTail = vClose >= 0 ? frameSeries(frames.slice(vClose), (f) => (f.reservoir_raw / fullRaw) * 100) : resPre;
    const tailSlope = slopePerMin(resTail);
    waterCands.push({
      kind: 'coolant_leak_at_rack', confidence: 'high', rootCause: 'Leak at this rack',
      action: 'close isolation valve', actionConfirmed: confirmed,
      // governing channel = reservoir, limit = empty (0 %)
      timeToLimitMin: tailSlope < RESERVOIR_DROP_SLOPE_PCT_PER_MIN ? round(last(resTail) / -tailSlope, 1) : null,
      route: 'it', evidence: ev,
    });
  } else if (dropping && wetFrames === 0) {
    // how long has it been dropping? since the last time it was within 1 pt of the window peak
    const peak = Math.max(...res.map((s) => s.v));
    let onset = res[0].t;
    for (const s of res) if (s.v >= peak - RESERVOIR_STEADY_PCT) onset = s.t;
    const droppingForS = (res[res.length - 1].t - onset) / 1000;
    if (droppingForS >= LEAK_ELSEWHERE_HOLD_S) {
      waterCands.push({
        kind: 'leak_elsewhere', confidence: 'medium', severity: 'low',
        rootCause: 'Leak somewhere else in the loop',
        action: null, actionConfirmed: null,
        timeToLimitMin: resSlope < 0 ? round(last(res) / -resSlope, 1) : null,
        route: 'it',
        evidence: [resEv, `dropping for ${Math.round(droppingForS)} s with floor_raw < ${wetRaw} in every frame (max ${Math.max(...frames.map((f) => f.floor_raw))})`, 'lower-severity page'],
      });
    }
  }
  {
    const resAll = slopePerMin(res);
    const resNet = headMean(res, 3) - tailMean(res, 3);
    const steady = Math.abs(resAll) < RESERVOIR_STEADY_SLOPE_PCT_PER_MIN && Math.abs(resNet) < RESERVOIR_STEADY_PCT;
    const explained = prev.some(
      (p) => (p.kind === 'coolant_leak_at_rack' || p.kind === 'leak_elsewhere') && nowMs - toMs(p.at) <= WATER_EXPLAINED_S * 1000,
    );
    if (floorNow >= wetRaw && steady && !dropping && !explained) {
      waterCands.push({
        kind: 'outside_water', confidence: 'medium', rootCause: 'Pipe, roof or condensate, not coolant',
        action: null, actionConfirmed: null, timeToLimitMin: null, route: 'facilities',
        evidence: [`floor_raw ${floorNow} ≥ ${wetRaw}`, `reservoir steady: ${sgn(resAll)} %/min, net ${sgn(-resNet)} pts`, 'routed to facilities instead of IT'],
      });
    }
  }

  // ---------------------------------------------------- thermal
  const lf = frames[frames.length - 1];
  const fansConstant = frames.every((f) => f.fan_pct[0] === frames[0].fan_pct[0] && f.fan_pct[1] === frames[0].fan_pct[1]);
  const fansRunning = lf.fan_pct[0] > 0 && lf.fan_pct[1] > 0;
  const loadStep = pack.length >= 4 ? packEnd - packStart : 0;
  const hasSpan = (b: BeamView) => b.span >= MIN_SLOPE_SPAN_S && b.samples.length >= 3;
  const inletsOk = trusted('inlet_top') && trusted('inlet_bottom');
  const outletOk = trusted('outlet') && hasSpan(outlet);
  const packEv = pack.length ? `pack_v ${f2(packStart)} → ${f2(packEnd)} V` : 'pack_v not fitted';
  let recircMatched = false;
  let coldMatched = false;

  // cold-air supply loss: both inlets rising together
  if (inletsOk && hasSpan(top) && hasSpan(bottom) && top.slope >= RISE_C_PER_MIN && bottom.slope >= RISE_C_PER_MIN &&
      Math.abs(top.slope - bottom.slope) <= INLETS_TOGETHER_C_PER_MIN) {
    coldMatched = true;
    const gov = top.now >= bottom.now ? { b: 'inlet_top', v: top } : { b: 'inlet_bottom', v: bottom };
    thermal.push({
      kind: 'cold_supply_loss', confidence: 'medium', rootCause: 'Room cooling failing upstream',
      action: 'page IT with time-to-limit', actionConfirmed: null,
      timeToLimitMin: timeToLimit(gov.v.now, INLET_LIMIT_C, gov.v.slope),
      route: 'it',
      evidence: [
        `inlet_top_c ${f2(top.now)} °C, ${sgn(top.slope)} °C/min; inlet_bottom_c ${f2(bottom.now)} °C, ${sgn(bottom.slope)} °C/min (rising ≥ ${RISE_C_PER_MIN})`,
        `inlets within ${INLETS_TOGETHER_C_PER_MIN} °C/min of each other`,
        `limit ${INLET_LIMIT_C} °C (ASHRAE allowable) on ${gov.b}`,
      ],
    });
  }

  // recirculation: top inlet rising, bottom flat (detected up to the flap closing, confirmed after)
  if (inletsOk && !coldMatched) {
    const fClose = closeIndex(frames, 'flap');
    const pre = fClose >= 0 ? frames.slice(0, fClose + 1) : frames;
    const pTop = beamView(pre, 'inlet_top');
    const pBottom = beamView(pre, 'inlet_bottom');
    const spread = spreadSeries(pre);
    const spreadMax = spread.length ? Math.max(...spread.map((s) => s.v)) : NaN;
    const spreadSlope = slopePerMin(spread);
    const enough = pTop.samples.length >= 2 && spanS(spread) >= 5;
    if (enough && spreadMax >= RECIRC_SPREAD_C && pBottom.slope <= Math.max(FLAT_C_PER_MIN, BOTTOM_FLAT_FRACTION * pTop.slope) &&
        (spreadSlope >= RECIRC_GROWTH_C_PER_MIN || pTop.slope >= RISE_C_PER_MIN)) {
      recircMatched = true;
      const ev = [
        `inlet_top_c ${f2(pTop.now)} °C, ${sgn(pTop.slope)} °C/min; inlet_bottom_c ${f2(pBottom.now)} °C, ${sgn(pBottom.slope)} °C/min (flat ≤ ${FLAT_C_PER_MIN})`,
        `top − bottom up to ${f2(spreadMax)} °C (> ${RECIRC_SPREAD_C}), growing ${sgn(spreadSlope)} °C/min`,
        `flap ${pre[pre.length - 1].flap} at detection`,
      ];
      let confirmed: boolean | null = null;
      if (fClose >= 0) {
        const c = confirmFlap(frames.slice(fClose));
        confirmed = c.confirmed;
        ev.push(`flap closed at ${frames[fClose].at}${frames[fClose].event === 'flap_closed' ? ' by firmware' : ''}`, c.evidence);
      }
      thermal.push({
        kind: 'recirculation', confidence: 'high',
        rootCause: 'Hot air spilling over the divider: a missing blanking panel',
        action: 'close flap', actionConfirmed: confirmed,
        timeToLimitMin: timeToLimit(pTop.now, INLET_LIMIT_C, pTop.slope),
        route: 'it', evidence: ev,
      });
    }
  }

  const inletsFlat =
    (!trusted('inlet_top') || Math.abs(top.slope) <= FLAT_C_PER_MIN) &&
    (!trusted('inlet_bottom') || Math.abs(bottom.slope) <= FLAT_C_PER_MIN);
  const outletRising = outletOk && outlet.slope >= RISE_C_PER_MIN;

  // single fan failure: outlet rising, power normal, beams clear, no recirculation, motor load dropped
  if (!coldMatched && !recircMatched && outletRising && fansConstant && fansRunning && loadStep >= FAN_LOAD_STEP_V) {
    thermal.push({
      kind: 'single_fan_failure', confidence: 'medium',
      rootCause: "Airflow loss, likely a fan — found by elimination (power normal, beams clear, no recirculation); can't say which fan",
      action: 'ramp surviving fan to max (firmware caps PWM at 70 %); log reduced redundancy', actionConfirmed: null,
      timeToLimitMin: timeToLimit(outlet.now, OUTLET_LIMIT_C, outlet.slope),
      route: 'it',
      evidence: [
        `outlet_c ${f2(outlet.now)} °C, ${sgn(outlet.slope)} °C/min (rising ≥ ${RISE_C_PER_MIN})`,
        `${packEv}: +${f2(loadStep)} V with unchanged fan commands ${lf.fan_pct[0]}/${lf.fan_pct[1]} % → one motor stopped drawing current (≥ ${FAN_LOAD_STEP_V} V)`,
        'beams clear; inlets flat',
        `limit ${OUTLET_LIMIT_C} °C (assumed outlet ceiling)`,
      ],
    });
  }

  // heat load spike: outlet − inlet rising, inlets flat, fans & power normal
  if (!coldMatched && !recircMatched && outletOk && inletsFlat && fansConstant && fansRunning && loadStep < FAN_LOAD_STEP_V) {
    const dt = frameSeries(frames, (f) => {
      const ins = [trusted('inlet_top') ? f.inlet_top_c : null, trusted('inlet_bottom') ? f.inlet_bottom_c : null]
        .filter((x): x is number => x !== null);
      return f.outlet_c === null || ins.length === 0 ? null : f.outlet_c - mean(ins);
    });
    const dtSlope = slopePerMin(dt);
    const dtRise = tailMean(dt) - headMean(dt);
    if (dtSlope >= RISE_C_PER_MIN && dtRise >= HEAT_MIN_RISE_C) {
      thermal.push({
        kind: 'heat_load_spike', confidence: 'medium', rootCause: 'The server is putting out more heat',
        action: 'flag rack; count down time-to-limit', actionConfirmed: null,
        timeToLimitMin: timeToLimit(outlet.now, OUTLET_LIMIT_C, outlet.slope),
        route: 'it',
        evidence: [
          `delta_t ${f2(last(dt))} °C, ${sgn(dtSlope)} °C/min (rising ≥ ${RISE_C_PER_MIN}), up ${f2(dtRise)} °C in window (≥ ${HEAT_MIN_RISE_C})`,
          `inlets flat: top ${sgn(top.slope)}, bottom ${sgn(bottom.slope)} °C/min`,
          `fans ${lf.fan_pct[0]}/${lf.fan_pct[1]} % unchanged; ${packEv} (no load step)`,
          `outlet_c ${f2(outlet.now)} °C; limit ${OUTLET_LIMIT_C} °C (assumed outlet ceiling)`,
        ],
      });
    }
  }

  // unclassified: something is rising fast (or over its limit) and no thermal rule explains it
  if (thermal.length === 0) {
    const anomalies = (fs: readonly StampedFrame[]) => {
      const views: { ch: string; v: BeamView; limit: number }[] = [];
      const limits: Record<Beam, number> = { inlet_top: INLET_LIMIT_C, inlet_bottom: INLET_LIMIT_C, outlet: OUTLET_LIMIT_C };
      for (const b of BEAMS) if (trusted(b)) views.push({ ch: beamChannel(b), v: beamView(fs, b), limit: limits[b] });
      return views.filter((x) => (hasSpan(x.v) && x.v.slope >= ANOMALY_C_PER_MIN) || x.v.now >= x.limit);
    };
    const odd = anomalies(frames);
    const holdEnd = toMs(lf.at) - UNCLASSIFIED_HOLD_S * 1000;
    const earlier = anomalies(frames.filter((f) => toMs(f.at) <= holdEnd));
    if (odd.length && earlier.length) {
      const gov = odd.reduce((a, b) => {
        const ta = timeToLimit(a.v.now, a.limit, a.v.slope) ?? Infinity;
        const tb = timeToLimit(b.v.now, b.limit, b.v.slope) ?? Infinity;
        return tb < ta ? b : a;
      });
      const ev = odd.map((x) => `${x.ch} ${f2(x.v.now)} °C, ${sgn(x.v.slope)} °C/min (anomaly ≥ ${ANOMALY_C_PER_MIN} or ≥ ${x.limit} °C)`);
      if (!fansConstant) ev.push(`fan commands changed in window (now ${lf.fan_pct[0]}/${lf.fan_pct[1]} %)`);
      ev.push(packEv, 'no rule in the ten-situation set matched');
      thermal.push({
        kind: 'unclassified_anomaly', confidence: 'low', rootCause: 'Pattern outside the rule set',
        action: null, actionConfirmed: null,
        timeToLimitMin: timeToLimit(gov.v.now, gov.limit, gov.v.slope),
        route: 'it', evidence: ev,
      });
    }
  }

  // ---------------------------------------------------- assemble: power suppresses thermal symptoms
  const cands: Candidate[] = [];
  if (power) {
    const suppressed = thermal.filter((c) => THERMAL_KINDS.includes(c.kind)).map((c) => c.kind);
    if (suppressed.length) power.evidence.push(`suppressed symptom rules: ${suppressed.join(', ')}`);
    cands.push(power, ...sensorCands, ...waterCands);
  } else {
    cands.push(...sensorCands, ...waterCands, ...thermal);
  }

  const key = (k: RigEventKind, ch?: string) => `${k}|${ch ?? ''}`;
  const dedupeMs = (opts.dedupeS ?? DEDUPE_S) * 1000;
  const active = new Set(prev.filter((p) => nowMs - toMs(p.at) <= dedupeMs).map((p) => key(p.kind, p.channel)));
  const recentExplanations = new Set(
    prev
      .filter((p) => OUTLET_EXPLANATIONS.includes(p.kind) && nowMs - toMs(p.at) <= EXPLAINED_RISE_S * 1000)
      .map((p) => p.kind),
  );
  const explainedElsewhere = (k: RigEventKind) =>
    (k === 'single_fan_failure' || k === 'heat_load_spike' || k === 'unclassified_anomaly') &&
    [...recentExplanations].some((e) => e !== k);
  return cands
    .filter((c) => !active.has(key(c.kind, c.channel)) && !explainedElsewhere(c.kind))
    .map((c) => ({
      id: `rig-${c.kind}${c.channel ? `-${c.channel}` : ''}-${nowMs}`,
      at: now,
      source,
      ...c,
    }));
}

/**
 * Follow-up for events whose fix was still unconfirmed when they were raised (diagnose only
 * returns NEW events). Returns updated copies — same `id` — of `prev` recirculation /
 * coolant_leak_at_rack events whose `actionConfirmed` can now be decided from `window`.
 * The caller replaces its stored event by id.
 */
export function followUp(window: StampedFrame[], prev: RigEvent[], opts: DiagnoseOptions = {}): RigEvent[] {
  const frames = windowOf(window);
  if (frames.length === 0) return [];
  const fullRaw = opts.reservoirFullRaw ?? DEFAULT_RESERVOIR_FULL_RAW;
  const out: RigEvent[] = [];
  for (const p of prev) {
    if (p.actionConfirmed !== null) continue;
    if (p.kind !== 'recirculation' && p.kind !== 'coolant_leak_at_rack') continue;
    const key = p.kind === 'recirculation' ? 'flap' : 'valve';
    let idx = closeIndex(frames, key);
    if (idx < 0 && frames.every((f) => f[key] === 'closed') && toMs(frames[0].at) >= toMs(p.at)) idx = 0;
    if (idx < 0) continue;
    const c = key === 'flap' ? confirmFlap(frames.slice(idx)) : confirmValve(frames.slice(idx), fullRaw);
    if (c.confirmed === null) continue;
    out.push({ ...p, actionConfirmed: c.confirmed, evidence: [...p.evidence, `${key} closed at ${frames[idx].at}`, c.evidence] });
  }
  return out;
}
