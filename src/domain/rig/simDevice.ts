/**
 * SIMULATED Rack Monitor. Emits `RigFrame`s shaped exactly like the firmware's JSON lines (the
 * bridge stamps them `source: 'simulated'`) and answers the same command lines, so the whole
 * pipeline runs without hardware. The physics is deliberately simple and only plausible —
 * first-order lags toward targets — and every number here is a modelling assumption, not a
 * measurement:
 *
 *  - Room / cold supply 22.5 °C. Laptop exhaust lifts the outlet to ~31 °C with both fans at 70 %;
 *    the rise scales as 1 / (0.35 + 0.65·airflow), so one fan out → ~35 °C, no fans → ~47 °C.
 *  - Flap (blanking panel) open → hot-aisle air spills over the divider: inlet_top moves toward
 *    the outlet (70 % of the way, τ = 25 s, so mostly done in 60–90 s); inlet_bottom barely moves.
 *  - Valve open → reservoir drains ~8 raw/s into the drip tray; the floor sensor starts rising
 *    after ~6 s of dripping (48 raw of water to cover its traces).
 *  - The two on-device safety fixes run here exactly as the firmware does them when `auto` is on:
 *    close the flap when top − bottom ≥ 1.5 °C, close the valve when the reservoir is dropping and
 *    the floor is wet. The frame in which a fix happens carries `event`.
 *  - The flap/valve servos and the fans run off the 6×AA pack: with `sim power off` they stop
 *    (pack reads ~0.4 V), commands and safety fixes cannot move anything.
 *  - Acoustic beams refresh round-robin (one beam every 5/3 s, a full cycle every 5 s); between
 *    refreshes the last average is held and `beam_age_s` counts up. Each average carries Gaussian
 *    noise σ = 0.12 °C. `echo_us` is the round-trip time over d = 0.178 m at
 *    c = 331.3·√(1 + T/273.15), and the reported temperature is derived back from it.
 *  - DS18B20 reference (`ref_c`) is fitted: it tracks the inlet-bottom air (8 s lag), σ = 0.06 °C,
 *    quantized to the probe's 0.0625 °C step.
 *
 * Deterministic for a given seed. Pure TypeScript: no timers, no I/O — the caller drives `tick`.
 */
import { mulberry32 } from '../engine/rng';
import type { FrameSource, RigFrame, StampedFrame } from './protocol';
import type { Beam } from './stats';

// ---------------------------------------------------------------- simulation constants (assumed)
export const SIM_DEVICE_ID = 'RACKMON-SIM';
export const SIM_FIRMWARE = 'sim-1.0';
export const SIM_ROOM_C = 22.5;
/** One-way beam path (m), from the wiring doc. */
export const BEAM_PATH_M = 0.178;
/** Full acoustic cycle (s): three beams take turns, so each beam refreshes this often. */
export const BEAM_CYCLE_S = 5;
const BEAM_ORDER: readonly Beam[] = ['inlet_top', 'inlet_bottom', 'outlet'];
const BEAM_NOISE_C = 0.12;
const REF_NOISE_C = 0.06;
const REF_STEP_C = 0.0625;
const REF_LAG_S = 8;
const TAU_OUTLET_S = 20;
const TAU_TOP_S = 25;
const TAU_BOTTOM_S = 30;
const HEAT_RISE_NORMAL_C = 8.5;
/** `sim heat high`: +6 °C on the outlet at full airflow. */
const HEAT_RISE_HIGH_C = 14.5;
const RECIRC_FLAP_OPEN = 0.7;
/** Supply-air drift during `sim supply loss` (°C/min) and its ceiling (°C above room). */
const SUPPLY_LOSS_RATE_C_PER_MIN = 1.5;
const SUPPLY_LOSS_MAX_C = 10;
const FAN_MAX_PCT = 70;
const PACK_FRESH_V = 9.2;
const PACK_SAG_V_PER_S = 0.0003;
const PACK_MIN_V = 7.6;
/** Sag per fan running at 70 % (V): the pack's internal resistance under motor load. */
const FAN_LOAD_SAG_V = 0.15;
const PACK_DEAD_V = 0.4;
const PACK_NOISE_V = 0.01;
const RESERVOIR_START_RAW = 560;
const VALVE_DRAIN_RAW_PER_S = 8;
const REMOTE_LEAK_RAW_PER_S = 2;
/** Water (raw units drained) that must collect in the tray before the floor sensor responds. */
const FLOOR_DEAD_WATER = 48;
const FLOOR_GAIN = 4;
const SPILL_WATER = 200;
const FAULT_BIAS_C = 4;
/** Echo when something sits in the beam a few cm from the transducer. */
const OBSTRUCTED_PATH_M = 0.04;
/** Firmware safety-fix thresholds (mirrored by the diagnosis rules). */
const FW_RECIRC_SPREAD_C = 1.5;
const FW_REF_DISAGREE_C = 2;
/** inlet_top is only cross-checked against the reference once the flap has been shut this long. */
const FW_TOP_CHECK_SETTLE_S = 120;
const FW_RESERVOIR_DROP_RAW = 10;
const FW_RESERVOIR_DROP_WINDOW_S = 5;
const FW_FLOOR_WET_RAW = 120;
/** Below this (µs) no plausible air temperature explains the echo (that would be > ~100 °C). */
const FW_OBSTRUCTED_ECHO_US = 900;

/** Simulator-only commands beyond the `SimCommand` union, for staging the remaining situations. */
export const SIM_EXTRA_COMMANDS = [
  'sim supply loss', 'sim supply ok', // cold-air supply failing upstream
  'sim leak remote', 'sim leak stop', // reservoir drains somewhere other than this rack's tray
  'sim spill', 'sim dry', //             water on the floor that isn't coolant
] as const;

export function speedOfSound(tC: number): number {
  return 331.3 * Math.sqrt(1 + tC / 273.15);
}
/** Round-trip echo (µs) over a one-way path `d` metres at air temperature `tC`. */
export function echoUs(tC: number, d = BEAM_PATH_M): number {
  return ((2 * d) / speedOfSound(tC)) * 1e6;
}
/** Inverse of `echoUs`: T = 273.15·((c/331.3)² − 1), c = 2d/t. */
export function tempFromEcho(us: number, d = BEAM_PATH_M): number {
  const c = (2 * d) / (us * 1e-6);
  return 273.15 * ((c / 331.3) ** 2 - 1);
}

/** Bridge-style stamp for simulator frames (tests and the bridge's simulated mode). */
export function stamp(frame: RigFrame, at: string, source: FrameSource = 'simulated'): StampedFrame {
  return { ...frame, source, at };
}

interface BeamReading {
  value: number | null;
  echo: number | null;
  lastRefreshT: number;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

export class SimRig {
  private readonly rand: () => number;
  private t = 0;
  private seq = 0;
  // physical state
  private supplyOffset = 0;
  private trueTop: number;
  private trueBottom: number;
  private trueOutlet: number;
  private trueRef: number;
  private reservoir = RESERVOIR_START_RAW;
  private trayWater = 0;
  // actuators / modes
  private flap: 'open' | 'closed' = 'closed';
  private flapClosedSinceT = -Infinity;
  private valve: 'open' | 'closed' = 'closed';
  private fanCmd: [number, number] = [FAN_MAX_PCT, FAN_MAX_PCT];
  private auto = true;
  // staged faults
  private powerOn = true;
  private faultTop = false;
  private heatHigh = false;
  private fanAFailed = false;
  private outletBlocked = false;
  private supplyLoss = false;
  private remoteLeak = false;
  // firmware-side state
  private readonly beams: Record<Beam, BeamReading>;
  private nextBeam = 0;
  private nextRefreshT: number;
  private reservoirHistory: { t: number; raw: number }[] = [];
  private lastReservoirRaw = RESERVOIR_START_RAW;
  private lastFloorRaw = 0;
  private pendingEvent: string | null = null;

  constructor(seed = 1) {
    this.rand = mulberry32(seed);
    // start at steady state so nothing looks like a transient
    this.trueOutlet = this.outletTarget();
    this.trueTop = this.topTarget();
    this.trueBottom = this.bottomTarget();
    this.trueRef = this.trueBottom;
    const slot = BEAM_CYCLE_S / BEAM_ORDER.length;
    this.beams = {} as Record<Beam, BeamReading>;
    BEAM_ORDER.forEach((b, i) => {
      // pretend the previous cycle just finished: outlet at t=0, bottom 1 slot ago, top 2 slots ago
      this.beams[b] = { value: null, echo: null, lastRefreshT: (i - (BEAM_ORDER.length - 1)) * slot };
      this.measure(b, this.beams[b].lastRefreshT);
    });
    this.nextRefreshT = slot;
    this.lastReservoirRaw = this.readReservoir();
    this.reservoirHistory.push({ t: 0, raw: this.lastReservoirRaw });
  }

  // ---------------------------------------------------------------- physics
  private gauss(): number {
    const u = Math.max(this.rand(), 1e-12);
    const v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  private supply(): number {
    return SIM_ROOM_C + this.supplyOffset;
  }
  private effectiveFans(): [number, number] {
    if (!this.powerOn) return [0, 0];
    return [this.fanAFailed ? 0 : this.fanCmd[0], this.fanCmd[1]];
  }
  private airflow(): number {
    const [a, b] = this.effectiveFans();
    return (a + b) / (2 * FAN_MAX_PCT);
  }
  private outletTarget(): number {
    const rise = this.heatHigh ? HEAT_RISE_HIGH_C : HEAT_RISE_NORMAL_C;
    return this.supply() + rise / (0.35 + 0.65 * this.airflow());
  }
  private recircFraction(): number {
    // flap shut: only a trickle under the lid, a little more when the exhaust fans stop pulling
    return this.flap === 'open' ? RECIRC_FLAP_OPEN : 0.02 + 0.03 * (1 - this.airflow());
  }
  private topTarget(): number {
    return this.supply() + this.recircFraction() * (this.trueOutlet - this.supply());
  }
  private bottomTarget(): number {
    return this.supply() + 0.015 * this.recircFraction() * (this.trueOutlet - this.supply());
  }

  private step(h: number): void {
    this.t += h;
    if (this.supplyLoss) {
      this.supplyOffset = Math.min(SUPPLY_LOSS_MAX_C, this.supplyOffset + (SUPPLY_LOSS_RATE_C_PER_MIN / 60) * h);
    } else {
      this.supplyOffset = Math.max(0, this.supplyOffset - (SUPPLY_LOSS_RATE_C_PER_MIN / 60) * h);
    }
    const lag = (x: number, target: number, tau: number) => x + (target - x) * (1 - Math.exp(-h / tau));
    this.trueOutlet = lag(this.trueOutlet, this.outletTarget(), TAU_OUTLET_S);
    this.trueTop = lag(this.trueTop, this.topTarget(), TAU_TOP_S);
    this.trueBottom = lag(this.trueBottom, this.bottomTarget(), TAU_BOTTOM_S);
    this.trueRef = lag(this.trueRef, this.trueBottom, REF_LAG_S);

    let drained = 0;
    if (this.valve === 'open') drained = Math.min(this.reservoir, VALVE_DRAIN_RAW_PER_S * h);
    this.reservoir -= drained;
    this.trayWater += drained;
    if (this.remoteLeak) this.reservoir = Math.max(0, this.reservoir - REMOTE_LEAK_RAW_PER_S * h);
  }

  private measure(beam: Beam, atT: number): void {
    const r = this.beams[beam];
    r.lastRefreshT = atT;
    if (beam === 'outlet' && this.outletBlocked) {
      r.echo = r1(echoUs(this.trueOutlet, OBSTRUCTED_PATH_M) + this.gauss() * 2);
      r.value = null; // firmware refuses to turn an impossible echo into a temperature
      return;
    }
    const truth = beam === 'inlet_top' ? this.trueTop : beam === 'inlet_bottom' ? this.trueBottom : this.trueOutlet;
    const bias = beam === 'inlet_top' && this.faultTop ? FAULT_BIAS_C : 0;
    const echo = r1(echoUs(truth + bias + this.gauss() * BEAM_NOISE_C));
    r.echo = echo;
    r.value = r2(tempFromEcho(echo));
  }

  private readReservoir(): number {
    return Math.max(0, Math.min(1023, Math.round(this.reservoir + this.gauss() * 1.5)));
  }
  private readFloor(): number {
    const covered = Math.max(0, this.trayWater - FLOOR_DEAD_WATER);
    const raw = covered > 0 ? Math.min(700, covered * FLOOR_GAIN) + this.gauss() : Math.abs(this.gauss()) * 0.6;
    return Math.max(0, Math.min(1023, Math.round(raw)));
  }
  private readPack(): number {
    if (!this.powerOn) return r2(PACK_DEAD_V + this.gauss() * PACK_NOISE_V);
    const [a, b] = this.effectiveFans();
    const base = Math.max(PACK_MIN_V, PACK_FRESH_V - PACK_SAG_V_PER_S * this.t);
    const load = FAN_LOAD_SAG_V * ((a + b) / FAN_MAX_PCT);
    return r2(base - load + this.gauss() * PACK_NOISE_V);
  }

  private setFlap(state: 'open' | 'closed'): void {
    if (this.flap === state) return;
    this.flap = state;
    if (state === 'closed') this.flapClosedSinceT = this.t;
  }

  // ---------------------------------------------------------------- firmware behaviour
  private flagsNow(): string[] {
    const flags: string[] = [];
    if (this.outletBlocked) flags.push('outlet_obstructed');
    for (const b of BEAM_ORDER) {
      const e = this.beams[b].echo;
      if (e !== null && e < FW_OBSTRUCTED_ECHO_US && !flags.includes(`${b}_obstructed`)) flags.push(`${b}_obstructed`);
    }
    const ref = this.refReading();
    const top = this.beams.inlet_top.value;
    const bottom = this.beams.inlet_bottom.value;
    const disagree: Beam[] = [];
    if (bottom !== null && Math.abs(bottom - ref) > FW_REF_DISAGREE_C) disagree.push('inlet_bottom');
    // With the flap shut and settled the front chamber is well mixed, so inlet_top must agree too.
    if (
      top !== null &&
      this.flap === 'closed' &&
      this.t - this.flapClosedSinceT >= FW_TOP_CHECK_SETTLE_S &&
      Math.abs(top - ref) > FW_REF_DISAGREE_C
    ) {
      disagree.push('inlet_top');
    }
    if (disagree.length) {
      flags.push('ref_disagree');
      for (const b of disagree) flags.push(`${b}_ref_disagree`);
    }
    return flags;
  }

  private refValue = SIM_ROOM_C;
  private refReading(): number {
    return this.refValue;
  }

  private runSafetyFixes(flags: string[]): void {
    if (!this.auto || !this.powerOn) return;
    const top = this.beams.inlet_top.value;
    const bottom = this.beams.inlet_bottom.value;
    const untrusted = (b: Beam) => flags.some((f) => f.startsWith(`${b}_`));
    if (
      this.flap === 'open' &&
      top !== null &&
      bottom !== null &&
      !untrusted('inlet_top') &&
      !untrusted('inlet_bottom') &&
      top - bottom >= FW_RECIRC_SPREAD_C
    ) {
      this.setFlap('closed');
      this.pendingEvent = 'flap_closed';
    }
    const past = this.reservoirHistory.find((h) => h.t >= this.t - FW_RESERVOIR_DROP_WINDOW_S - 1e-9);
    const dropping = past !== undefined && past.raw - this.lastReservoirRaw >= FW_RESERVOIR_DROP_RAW;
    if (this.valve === 'open' && dropping && this.lastFloorRaw >= FW_FLOOR_WET_RAW) {
      this.valve = 'closed';
      this.pendingEvent = 'valve_closed';
    }
  }

  /** Advance the simulation by `dtS` seconds and return the frame the firmware would print now. */
  tick(dtS: number): RigFrame {
    let remaining = Math.max(0, dtS);
    const slot = BEAM_CYCLE_S / BEAM_ORDER.length;
    while (remaining > 1e-9) {
      const h = Math.min(0.25, remaining, Math.max(1e-6, this.nextRefreshT - this.t));
      this.step(h);
      remaining -= h;
      while (this.nextRefreshT <= this.t + 1e-9) {
        this.measure(BEAM_ORDER[this.nextBeam], this.nextRefreshT);
        this.nextBeam = (this.nextBeam + 1) % BEAM_ORDER.length;
        this.nextRefreshT += slot;
      }
    }
    this.refValue = Math.round((this.trueRef + this.gauss() * REF_NOISE_C) / REF_STEP_C) * REF_STEP_C;
    this.lastReservoirRaw = this.readReservoir();
    this.lastFloorRaw = this.readFloor();
    this.reservoirHistory.push({ t: this.t, raw: this.lastReservoirRaw });
    while (this.reservoirHistory.length > 0 && this.reservoirHistory[0].t < this.t - 30) this.reservoirHistory.shift();

    let flags = this.flagsNow();
    this.runSafetyFixes(flags);
    flags = this.flagsNow();
    const event = this.pendingEvent;
    this.pendingEvent = null;

    const age = (b: Beam) => r1(Math.max(0, this.t - this.beams[b].lastRefreshT));
    const frame: RigFrame = {
      v: 1,
      dev: SIM_DEVICE_ID,
      fw: SIM_FIRMWARE,
      seq: this.seq,
      up_ms: Math.round(this.t * 1000),
      inlet_top_c: this.beams.inlet_top.value,
      inlet_bottom_c: this.beams.inlet_bottom.value,
      outlet_c: this.beams.outlet.value,
      echo_us: {
        inlet_top: this.beams.inlet_top.echo,
        inlet_bottom: this.beams.inlet_bottom.echo,
        outlet: this.beams.outlet.echo,
      },
      beam_age_s: { inlet_top: age('inlet_top'), inlet_bottom: age('inlet_bottom'), outlet: age('outlet') },
      ref_c: this.refValue,
      reservoir_raw: this.lastReservoirRaw,
      floor_raw: this.lastFloorRaw,
      pack_v: this.readPack(),
      flap: this.flap,
      valve: this.valve,
      fan_pct: this.powerOn ? [this.fanCmd[0], this.fanCmd[1]] : [0, 0],
      auto: this.auto,
      flags,
      event,
    };
    this.seq = (this.seq + 1) % 2 ** 31;
    return frame;
  }

  /** Handle one command line (`RigCommand` or `SimCommand`, case-insensitive) and return the reply. */
  command(line: string): string {
    const cmd = line.trim().toLowerCase().replace(/\s+/g, ' ');
    const servo = (what: 'flap' | 'valve', state: 'open' | 'closed', word: string): string => {
      if (!this.powerOn) return `err no power: ${what} not moved`;
      if (what === 'flap') this.setFlap(state);
      else this.valve = state;
      return `ok ${what} ${word}`;
    };
    switch (cmd) {
      case 'flap open': return servo('flap', 'open', 'open');
      case 'flap close': return servo('flap', 'closed', 'close');
      case 'valve open': return servo('valve', 'open', 'open');
      case 'valve close': return servo('valve', 'closed', 'close');
      case 'auto on': this.auto = true; return 'ok auto on';
      case 'auto off': this.auto = false; return 'ok auto off';
      case 'cal': return `ok cal d=${BEAM_PATH_M.toFixed(3)},${BEAM_PATH_M.toFixed(3)},${BEAM_PATH_M.toFixed(3)}`;
      case 'ping': return 'pong';
      case 'sim power off': this.powerOn = false; return 'ok sim power off';
      case 'sim power on': this.powerOn = true; return 'ok sim power on';
      case 'sim fault inlet_top': this.faultTop = true; return 'ok sim fault inlet_top';
      case 'sim fault clear': this.faultTop = false; return 'ok sim fault clear';
      case 'sim heat high': this.heatHigh = true; return 'ok sim heat high';
      case 'sim heat normal': this.heatHigh = false; return 'ok sim heat normal';
      case 'sim fan_a fail': this.fanAFailed = true; return 'ok sim fan_a fail';
      case 'sim fan_a ok': this.fanAFailed = false; return 'ok sim fan_a ok';
      case 'sim block outlet': this.outletBlocked = true; return 'ok sim block outlet';
      case 'sim unblock': this.outletBlocked = false; return 'ok sim unblock';
      case 'sim supply loss': this.supplyLoss = true; return 'ok sim supply loss';
      case 'sim supply ok': this.supplyLoss = false; return 'ok sim supply ok';
      case 'sim leak remote': this.remoteLeak = true; return 'ok sim leak remote';
      case 'sim leak stop': this.remoteLeak = false; return 'ok sim leak stop';
      case 'sim spill': this.trayWater += SPILL_WATER; return 'ok sim spill';
      case 'sim dry': this.trayWater = 0; return 'ok sim dry';
    }
    const fan = /^fan (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)$/.exec(cmd);
    if (fan) {
      const clampPct = (x: number) => Math.round(Math.min(FAN_MAX_PCT, Math.max(0, x)));
      this.fanCmd = [clampPct(Number(fan[1])), clampPct(Number(fan[2]))];
      return `ok fan ${this.fanCmd[0]} ${this.fanCmd[1]}`;
    }
    return `err unknown command: ${line.trim()}`;
  }
}
