/**
 * Scenario runner: combines the water layer, the cascade engine and the thermal model into one
 * replayable run that the views scrub through by scenario minute `t`.
 *
 * Pipeline:
 *  1. If the scenario has a leak, run the water layer once (deterministic) and find per-asset
 *     arrival times.
 *  2. Each wet asset becomes a fault at its arrival minute, and gets a derived `shares_space`
 *     edge from the leaking pipe (basisKind 'model') so the Why panel can show the path.
 *  3. Run the Monte Carlo cascade with scenario faults + extra faults + wet faults.
 *  4. Readings / visual state are computed lazily per `t` and memoized. Besides the contract's
 *     seed + step + thermal readings, fresh installed sensors emit a "heartbeat" (repeat of their
 *     last value) until their asset is lost — otherwise every sensor would look stale after ~10 min.
 */
import type {
  AssetVisualState, DependencyEdge, Facility, Freshness, ID, ImpactClock, Reading, Scenario, ScenarioStep, Severity, WaterGrid,
} from '../types';
import { runCascade } from './cascade';
import { freshness, latestReadings, maxSeverity, severityFor } from './readings';
import { inletTempAt } from './thermal';
import { simulateWater, waterArrival } from './water';

export interface ScenarioRunInput {
  facility: Facility;
  scenario: Scenario;
  seedReadings: Reading[];
  extraEdges?: DependencyEdge[];
  extraFaults?: { assetId: ID; t: number }[];
  /** Monte Carlo runs (default 400) and seed (default 7) */
  runs?: number;
  seed?: number;
}

export interface ScenarioRun {
  clocks: Record<ID, ImpactClock>;
  water?: WaterGrid;
  waterArrival: Record<ID, number>;
  derivedEdges: DependencyEdge[];
  /** Every reading observed at or before `t` (seed + scenario steps + synthesized thermal) */
  readingsAt(t: number): Reading[];
  visualAt(t: number): Record<ID, AssetVisualState>;
  stepsUntil(t: number): ScenarioStep[];
}

const UNITS: Partial<Record<Reading['metric'], string>> = {
  inlet_temp_c: '°C', supply_temp_c: '°C', battery_temp_c: '°C', dew_point_c: '°C', humidity_rh: '%',
  vibration_mm_s: 'mm/s', leak: 'wet', ups_autonomy_min: 'min', load_kw: 'kW', flow_lpm: 'L/min', pressure_kpa: 'kPa',
};
const INTERVAL: Partial<Record<Reading['metric'], number>> = { vibration_mm_s: 15 };
const FRESH_RANK: Record<Freshness, number> = { fresh: 0, stale: 1, missing: 2 };

export function simulateScenario(input: ScenarioRunInput): ScenarioRun {
  const { facility, scenario, seedReadings } = input;
  const horizon = scenario.horizonMin;

  // ---- 1–2. water layer → wet faults + derived edges
  let water: WaterGrid | undefined;
  let arrival: Record<ID, number> = {};
  const derivedEdges: DependencyEdge[] = [];
  const wetFaults: { assetId: ID; t: number }[] = [];
  if (scenario.leak) {
    const leak = scenario.leak;
    water = simulateWater(facility, leak, horizon);
    arrival = waterArrival(water, facility);
    // leaking pipe = nearest pipe asset to the leak point (falls back to a synthetic id)
    const pipes = facility.assets.filter((a) => a.type === 'pipe');
    pipes.sort((a, b) => Math.hypot(a.pos.x - leak.x, a.pos.z - leak.z) - Math.hypot(b.pos.x - leak.x, b.pos.z - leak.z));
    const sourceId = pipes[0]?.id ?? 'LEAK';
    wetFaults.push({ assetId: sourceId, t: leak.startT });
    for (const [assetId, t] of Object.entries(arrival)) {
      if (t > horizon) continue;
      wetFaults.push({ assetId, t });
      const d = Math.max(0, t - leak.startT);
      derivedEdges.push({
        id: `WET-${sourceId}-${assetId}`,
        from: sourceId,
        to: assetId,
        kind: 'shares_space',
        delay: { min: d, mode: d, max: d },
        basis: `Water-layer arrival at t=${t} min, approximation (height-field model, not CFD)`,
        basisKind: 'model',
        confirmed: true,
        revision: 1,
      });
    }
  }

  // ---- 3. cascade
  const faults = [...scenario.faults, ...(input.extraFaults ?? []), ...wetFaults];
  const clocks = runCascade(facility, faults, {
    horizonMin: horizon,
    runs: input.runs,
    seed: input.seed,
    extraEdges: [...(input.extraEdges ?? []), ...derivedEdges],
  });

  // ---- cooling-loss time per rack (p50 of its cooling sources, redundancy-aware)
  const allEdges = [...facility.edges.filter((e) => e.confirmed), ...(input.extraEdges ?? [])];
  const p50 = (id: ID) => clocks[id]?.p50 ?? Infinity;
  const racks = facility.assets.filter((a) => a.type === 'rack');
  const coolingLostAt = new Map<ID, number>();
  for (const r of racks) {
    const groups = new Map<string, number>();
    allEdges.forEach((e, i) => {
      if (e.to !== r.id || e.kind !== 'cools') return;
      const k = e.redundancyGroup ?? `#${i}`;
      groups.set(k, Math.max(groups.get(k) ?? -Infinity, p50(e.from)));
    });
    let lost = Infinity;
    for (const v of groups.values()) lost = Math.min(lost, v);
    if (lost < Infinity) coolingLostAt.set(r.id, lost);
  }
  // Thermal baseline = each rack's pre-scenario (t < 0) installed inlet value, else 22 °C.
  const baseInlet = new Map<ID, number>();
  for (const r of latestReadings(seedReadings.filter((x) => x.t < 0), 0, ['installed'])) {
    if (r.metric === 'inlet_temp_c') baseInlet.set(r.assetId, r.value);
  }

  // ---- scenario step readings
  let sid = 0;
  const stepReadings: Reading[] = scenario.steps
    .filter((s) => (s.kind === 'reading' || s.kind === 'alert') && s.metric && s.value !== undefined)
    .filter((s) => !seedReadings.some((r) => r.assetId === s.assetId && r.metric === s.metric && r.t === s.t && r.value === s.value))
    .map((s) => ({
      id: `SR-${scenario.id}-${++sid}`,
      assetId: s.assetId,
      metric: s.metric!,
      value: s.value!,
      unit: UNITS[s.metric!] ?? '',
      t: s.t,
      source: s.source ?? 'simulated',
      expectedIntervalMin: INTERVAL[s.metric!] ?? 5,
    }));

  const thermalReadings = (t: number): Reading[] => {
    const out: Reading[] = [];
    for (const r of racks) {
      const lost = coolingLostAt.get(r.id);
      if (lost === undefined || lost > t) continue;
      const base = baseInlet.get(r.id) ?? 22;
      const kw = r.loadKw ?? 6;
      for (let m = Math.ceil(lost); m <= Math.floor(t); m++) {
        out.push({
          id: `TH-${r.id}-${m}`, assetId: r.id, metric: 'inlet_temp_c',
          value: Math.round(inletTempAt(base, kw, lost, m) * 10) / 10,
          unit: '°C', t: m, source: 'simulated', expectedIntervalMin: 1,
        });
      }
    }
    return out;
  };

  // Telemetry heartbeat: an installed sensor that is fresh at t = 0 keeps reporting its last value
  // every expectedIntervalMin until its asset is modeled as lost (p50). Sensors already stale at
  // t = 0 (e.g. the deliberately stale row-C inlets) stay silent, so they remain stale.
  const heartbeatSources = latestReadings(seedReadings, 0, ['installed']).filter((r) => freshness(r, 0) === 'fresh' && r.expectedIntervalMin > 0);
  const heartbeat = (t: number): Reading[] => {
    const out: Reading[] = [];
    for (const r of heartbeatSources) {
      const stopAt = clocks[r.assetId]?.p50 ?? Infinity;
      for (let k = 1, ht = r.t + r.expectedIntervalMin; ht <= t && ht < stopAt; k++, ht = r.t + k * r.expectedIntervalMin) {
        out.push({ ...r, id: `HB-${r.id}-${k}`, t: ht });
      }
    }
    return out;
  };

  const readingsMemo = new Map<number, Reading[]>();
  const readingsAt = (t: number): Reading[] => {
    let v = readingsMemo.get(t);
    if (!v) {
      v = [...seedReadings, ...stepReadings].filter((r) => r.t <= t).concat(heartbeat(t), thermalReadings(t));
      readingsMemo.set(t, v);
    }
    return v;
  };

  const visualMemo = new Map<number, Record<ID, AssetVisualState>>();
  const visualAt = (t: number): Record<ID, AssetVisualState> => {
    const hit = visualMemo.get(t);
    if (hit) return hit;
    const latest = latestReadings(readingsAt(t), t);
    const byAsset = new Map<ID, Reading[]>();
    for (const r of latest) {
      if (!byAsset.has(r.assetId)) byAsset.set(r.assetId, []);
      byAsset.get(r.assetId)!.push(r);
    }
    const out: Record<ID, AssetVisualState> = {};
    for (const a of facility.assets) {
      const rs = byAsset.get(a.id) ?? [];
      const installed = rs.filter((r) => r.source === 'installed');
      let severity: Severity = 'normal';
      for (const r of installed) severity = maxSeverity(severity, severityFor(r.metric, r.value, facility.thresholds));

      const c = clocks[a.id];
      let clockMin: number | undefined;
      if (c) {
        let cs: Severity = 'advisory';
        if (c.p50 !== null) {
          const left = c.p50 - t;
          if (left <= 10) cs = 'critical';
          else if (left <= 30) cs = 'warning';
          if (left > 0) clockMin = Math.round(left * 10) / 10;
        }
        severity = maxSeverity(severity, cs);
      }

      let fr: Freshness = installed.length ? 'fresh' : 'missing';
      for (const r of installed) {
        const f = freshness(r, t);
        if (FRESH_RANK[f] > FRESH_RANK[fr]) fr = f;
      }

      // heat from the most recent inlet reading of any source (simulated thermal included)
      let inlet: Reading | undefined;
      for (const r of rs) if (r.metric === 'inlet_temp_c' && (!inlet || r.t > inlet.t || (r.t === inlet.t && r.source === 'simulated'))) inlet = r;
      const heat = inlet ? Math.min(1, Math.max(0, (inlet.value - 18) / 14)) : 0;

      const state: AssetVisualState = { severity, freshness: fr, heat };
      if (clockMin !== undefined) state.clockMin = clockMin;
      if (arrival[a.id] !== undefined && arrival[a.id] <= t) state.wet = true;
      out[a.id] = state;
    }
    visualMemo.set(t, out);
    return out;
  };

  const stepsUntil = (t: number) => scenario.steps.filter((s) => s.t <= t);

  return { clocks, water, waterArrival: arrival, derivedEdges, readingsAt, visualAt, stepsUntil };
}
