/**
 * Rack Monitor ↔ CenterGuard protocol (v1).
 *
 * Physical link: Arduino UNO R4 over USB serial, 115200 baud, one JSON object per line, ~1 Hz.
 * The firmware (hardware/rack_monitor) emits RigFrame lines and accepts RigCommand lines.
 * The bridge (server/) is the only process that touches the serial port; every app talks to
 * the bridge over HTTP + Server-Sent Events. A simulated rig emits byte-identical frames when
 * no device is attached, and every frame carries its `source` once the bridge stamps it.
 *
 * Wiring reference: "Rack Monitor — Wiring & Assembly" (Nov 7, 2026).
 */

export const PROTOCOL_VERSION = 1;
export const BAUD = 115200;

/** One line from the firmware. Null means "no trustworthy value" — never zero. */
export interface RigFrame {
  v: 1;
  /** Device id baked into firmware, e.g. "RACKMON-01" */
  dev: string;
  fw: string;
  /** Monotonic frame counter (wraps at 2^31) */
  seq: number;
  /** Device uptime in ms */
  up_ms: number;
  /** Acoustic air temperatures (°C), averaged along each beam. Null on echo timeout / untrusted. */
  inlet_top_c: number | null;
  inlet_bottom_c: number | null;
  outlet_c: number | null;
  /** Averaged echo times (µs) behind those temperatures; ~1040 µs at room temp over the 178 mm path */
  echo_us: { inlet_top: number | null; inlet_bottom: number | null; outlet: number | null };
  /** Seconds since each beam last produced a fresh average (beams take turns; full cycle ≈ 5 s) */
  beam_age_s: { inlet_top: number; inlet_bottom: number; outlet: number };
  /** DS18B20 reference probe (°C) next to the inlet-bottom beam. Null until fitted. */
  ref_c: number | null;
  /** Water sensors, raw ADC 0..1023 (10-bit). ~0 dry, rising with immersion depth. */
  reservoir_raw: number;
  floor_raw: number;
  /** 6×AA pack voltage via 10k/10k divider on A2 (V = 2·V_A2). Null until divider fitted. */
  pack_v: number | null;
  /** Optional digital vibration detector; qualitative only, never calibrated mm/s. */
  vibrating?: boolean | null;
  flap: 'open' | 'closed';
  valve: 'open' | 'closed';
  /** Fan PWM percent, capped at 70 % in firmware (TT motors rated 3–6 V on a 9 V pack) */
  fan_pct: [number, number];
  /** Whether the on-device safety fixes are armed */
  auto: boolean;
  /** Firmware-side quality flags, e.g. "inlet_top_timeout", "ref_missing", "ref_disagree" */
  flags: string[];
  /** Set on the frame in which the firmware took a safety action, e.g. "flap_closed", "valve_closed" */
  event: string | null;
}

/** Lines the firmware accepts (newline-terminated, case-insensitive). */
export type RigCommand =
  | 'flap open' | 'flap close'
  | 'valve open' | 'valve close'
  | `fan ${number} ${number}`
  | 'auto on' | 'auto off'
  | 'cal'          // re-derive beam path lengths from the reference probe
  | 'ping';

/** Bridge-only commands for the simulated rig (staging failures without hardware). */
export type SimCommand =
  | 'sim power off' | 'sim power on'
  | 'sim fault inlet_top' | 'sim fault clear'
  | 'sim heat high' | 'sim heat normal'
  | 'sim fan_a fail' | 'sim fan_a ok'
  | 'sim block outlet' | 'sim unblock';

export type FrameSource = 'live' | 'simulated';

/** A frame as the bridge publishes it. */
export interface StampedFrame extends RigFrame {
  source: FrameSource;
  /** Bridge receive time (ISO) */
  at: string;
}

// ---------------------------------------------------------------- scans

/**
 * Hold-to-scan timing. The three acoustic beams take turns and each averages ~25 pings, so one
 * full refresh of all three takes about 5 s (wiring doc, "Accuracy and timing").
 *  - MIN_HOLD_S = one full beam cycle: every channel has at least one fresh value.
 *  - TARGET_HOLD_S = two full cycles: enough to estimate spread and a short slope.
 * Released before MIN → discarded. Reaching TARGET → completes automatically.
 */
export const MIN_HOLD_S = 5;
export const TARGET_HOLD_S = 10;

export type ScanChannel =
  | 'inlet_top_c' | 'inlet_bottom_c' | 'outlet_c' | 'ref_c'
  | 'delta_t_c'      // outlet − mean(inlet top, inlet bottom)
  | 'reservoir_pct'  // reservoir_raw scaled 0–100 % of calibrated full
  | 'floor_wet'      // fraction of frames with floor_raw above the wet threshold (0..1)
  | 'pack_v'
  | 'vibration_detected';

export interface ChannelStats {
  n: number;
  mean: number;
  min: number;
  max: number;
  sd: number;
  /** Least-squares slope over the window, per minute */
  slopePerMin: number;
  unit: string;
}

export interface ScanPoint {
  /** Dashboard asset id the rig was placed at (e.g. "A-11", "BATT-B") */
  assetId: string;
  /** Human measurement point, e.g. "Front inlet, both beams" */
  point: string;
}

export interface Scan extends ScanPoint {
  id: string;
  deviceId: string;
  firmware: string;
  source: FrameSource;
  operator: string;
  startedAt: string;
  endedAt: string;
  durationS: number;
  frames: number;
  status: 'complete' | 'too_short' | 'no_data';
  channels: Partial<Record<ScanChannel, ChannelStats>>;
  /** e.g. "unsettled_inlet_top" (sd > 0.5 °C), "acoustic_ref_disagree" (> 2 °C), "beam_timeout_outlet", "simulated_device" */
  quality: string[];
  /** Optional link back to a dashboard scan request / task */
  requestId?: string;
}

/** A request from the dashboard (or the Nemotron director) for someone to scan a point. */
export interface ScanRequest extends ScanPoint {
  id: string;
  createdAt: string;
  requestedBy: string;
  reason: string;
  incidentId?: string;
  taskId?: string;
  status: 'open' | 'done' | 'cancelled';
  scanId?: string;
}

// ---------------------------------------------------------------- rig events

/** Root-cause events from the rig's own rule set (the ten situations in the wiring doc). */
export type RigEventKind =
  | 'power_loss' | 'single_fan_failure' | 'recirculation' | 'heat_load_spike'
  | 'cold_supply_loss' | 'coolant_leak_at_rack' | 'leak_elsewhere' | 'outside_water'
  | 'obstruction' | 'sensor_fault' | 'unclassified_anomaly';

export interface RigEvent {
  id: string;
  kind: RigEventKind;
  at: string;
  /** high | medium | low — from the rule, not a model */
  confidence: 'high' | 'medium' | 'low';
  rootCause: string;
  /** What the rig did or would do (flap/valve/fan), and whether it was confirmed */
  action: string | null;
  actionConfirmed: boolean | null;
  /** Minutes until the governing channel crosses its limit at the current slope; null if not rising */
  timeToLimitMin: number | null;
  /** Route the page: IT, facilities, or no page (bad data) */
  route: 'it' | 'facilities' | 'none';
  evidence: string[];
  source: FrameSource;
  /** (optional, added by rig/diagnose) Channel the event concerns, e.g. "outlet_c" for an
   *  obstruction or the untrusted channel of a sensor_fault. Events dedupe on kind + channel. */
  channel?: string;
  /** (optional, added by rig/diagnose) Page severity when it differs from the default, e.g.
   *  leak_elsewhere sends a lower-severity page ("low"). */
  severity?: 'high' | 'medium' | 'low';
}

export interface BridgeStatus {
  device: {
    mode: 'serial' | 'simulated' | 'disconnected';
    port: string | null;
    deviceId: string | null;
    firmware: string | null;
    lastFrameAt: string | null;
    framesReceived: number;
  };
  nemotron: { configured: boolean; model: string; baseUrl: string };
  scanning: { id: string; assetId: string; startedAt: string } | null;
}
