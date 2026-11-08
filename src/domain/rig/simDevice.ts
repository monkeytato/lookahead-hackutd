/**
 * SIMULATED Rack Monitor (protocol v2). Emits `RigFrame`s shaped exactly like the firmware's JSON
 * lines (the bridge stamps them `source: 'simulated'`) and answers the same command lines, so the
 * whole pipeline runs without hardware. The physics is deliberately simple and only plausible,
 * first-order lags toward targets. Every number here is a modelling assumption, not a measurement:
 *
 *  - Room / cold supply 22.5 °C. The DS18B20 sits at the front inlet. Laptop exhaust lifts the
 *    inlet by recirculation when the flap (blanking panel) is open: inlet moves toward the exhaust
 *    (~45 °C at full load scaled by airflow), 60 % of the way, τ = 25 s. With the flap shut only a
 *    trickle leaks back, so the inlet sits ~0.3 °C above supply.
 *  - Each exhaust fan has an HC-SR04 aimed at its mount. A healthy running fan wobbles the mount
 *    ~10 µm RMS at its shaft rate (~25 Hz for a TT motor at 70 %), i.e. ~1.6 mm/s indicative. A taped
 *    blade ("sim imbalance") raises that to ~30 µm (~4.7 mm/s, warn zone) and lowers the frequency a
 *    touch; a loose mount ("sim bump fan_b") reaches ~60 µm (~9 mm/s, alarm). A stopped fan reads
 *    ~2 µm with no frequency. All assumptions; the bench sets the real scale.
 *  - Valve open → coolant drips into the tray; the drip sensor starts rising after ~6 s of
 *    dripping (48 raw units of water to cover its traces), gaining 4 raw per unit of water.
 *  - The on-device safety fixes run here exactly as the firmware does them when `auto` is on:
 *    close the flap when the inlet climbs ≥ 1.5 °C above its calibrated baseline on 2 consecutive
 *    probe readings, close the valve when the tray is wet while the valve is open. The frame in
 *    which a fix happens carries `event`.
 *  - The servos and fans run off the 6×AA pack: with `sim power off` they stop (pack reads ~0.4 V),
 *    commands and safety fixes cannot move anything.
 *  - The DS18B20 refreshes every 2 s (12-bit, 0.0625 °C steps), σ = 0.06 °C, 8 s lag to the air.
 *
 * Deterministic for a given seed. Pure TypeScript: no timers, no I/O — the caller drives `tick`.
 */
import { mulberry32 } from '../engine/rng';
import { FANS, type Fan, type FrameSource, type RigFrame, type StampedFrame, type VibChannel } from './protocol';

// ---------------------------------------------------------------- simulation constants (assumed)
export const SIM_DEVICE_ID = 'RACKMON-SIM';
export const SIM_FIRMWARE = 'sim-2.0';
export const SIM_ROOM_C = 22.5;
const REF_NOISE_C = 0.06;
const REF_STEP_C = 0.0625;
const REF_PERIOD_S = 2;
const REF_LAG_S = 8;
const TAU_INLET_S = 25;
const TAU_EXHAUST_S = 20;
const HEAT_RISE_NORMAL_C = 8.5;
const HEAT_RISE_HIGH_C = 14.5;
const RECIRC_FLAP_OPEN = 0.6;
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
const VALVE_DRIP_WATER_PER_S = 8;
/** Water (units) that must collect in the tray before the drip sensor responds. */
const DRIP_DEAD_WATER = 48;
const DRIP_GAIN = 4;
const SPILL_WATER = 200;
const FAULT_BIAS_C = 4;
/** Vibration model (mm RMS displacement, Hz). Assumed; the bench sets the real numbers. */
const MOUNT_DIST_MM = 42;
const VIB_HEALTHY_MM = 0.01;
const VIB_IMBALANCE_MM = 0.03;
const VIB_LOOSE_MM = 0.06;
const VIB_STOPPED_MM = 0.002;
const VIB_FREQ_HZ = 25;
const VIB_NOISE_FRACTION = 0.12;
const VIB_WINDOW_S = 3.8;
/** Firmware safety-fix thresholds (mirrored by the diagnosis rules). */
const FW_RECIRC_DELTA_C = 1.5;
const FW_RECIRC_CONFIRM = 2;
const FW_DRIP_WET_RAW = 120;
/** Echo distance below this (mm) means something sits in front of the transducer. */
const FW_OBSTRUCTED_MM = 15;

/** Simulator-only commands beyond `SimCommand`, listed for the Rig page buttons. */
export const SIM_EXTRA_COMMANDS = [] as const;

/** Bridge-style stamp for simulator frames (tests and the bridge's simulated mode). */
export function stamp(frame: RigFrame, at: string, source: FrameSource = 'simulated'): StampedFrame {
  return { ...frame, source, at };
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export class SimRig {
  private readonly rand: () => number;
  private t = 0;
  private seq = 0;
  // physical state
  private supplyOffset = 0;
  private trueExhaust: number;
  private trueInlet: number;
  private trueProbe: number;
  private trayWater = 0;
  // actuators / modes
  private flap: 'open' | 'closed' = 'closed';
  private valve: 'open' | 'closed' = 'closed';
  private fanCmd: [number, number] = [FAN_MAX_PCT, FAN_MAX_PCT];
  private auto = true;
  // staged faults
  private powerOn = true;
  private faultTemp = false;
  private heatHigh = false;
  private fanAFailed = false;
  private imbalance: Fan | null = null;
  private bumpB = false;
  private supplyLoss = false;
  private obstructed: Fan | null = null;
  // firmware-side state
  private probeValue: number;
  private nextProbeT = REF_PERIOD_S;
  private baselineC: number;
  private recircHits = 0;
  private calibrated = true;
  private lastDripRaw = 0;
  private pendingEvent: string | null = null;
  private vib: Record<Fan, VibChannel>;

  constructor(seed = 1) {
    this.rand = mulberry32(seed);
    this.trueExhaust = this.exhaustTarget();
    this.trueInlet = this.inletTarget();
    this.trueProbe = this.trueInlet;
    this.probeValue = this.quantize(this.trueProbe);
    this.baselineC = this.probeValue;
    this.vib = { fan_a: this.measureVib('fan_a'), fan_b: this.measureVib('fan_b') };
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
  private exhaustTarget(): number {
    const rise = this.heatHigh ? HEAT_RISE_HIGH_C : HEAT_RISE_NORMAL_C;
    return this.supply() + rise / (0.35 + 0.65 * this.airflow());
  }
  private recircFraction(): number {
    return this.flap === 'open' ? RECIRC_FLAP_OPEN : 0.03 + 0.03 * (1 - this.airflow());
  }
  private inletTarget(): number {
    return this.supply() + this.recircFraction() * (this.trueExhaust - this.supply());
  }
  private quantize(c: number): number {
    return Math.round(c / REF_STEP_C) * REF_STEP_C;
  }

  private step(h: number): void {
    this.t += h;
    if (this.supplyLoss) this.supplyOffset = Math.min(SUPPLY_LOSS_MAX_C, this.supplyOffset + (SUPPLY_LOSS_RATE_C_PER_MIN / 60) * h);
    else this.supplyOffset = Math.max(0, this.supplyOffset - (SUPPLY_LOSS_RATE_C_PER_MIN / 60) * h);
    const lag = (x: number, target: number, tau: number) => x + (target - x) * (1 - Math.exp(-h / tau));
    this.trueExhaust = lag(this.trueExhaust, this.exhaustTarget(), TAU_EXHAUST_S);
    this.trueInlet = lag(this.trueInlet, this.inletTarget(), TAU_INLET_S);
    this.trueProbe = lag(this.trueProbe, this.trueInlet, REF_LAG_S);
    if (this.valve === 'open') this.trayWater += VALVE_DRIP_WATER_PER_S * h;
  }

  private measureVib(fan: Fan): VibChannel {
    const n = Math.round(VIB_WINDOW_S * 16);
    if (this.obstructed === fan) {
      return { dist_mm: r1(8 + this.gauss()), disp_mm: null, p2p_mm: null, freq_hz: null, vel_mm_s: null, n };
    }
    const [a, b] = this.effectiveFans();
    const pct = fan === 'fan_a' ? a : b;
    const running = pct > 0;
    let disp = VIB_STOPPED_MM;
    let freq: number | null = null;
    if (running) {
      const speed = pct / FAN_MAX_PCT;
      disp = VIB_HEALTHY_MM * speed;
      if (this.imbalance === fan) disp = VIB_IMBALANCE_MM * speed;
      if (fan === 'fan_b' && this.bumpB) disp = VIB_LOOSE_MM * speed;
      freq = VIB_FREQ_HZ * speed * (this.imbalance === fan || (fan === 'fan_b' && this.bumpB) ? 0.95 : 1);
    }
    disp = Math.max(0, disp * (1 + this.gauss() * VIB_NOISE_FRACTION));
    const vel = freq ? 2 * Math.PI * freq * disp : null;
    return {
      dist_mm: r1(MOUNT_DIST_MM + this.gauss() * 0.1),
      disp_mm: r3(disp),
      p2p_mm: r3(disp * 2.8),
      freq_hz: freq ? r1(freq + this.gauss() * 0.3) : null,
      vel_mm_s: vel ? r2(vel) : null,
      n,
    };
  }

  private readDrip(): number {
    const covered = Math.max(0, this.trayWater - DRIP_DEAD_WATER);
    const raw = covered > 0 ? Math.min(700, covered * DRIP_GAIN) + this.gauss() : Math.abs(this.gauss()) * 0.6;
    return Math.max(0, Math.min(1023, Math.round(raw)));
  }
  private readPack(): number {
    if (!this.powerOn) return r2(PACK_DEAD_V + this.gauss() * PACK_NOISE_V);
    const [a, b] = this.effectiveFans();
    const base = Math.max(PACK_MIN_V, PACK_FRESH_V - PACK_SAG_V_PER_S * this.t);
    const load = FAN_LOAD_SAG_V * ((a + b) / FAN_MAX_PCT);
    return r2(base - load + this.gauss() * PACK_NOISE_V);
  }

  // ---------------------------------------------------------------- firmware behaviour
  private flagsNow(): string[] {
    const flags: string[] = [];
    if (this.faultTemp) flags.push('temp_invalid');
    for (const fan of FANS) {
      const v = this.vib[fan];
      if (v.dist_mm !== null && v.dist_mm < FW_OBSTRUCTED_MM) flags.push(`${fan}_obstructed`);
    }
    if (!this.calibrated) flags.push('uncalibrated');
    if (!this.powerOn) flags.push('pack_low');
    return flags;
  }

  private runSafetyFixes(): void {
    if (!this.auto || !this.powerOn) return;
    if (this.flap === 'open' && !this.faultTemp && this.probeValue - this.baselineC >= FW_RECIRC_DELTA_C) {
      if (++this.recircHits >= FW_RECIRC_CONFIRM) {
        this.flap = 'closed';
        this.pendingEvent = 'flap_closed';
        this.recircHits = 0;
      }
    } else {
      this.recircHits = 0;
    }
    if (this.valve === 'open' && this.lastDripRaw >= FW_DRIP_WET_RAW) {
      this.valve = 'closed';
      this.pendingEvent = 'valve_closed';
    }
  }

  /** Advance the simulation by `dtS` seconds and return the frame the firmware would print now. */
  tick(dtS: number): RigFrame {
    let remaining = Math.max(0, dtS);
    while (remaining > 1e-9) {
      const h = Math.min(0.25, remaining, Math.max(1e-6, this.nextProbeT - this.t));
      this.step(h);
      remaining -= h;
      while (this.nextProbeT <= this.t + 1e-9) {
        const bias = this.faultTemp ? FAULT_BIAS_C : 0;
        this.probeValue = this.quantize(this.trueProbe + bias + this.gauss() * REF_NOISE_C);
        this.runSafetyFixes();
        this.nextProbeT += REF_PERIOD_S;
      }
    }
    this.vib = { fan_a: this.measureVib('fan_a'), fan_b: this.measureVib('fan_b') };
    this.lastDripRaw = this.readDrip();
    this.runSafetyFixes();
    const flags = this.flagsNow();
    const event = this.pendingEvent;
    this.pendingEvent = null;

    const frame: RigFrame = {
      v: 2,
      dev: SIM_DEVICE_ID,
      fw: SIM_FIRMWARE,
      seq: this.seq,
      up_ms: Math.round(this.t * 1000),
      temp_c: Math.round(this.probeValue * 10000) / 10000,
      vib: { fan_a: { ...this.vib.fan_a }, fan_b: { ...this.vib.fan_b } },
      drip_raw: this.lastDripRaw,
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
      if (what === 'flap') this.flap = state;
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
      case 'cal': this.baselineC = this.probeValue; this.calibrated = true; return `ok cal baseline=${this.baselineC.toFixed(2)}`;
      case 'ping': return 'pong';
      case 'sim power off': this.powerOn = false; return 'ok sim power off';
      case 'sim power on': this.powerOn = true; return 'ok sim power on';
      case 'sim fault temp': this.faultTemp = true; return 'ok sim fault temp';
      case 'sim fault clear': this.faultTemp = false; return 'ok sim fault clear';
      case 'sim fan_a fail': this.fanAFailed = true; return 'ok sim fan_a fail';
      case 'sim fan_a ok': this.fanAFailed = false; return 'ok sim fan_a ok';
      case 'sim imbalance fan_a': this.imbalance = 'fan_a'; return 'ok sim imbalance fan_a';
      case 'sim imbalance fan_b': this.imbalance = 'fan_b'; return 'ok sim imbalance fan_b';
      case 'sim balance': this.imbalance = null; this.bumpB = false; return 'ok sim balance';
      case 'sim bump fan_b': this.bumpB = true; return 'ok sim bump fan_b';
      case 'sim unbump': this.bumpB = false; return 'ok sim unbump';
      case 'sim supply loss': this.supplyLoss = true; return 'ok sim supply loss';
      case 'sim supply ok': this.supplyLoss = false; return 'ok sim supply ok';
      case 'sim spill': this.trayWater += SPILL_WATER; return 'ok sim spill';
      case 'sim dry': this.trayWater = 0; return 'ok sim dry';
      case 'sim block fan_a': this.obstructed = 'fan_a'; return 'ok sim block fan_a';
      case 'sim unblock': this.obstructed = null; return 'ok sim unblock';
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
