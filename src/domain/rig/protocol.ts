/**
 * Rack Monitor ↔ Lookahead protocol (v2).
 *
 * Physical link: Arduino UNO R4 over USB serial, 115200 baud, one JSON object per line, ~1 Hz.
 * The firmware (hardware/rack_monitor) emits RigFrame lines and accepts RigCommand lines.
 * The bridge (server/) is the only process that touches the serial port; every app talks to
 * the bridge over HTTP + Server-Sent Events. A simulated rig emits byte-identical frames when
 * no device is attached, and every frame carries its `source` once the bridge stamps it.
 *
 * Sensors (final build, 4 sensors):
 *  - 1 × DS18B20 temperature probe at the rack's front inlet (D11).
 *  - 2 × HC-SR04 ultrasonic sensors, one aimed at each exhaust fan's mount, used for VIBRATION:
 *    the firmware pings each one ~16 times a second, tracks how much the distance to the mount
 *    wobbles, and reports displacement, dominant frequency and an indicative velocity.
 *  - 1 × water level sensor lying in the rack's drip tray, catching drips from the coolant line.
 * Not a sensor module, but still read: the 6×AA pack voltage through a 10k/10k divider (A2).
 *
 * v1 (three acoustic thermometry beams, reservoir + floor water sensors) is retired.
 */

export const PROTOCOL_VERSION = 2;
export const BAUD = 115200;

export type Fan = 'fan_a' | 'fan_b';
export const FANS: readonly Fan[] = ['fan_a', 'fan_b'];

/**
 * One ultrasonic vibration channel, computed by the firmware over its last ~64 pings (~3.8 s).
 * Null means "no trustworthy value", never zero.
 */
export interface VibChannel {
  /** Mean distance to the fan mount (mm). */
  dist_mm: number | null;
  /** RMS displacement around the mean, detrended (mm). */
  disp_mm: number | null;
  /** Peak-to-peak displacement (mm). */
  p2p_mm: number | null;
  /** Dominant wobble frequency from zero crossings (Hz); null below ~0.3 Hz or when flat. */
  freq_hz: number | null;
  /** Indicative RMS velocity, 2π·f·disp (mm/s). Not an ISO 10816 measurement. */
  vel_mm_s: number | null;
  /** Accepted pings in the window. */
  n: number;
}

/** One line from the firmware. Null means "no trustworthy value" — never zero. */
export interface RigFrame {
  v: 2;
  /** Device id baked into firmware, e.g. "RACKMON-01" */
  dev: string;
  fw: string;
  /** Monotonic frame counter (wraps at 2^31) */
  seq: number;
  /** Device uptime in ms */
  up_ms: number;
  /** DS18B20 at the front inlet (°C), 12-bit, read every 2 s. Null if missing or invalid. */
  temp_c: number | null;
  /** Ultrasonic vibration, one channel per exhaust fan. */
  vib: Record<Fan, VibChannel>;
  /** Drip-tray water sensor, raw ADC 0..1023 (10-bit). ~0 dry, rising as water covers the traces. */
  drip_raw: number;
  /** 6×AA pack voltage via 10k/10k divider on A2 (V = 2·V_A2). Null until a healthy pack is seen. */
  pack_v: number | null;
  flap: 'open' | 'closed';
  valve: 'open' | 'closed';
  /** Fan PWM percent, capped at 70 % in firmware (TT motors rated 3–6 V on a 9 V pack) */
  fan_pct: [number, number];
  /** Whether the on-device safety fixes are armed */
  auto: boolean;
  /** Firmware-side quality flags, e.g. "fan_a_timeout", "temp_missing", "pack_low" */
  flags: string[];
  /** Set on the frame in which the firmware took a safety action: "flap_closed" | "valve_closed" */
  event: string | null;
}

/** Lines the firmware accepts (newline-terminated, case-insensitive). */
export type RigCommand =
  | 'flap open' | 'flap close'
  | 'valve open' | 'valve close'
  | `fan ${number} ${number}`
  | 'auto on' | 'auto off'
  | 'cal'          // record each vibration sensor's baseline distance (fans running, rig still)
  | 'ping';

/** Bridge-only commands for the simulated rig (staging failures without hardware). */
export type SimCommand =
  | 'sim power off' | 'sim power on'
  | 'sim fault temp' | 'sim fault clear'
  | 'sim fan_a fail' | 'sim fan_a ok'
  | 'sim imbalance fan_a' | 'sim imbalance fan_b' | 'sim balance'
  | 'sim bump fan_b' | 'sim unbump'
  | 'sim supply loss' | 'sim supply ok'
  | 'sim block fan_a' | 'sim unblock'
  | 'sim spill' | 'sim dry';

/** Regex the bridge uses to accept sim commands (kept here so bridge, in-page bridge and UI agree). */
export const SIM_CMD_RE = /^sim (power (off|on)|fault (temp|clear)|fan_a (fail|ok)|imbalance (fan_a|fan_b)|balance|bump fan_b|unbump|supply (loss|ok)|block fan_a|unblock|spill|dry)$/;
/** Every sim command, for the Rig page's staging buttons. */
export const SIM_COMMANDS: readonly SimCommand[] = [
  'sim power off', 'sim power on', 'sim fault temp', 'sim fault clear', 'sim fan_a fail', 'sim fan_a ok',
  'sim imbalance fan_a', 'sim imbalance fan_b', 'sim balance', 'sim bump fan_b', 'sim unbump',
  'sim supply loss', 'sim supply ok', 'sim block fan_a', 'sim unblock', 'sim spill', 'sim dry',
];
/** Regex for real rig commands. */
export const RIG_CMD_RE = /^(flap (open|close)|valve (open|close)|fan \d{1,3} \d{1,3}|auto (on|off)|cal|ping)$/;

export type FrameSource = 'live' | 'simulated';

/** A frame as the bridge publishes it. */
export interface StampedFrame extends RigFrame {
  source: FrameSource;
  /** Bridge receive time (ISO) */
  at: string;
}

// ---------------------------------------------------------------- scans

/**
 * Hold-to-scan timing. The vibration window is ~3.8 s and the probe refreshes every 2 s.
 *  - MIN_HOLD_S: at least one full vibration window and two probe readings.
 *  - TARGET_HOLD_S: two windows, enough to estimate spread and a short slope.
 * Released before MIN → discarded. Reaching TARGET → completes automatically.
 */
export const MIN_HOLD_S = 5;
export const TARGET_HOLD_S = 10;

export type ScanChannel =
  | 'temp_c'
  | 'vib_a_mm_s' | 'vib_b_mm_s'   // indicative RMS velocity per fan channel
  | 'disp_a_mm' | 'disp_b_mm'     // RMS displacement per fan channel
  | 'drip_wet'                    // fraction of frames with drip_raw above the wet threshold (0..1)
  | 'pack_v';

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
  /** Dashboard asset id the rig was placed at (e.g. "A-11", "CRAH-2", "BATT-B") */
  assetId: string;
  /** Human measurement point, e.g. "Front inlet · temperature probe" */
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
  /** e.g. "unsettled_temp" (sd > 0.5 °C), "temp_missing", "vib_timeout_fan_a", "simulated_device" */
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

/** Root-cause events from the rig's own rule set (nine situations plus a catch-all). */
export type RigEventKind =
  | 'power_loss' | 'single_fan_failure' | 'fan_vibration' | 'recirculation'
  | 'cold_supply_loss' | 'coolant_leak_at_rack' | 'outside_water'
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
  /** Channel the event concerns, e.g. "fan_a" or "temp_c". Events dedupe on kind + channel. */
  channel?: string;
  /** Page severity when it differs from the default. */
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
