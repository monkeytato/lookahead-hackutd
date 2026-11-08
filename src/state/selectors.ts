import { facility, CHECKIN_STALE_MIN } from '../domain/fixture';
import type { Asset, AssetVisualState, Employee, ID, ImpactClock, Incident, Reading, Scenario } from '../domain/types';
import { severityFor, type ScenarioRun } from '../domain/engine';

export const assetById = new Map<ID, Asset>(facility.assets.map((a) => [a.id, a]));
export const zoneById = new Map(facility.zones.map((z) => [z.id, z]));
export const waypointById = new Map(facility.waypoints.map((w) => [w.id, w]));
export const serviceById = new Map(facility.services.map((s) => [s.id, s]));

export const assetName = (id: ID) => assetById.get(id)?.name ?? id;

/**
 * When the root fault of a clock became observable. A clock must not appear before anyone
 * could have known (no prophetic countdowns): the first non-fault step for that asset, else the fault.
 */
export function detectedAt(scenario: Scenario, assetId: ID): number {
  const obs = scenario.steps.filter((s) => s.assetId === assetId && s.kind !== 'fault').map((s) => s.t);
  if (obs.length) return Math.min(...obs);
  const f = scenario.faults.find((x) => x.assetId === assetId);
  return f ? f.t : Infinity;
}

/** Clocks visible at time t: root fault detected, node not yet long-lost. */
export function visibleClocks(clocks: Record<ID, ImpactClock>, scenario: Scenario, t: number): ImpactClock[] {
  return Object.values(clocks)
    .filter((c) => c.path.length > 1 && detectedAt(scenario, c.path[0]) <= t)
    .sort((a, b) => (a.p50 ?? 1e9) - (b.p50 ?? 1e9));
}

export function clocksForIncident(inc: Incident, clocks: ImpactClock[]): ImpactClock[] {
  // the incident must be a CAUSE on the path (anywhere but the impacted end), not merely a victim
  const roots = new Set([inc.rootAssetId, ...inc.alertAssetIds]);
  return clocks.filter((c) => c.path.slice(0, -1).some((p) => roots.has(p)));
}

export interface ClockGroup { key: string; label: string; detail: string; clock: ImpactClock; count: number; assetIds: ID[] }

/** Fold rack clocks by row so the overview shows a handful of clocks, not 48. */
export function groupClocks(clocks: ImpactClock[], t: number): ClockGroup[] {
  const groups = new Map<string, ClockGroup>();
  for (const c of clocks) {
    if (c.p50 != null && c.p50 < t - 5) continue; // long gone: it's history now, not a clock
    const a = assetById.get(c.assetId);
    if (!a) continue;
    const key = a.type === 'rack' ? `row-${a.location.row}` : a.id;
    const label = a.type === 'rack' ? `Row ${a.location.row} racks` : a.id;
    const via = c.path.length > 1 ? assetById.get(c.path[c.path.length - 2])?.id : undefined;
    const detail = a.type === 'rack' ? `lost via ${via ?? '—'}` : `${a.name}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { key, label, detail, clock: c, count: 1, assetIds: [c.assetId] });
    else { g.count++; g.assetIds.push(c.assetId); if ((c.p50 ?? 1e9) < (g.clock.p50 ?? 1e9)) g.clock = c; }
  }
  return [...groups.values()].sort((a, b) => (a.clock.p50 ?? 1e9) - (b.clock.p50 ?? 1e9));
}

export function latestFor(readings: Reading[], assetId: ID, metric?: Reading['metric'], source?: Reading['source']): Reading | undefined {
  let best: Reading | undefined;
  for (const r of readings) {
    if (r.assetId !== assetId) continue;
    if (metric && r.metric !== metric) continue;
    if (source && r.source !== source) continue;
    if (!best || r.t >= best.t) best = r;
  }
  return best;
}

export function checkinState(e: Employee, now: number): 'none' | 'fresh' | 'stale' {
  if (!e.location) return 'none';
  return now - e.location.t > CHECKIN_STALE_MIN ? 'stale' : 'fresh';
}

const SEV_RANK: Record<AssetVisualState['severity'], number> = { normal: 0, advisory: 1, warning: 2, critical: 3 };

/**
 * What an operator could honestly be shown at time `t` while previewing `viewT`:
 * - clocks only after their root fault is observable (no prophetic countdowns)
 * - racks that are merely downstream of a clock paint their strip but stay label-free
 */
export function honestVisual(run: ScenarioRun, scenario: Scenario, t: number, viewT: number, forecast?: ScenarioRun): Record<ID, AssetVisualState> {
  if (forecast) return forecastVisual(run, forecast, scenario, t);
  const raw = run.visualAt(viewT);
  const readings = run.readingsAt(viewT);
  const readingSev = new Map<ID, AssetVisualState['severity']>();
  for (const r of readings) {
    if (r.source === 'reference_probe') continue;
    const s = severityFor(r.metric, r.value, facility.thresholds);
    if (SEV_RANK[s] > SEV_RANK[readingSev.get(r.assetId) ?? 'normal']) readingSev.set(r.assetId, s);
  }
  const instrumented = new Set(readings.filter((r) => r.source !== 'reference_probe').map((r) => r.assetId));
  const out: Record<ID, AssetVisualState> = {};
  for (const [id, v0] of Object.entries(raw)) {
    // no telemetry stream is expected from this asset: "no sensor", not "stale"
    const v = instrumented.has(id) ? v0 : { ...v0, freshness: 'fresh' as const };
    const clock = run.clocks[id];
    const rs = readingSev.get(id) ?? 'normal';
    const visible = !!clock && clock.path.length > 1 && detectedAt(scenario, clock.path[0]) <= t;
    const lost = !!clock && clock.p50 != null && clock.p50 <= viewT && visible;
    if (!clock || !visible) {
      out[id] = { ...v, severity: rs, clockMin: undefined, wet: v.wet && detectedAt(scenario, 'PIPE-L2') <= t };
      continue;
    }
    // clock-only state paints the object; only imminent (critical) or reading-backed state gets a label
    const isRack = assetById.get(id)?.type === 'rack';
    out[id] = { ...v, quiet: !lost && rs === 'normal' && (isRack || v.severity !== 'critical') };
  }
  return out;
}

const maxSev = (a: AssetVisualState['severity'], b: AssetVisualState['severity']) => (SEV_RANK[b] > SEV_RANK[a] ? b : a);

/**
 * Live views (audit C1): what is true now comes from the WORLD run at t; anything predicted comes
 * from the FORECAST run (only faults observed or inferable by t).
 * - severity = readings, plus critical for an observable failure, plus the forecast clock's urgency
 *   (≤ 10 min critical, ≤ 30 warning, else advisory); the script's own clocks never colour anything
 * - `lost` only once the failure's root cause is observable (or the forecast itself has it lost);
 *   `wet` only once the forecast knows about the water; `lost` is always set so the twin does not
 *   fill it back in from a run's clocks
 * - racks merely downstream of a forecast clock paint their strip but stay label-free (quiet)
 */
function forecastVisual(world: ScenarioRun, forecast: ScenarioRun, scenario: Scenario, t: number): Record<ID, AssetVisualState> {
  const raw = world.visualAt(t);
  const readings = world.readingsAt(t);
  const readingSev = new Map<ID, AssetVisualState['severity']>();
  for (const r of readings) {
    if (r.source === 'reference_probe') continue;
    readingSev.set(r.assetId, maxSev(readingSev.get(r.assetId) ?? 'normal', severityFor(r.metric, r.value, facility.thresholds)));
  }
  const instrumented = new Set(readings.filter((r) => r.source !== 'reference_probe').map((r) => r.assetId));
  const out: Record<ID, AssetVisualState> = {};
  for (const [id, v0] of Object.entries(raw)) {
    const v = instrumented.has(id) ? v0 : { ...v0, freshness: 'fresh' as const };
    const rs = readingSev.get(id) ?? 'normal';
    const restored = !!v.restored;
    const wc = world.clocks[id];
    const fc = forecast.clocks[id];
    const worldLostSeen = !!v.lost && !!wc && detectedAt(scenario, wc.path[0]) <= t;
    const forecastLost = !!fc && fc.p50 != null && fc.p50 <= t && !(fc.recoveredP50 != null && fc.recoveredP50 <= t);
    const lost = !restored && (worldLostSeen || forecastLost);
    let severity = lost ? maxSev(rs, 'critical') : rs;
    let clockMin: number | undefined;
    if (fc && !lost && !restored) {
      let cs: AssetVisualState['severity'] = 'advisory';
      if (fc.p50 != null) {
        const left = fc.p50 - t;
        if (left <= 10) cs = 'critical';
        else if (left <= 30) cs = 'warning';
        if (left > 0) clockMin = Math.round(left * 10) / 10;
      }
      severity = maxSev(severity, cs);
    }
    const wet = !!v.wet && forecast.waterArrival[id] !== undefined;
    const state: AssetVisualState = { ...v, severity, clockMin, lost, wet };
    if (fc) state.quiet = !lost && rs === 'normal' && (assetById.get(id)?.type === 'rack' || severity !== 'critical');
    out[id] = state;
  }
  return out;
}

export const ROLE_LABEL: Record<Employee['role'], string> = { supervisor: 'Supervisor', engineer: 'Engineer', technician: 'Technician', shift_lead: 'Shift lead' };

export const METRIC_LABEL: Record<Reading['metric'], string> = {
  inlet_temp_c: 'Inlet temperature', humidity_rh: 'Relative humidity', dew_point_c: 'Dew point', vibration_mm_s: 'Vibration (RMS velocity)',
  leak: 'Liquid presence', ups_autonomy_min: 'UPS autonomy', load_kw: 'Load', flow_lpm: 'Make-up flow', pressure_kpa: 'Loop pressure',
  battery_temp_c: 'Battery temperature', supply_temp_c: 'Supply water temperature',
};
