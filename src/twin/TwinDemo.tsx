/**
 * Isolated twin lab (#/twin-lab): mock visual state + synthetic leak so the viewport can be
 * checked without the engine. Everything here is fake demo data.
 */
import { useMemo, useState } from 'react';
import type { AssetVisualState, WaterGrid, WaterFrame } from '../domain/types';
import { facility, employees, GPU_RACKS, SCENARIO_WALL_START } from '../domain/fixture';
import { Twin, type TwinLayers } from './Twin';
import '../styles/tokens.css';
import './twin.css';

const LEAK = { x: 33.2, z: 9.6, startT: 4 };

/** Synthetic water spread: anisotropic blob channelled along the corridor, drifting toward the battery room. */
function synthWater(): WaterGrid {
  const cellM = 0.5, origin = { x: 24, z: -1 };
  const cols = 40, rows = 52;
  const elevOf = (x: number, z: number) => {
    for (const zn of facility.zones) {
      const r = zn.rect;
      if (x >= r.x && x < r.x + r.w && z >= r.z && z < r.z + r.d) return zn.elevation;
    }
    return 0.1; // outside the building: dry
  };
  const frames: WaterFrame[] = [];
  for (let t = 0; t <= 60; t++) {
    const depthMm = new Float32Array(cols * rows);
    const s = t - LEAK.startT;
    if (s > 0) {
      const k = Math.min(1, s / 56);
      const cx = LEAK.x + (36 - LEAK.x) * 0.55 * k, cz = LEAK.z + (15.5 - LEAK.z) * 0.6 * k;
      const R = 1.2 + 1.35 * Math.sqrt(s);
      const peak = Math.min(16, 2.5 + s * 0.22);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = origin.x + (c + 0.5) * cellM, z = origin.z + (r + 0.5) * cellM;
          const e = elevOf(x, z);
          if (e > 0.05) continue;
          const inCorr = x >= 32 && x < 34;
          const ax = inCorr ? 1 : x < 32 ? 2.6 : 1.25; // hall raised 2 cm resists, rooms slope away
          const dx = (x - cx) * ax, dz = (z - cz) * (inCorr ? 0.7 : 1);
          const ang = Math.atan2(dz, dx);
          const wobble = 1 + 0.1 * Math.sin(ang * 3 + s * 0.07) + 0.06 * Math.sin(ang * 7 + 1.3);
          const q = Math.hypot(dx, dz) / (R * wobble);
          if (q >= 1) continue;
          const lowBonus = Math.max(0, -e) * 120; // battery room is 5 cm lower
          depthMm[r * cols + c] = Math.max(0, peak * (1 - q * q) + lowBonus * (1 - q));
        }
      }
    }
    frames.push({ t, depthMm });
  }
  return { cols, rows, cellM, origin, frames };
}

const hash = (s: string) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return ((h >>> 0) % 1000) / 1000; };

function mockVisual(t: number): Record<string, AssetVisualState> {
  const v: Record<string, AssetVisualState> = {};
  for (const a of facility.assets) {
    v[a.id] = { severity: 'normal', freshness: 'fresh', heat: a.type === 'rack' ? 0.32 + hash(a.id) * 0.16 + (GPU_RACKS.includes(a.id) ? 0.1 : 0) : 0.4 };
  }
  // disputed single-sensor alarm
  v['A-11'] = { ...v['A-11'], severity: 'critical', heat: 0.93 };
  // row C sensors stale
  for (let i = 6; i <= 12; i++) v[`C-${String(i).padStart(2, '0')}`].freshness = 'stale';
  // CRAH-2 vibration; trips at 34 and rows C/D west warm up
  v['CRAH-2'] = { ...v['CRAH-2'], severity: t >= 34 ? 'critical' : 'warning', clockMin: t < 34 ? 34 - t : undefined };
  if (t >= 34) {
    const k = Math.min(1, (t - 34) / 22);
    for (const row of ['C', 'D']) for (let i = 1; i <= 7; i++) {
      const id = `${row}-${String(i).padStart(2, '0')}`;
      v[id].heat = Math.min(1, v[id].heat + k * (0.55 - i * 0.04));
    }
    if (k > 0.5) v['D-03'] = { ...v['D-03'], severity: 'warning', clockMin: Math.max(0, 60 - t) };
  }
  v['D-10'] = { ...v['D-10'], severity: 'advisory' };
  // leak chain
  if (t >= 11) v['PIPE-L2'] = { ...v['PIPE-L2'], severity: t >= 20 ? 'warning' : 'advisory' };
  if (t >= 18) v['BATT-B'] = { ...v['BATT-B'], severity: t >= 40 ? 'critical' : 'warning', clockMin: Math.max(0, 49 - t), wet: t >= 30 };
  return v;
}

const wall = (t: number) => {
  const m = SCENARIO_WALL_START.h * 60 + SCENARIO_WALL_START.m + t;
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export function TwinDemo() {
  const [t, setT] = useState(22);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resetViewKey, setResetViewKey] = useState(0);
  const [layers, setLayers] = useState<TwinLayers>({ heat: false, water: true, deps: true, people: true });
  const [showRoute, setShowRoute] = useState(true);

  const water = useMemo(synthWater, []);
  const visual = useMemo(() => mockVisual(t), [t]);
  const route = useMemo(() => ['C-4', 'C-3', 'B-1', 'B-2'].map((id) => facility.waypoints.find((w) => w.id === id)!), []);
  const highlightPath = useMemo(() => ['PIPE-L2', 'BATT-B', 'UPS-B', 'PDU-B2', 'D-05'], []);

  const sel = selectedId ? facility.assets.find((a) => a.id === selectedId) : undefined;

  return (
    <div className="twin-demo">
      <Twin
        facility={facility}
        visual={visual}
        water={water}
        t={t}
        now={t}
        selectedId={selectedId}
        onSelect={setSelectedId}
        employees={employees}
        route={showRoute ? route : undefined}
        highlightPath={highlightPath}
        layers={layers}
        resetViewKey={resetViewKey}
      />
      <section className="twin-demo__panel" aria-label="Twin lab controls">
        <header>
          <div className="twin-demo__eyebrow">Twin lab · simulated</div>
          <div className="twin-demo__title">{facility.site} — {facility.name}</div>
        </header>
        <label className="twin-demo__slider">
          <span>Scenario time <b className="mono">T+{t} min · {wall(t)}</b></span>
          <input type="range" min={0} max={60} step={1} value={t} onChange={(e) => setT(Number(e.target.value))} />
        </label>
        <fieldset>
          <legend>Layers</legend>
          {(Object.keys(layers) as (keyof TwinLayers)[]).map((k) => (
            <label key={k} className="twin-demo__check">
              <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers((l) => ({ ...l, [k]: e.target.checked }))} />
              {{ heat: 'Heat slice', water: 'Water', deps: 'Dependency path', people: 'People' }[k]}
            </label>
          ))}
          <label className="twin-demo__check">
            <input type="checkbox" checked={showRoute} onChange={(e) => setShowRoute(e.target.checked)} />
            Route (C-4 → B-2)
          </label>
        </fieldset>
        <div className="twin-demo__row">
          <button type="button" className="twin-demo__btn" onClick={() => setResetViewKey((k) => k + 1)}>Reset view</button>
          <span className="twin-demo__sel">{sel ? <><b className="mono">{sel.id}</b> {sel.name}</> : 'Nothing selected'}</span>
        </div>
      </section>
    </div>
  );
}

export default TwinDemo;
