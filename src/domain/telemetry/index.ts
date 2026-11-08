/**
 * Monitor telemetry: the readings the dashboard watches, as dial gauges and trend series.
 *
 * CONTRACT (the telemetry agent implements; the monitor UI only calls these):
 *   monitorGauges(input)            → the 6–8 headline readings, each with units, normal band and alarm line
 *   gaugeSeries(input, gaugeId, o)  → solid "actual" history up to t, dotted "predicted" path after t
 *
 * Normal operation is not flat: readings drift and carry sensor noise (seeded, deterministic per
 * scenario and gauge), so a calm hall still looks alive. Abnormal values come only from the
 * scenario's faults/leaks/hazards via the engine run. Predictions come from the engine run
 * (what the model expects), never from the actual values after t.
 */
import type { ScenarioRun } from '../engine/simulate';
import type { Facility, ID, Metric, Scenario, Severity } from '../types';

export interface GaugeSpec {
  id: string;
  /** What we are monitoring, plain words: "Rack inlet temperature (hottest)" */
  label: string;
  /** Short label for a dial: "Inlet" */
  short: string;
  metric: Metric | 'delta_t_c' | 'it_load_kw' | 'pue';
  unit: string;            // "°C", "%RH", "mm/s", "min", "kW", "L/min"
  /** Assets this gauge aggregates (e.g. all racks → hottest) */
  assetIds: ID[];
  /** Dial range */
  min: number;
  max: number;
  /** Normal operating band (shaded) */
  normal: { lo: number; hi: number };
  /** Warning and alarm lines; dir says which side is bad */
  warn: number;
  alarm: number;
  dir: 'above' | 'below';
  /** Where the thresholds come from: "ASHRAE A1 …" */
  basis: string;
}

export interface Gauge extends GaugeSpec {
  value: number | null;
  severity: Severity;
  /** The asset responsible for the value (e.g. the hottest rack) */
  sourceAssetId: ID | null;
  /** Predicted value at t + lookahead (dotted), null if no prediction */
  predicted: number | null;
}

export interface SeriesPoint { t: number; v: number }
export interface GaugeSeries { actual: SeriesPoint[]; predicted: SeriesPoint[] }

export interface TelemetryInput { facility: Facility; scenario: Scenario; run: ScenarioRun; t: number; lookaheadMin?: number }

export const GAUGE_IDS = ['inlet', 'delta_t', 'humidity', 'vibration', 'ups', 'flow', 'leak', 'load'] as const;
export type GaugeId = (typeof GAUGE_IDS)[number];

/** Stub until the telemetry agent lands: static normal values so the UI can be built. */
export function monitorGauges(input: TelemetryInput): Gauge[] {
  void input;
  const g = (s: GaugeSpec, value: number): Gauge => ({ ...s, value, severity: 'normal', sourceAssetId: null, predicted: value });
  return [
    g({ id: 'inlet', label: 'Rack inlet temperature (hottest rack)', short: 'Inlet', metric: 'inlet_temp_c', unit: '°C', assetIds: [], min: 15, max: 40, normal: { lo: 18, hi: 27 }, warn: 27, alarm: 32, dir: 'above', basis: 'ASHRAE A1: recommended 18–27 °C, allowable 15–32 °C' }, 23.1),
    g({ id: 'delta_t', label: 'Hot-aisle rise (outlet − inlet)', short: 'ΔT', metric: 'delta_t_c', unit: '°C', assetIds: [], min: 0, max: 25, normal: { lo: 8, hi: 14 }, warn: 16, alarm: 20, dir: 'above', basis: 'Typical air-cooled IT ΔT 8–14 °C (assumption)' }, 11.2),
    g({ id: 'humidity', label: 'Hall relative humidity', short: 'Humidity', metric: 'humidity_rh', unit: '%RH', assetIds: [], min: 0, max: 100, normal: { lo: 20, hi: 60 }, warn: 60, alarm: 80, dir: 'above', basis: 'ASHRAE A1 allowable 8–80 % RH' }, 44),
    g({ id: 'vibration', label: 'CRAH fan vibration (worst unit)', short: 'Vibration', metric: 'vibration_mm_s', unit: 'mm/s', assetIds: [], min: 0, max: 10, normal: { lo: 0, hi: 2.8 }, warn: 2.8, alarm: 7.1, dir: 'above', basis: 'ISO 10816-1 class II' }, 1.4),
    g({ id: 'ups', label: 'UPS battery autonomy', short: 'UPS', metric: 'ups_autonomy_min', unit: 'min', assetIds: [], min: 0, max: 30, normal: { lo: 12, hi: 30 }, warn: 10, alarm: 5, dir: 'below', basis: 'Site policy' }, 22),
    g({ id: 'flow', label: 'Chilled-water make-up flow', short: 'Make-up', metric: 'flow_lpm', unit: 'L/min', assetIds: [], min: 0, max: 20, normal: { lo: 0, hi: 4 }, warn: 6, alarm: 10, dir: 'above', basis: 'Site baseline (assumption)' }, 2.1),
  ];
}

/** Stub: a flat line with gentle noise so the chart renders. */
export function gaugeSeries(input: TelemetryInput, gaugeId: string, o: { lookback?: number; lookahead?: number } = {}): GaugeSeries {
  const g = monitorGauges(input).find((x) => x.id === gaugeId);
  const base = g?.value ?? 0;
  const lb = o.lookback ?? 30, la = o.lookahead ?? 20;
  const actual: SeriesPoint[] = [];
  for (let k = Math.max(0, input.t - lb); k <= input.t; k += 0.5) actual.push({ t: k, v: base + Math.sin(k / 3) * 0.3 });
  const predicted: SeriesPoint[] = [{ t: input.t, v: actual.at(-1)?.v ?? base }, { t: input.t + la, v: base }];
  return { actual, predicted };
}
