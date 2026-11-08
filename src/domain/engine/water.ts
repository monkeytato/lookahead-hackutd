/**
 * Water layer: height-field diffusion on a regular grid (default 0.5 m cells).
 *
 * APPROXIMATION, not a fluid solver. Each cell has a ground height (its zone's `elevation`, +5 cm
 * where an equipment plinth stands) and a water depth. Every substep each wet cell passes water to
 * lower neighbours in proportion to the surface difference (surface = ground + depth), with a
 * per-step flow cap and a small retained film (surface tension / floor roughness). Transfers are
 * scaled so a cell never gives more than it holds, so the scheme is mass-conserving apart from the
 * leak source (adds) and drains (remove 30 % of local depth per minute).
 *
 * Cells outside every zone are walls. Zones that touch share an open boundary (door thresholds are
 * represented only by the zones' elevation differences).
 *
 * Frame `t` values are SCENARIO minutes (frames start at t = 0, the leak starts at `leak.startT`),
 * so `waterArrival` times can be used directly as fault times.
 */
import type { Facility, ID, Scenario, WaterGrid } from '../types';

type Leak = NonNullable<Scenario['leak']>;

export interface WaterTuning {
  cellM: number;
  /** substeps per simulated minute */
  substepsPerMin: number;
  /** fraction of the surface difference moved per substep per neighbour (≤ 0.25 for stability) */
  alpha: number;
  /** max transfer per neighbour per substep, mm */
  capMm: number;
  /** film each cell keeps before it passes water on, mm */
  retainMm: number;
}

/**
 * Tuned on the fixture riser leak (38 L/min at (33.2, 9.6)): UPS-B wet ≈ 8 min, BATT-A ≈ 14,
 * UPS-A ≈ 22, ATS-1 ≈ 26, BATT-B ≈ 36 (scenario minutes); the +2 cm hall stays dry. The 4 mm
 * retained film is what makes the front volume-limited instead of racing across the floor.
 */
export const DEFAULT_WATER_TUNING: WaterTuning = {
  cellM: 0.5,
  substepsPerMin: 12,
  alpha: 0.25,
  capMm: 8,
  retainMm: 4,
};

const PLINTH_M = 0.05;
const DRAIN_PER_MIN = 0.3;

interface GridGeometry {
  cols: number;
  rows: number;
  cellM: number;
  origin: { x: number; z: number };
  /** ground height in mm; NaN = wall */
  ground: Float64Array;
  drain: Uint8Array;
}

function buildGeometry(facility: Facility, cellM: number): GridGeometry {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const z of facility.zones) {
    minX = Math.min(minX, z.rect.x); minZ = Math.min(minZ, z.rect.z);
    maxX = Math.max(maxX, z.rect.x + z.rect.w); maxZ = Math.max(maxZ, z.rect.z + z.rect.d);
  }
  const cols = Math.ceil((maxX - minX) / cellM - 1e-9);
  const rows = Math.ceil((maxZ - minZ) / cellM - 1e-9);
  const ground = new Float64Array(cols * rows).fill(NaN);
  const drain = new Uint8Array(cols * rows);

  for (let r = 0; r < rows; r++) {
    const cz = minZ + (r + 0.5) * cellM;
    for (let c = 0; c < cols; c++) {
      const cx = minX + (c + 0.5) * cellM;
      const zone = facility.zones.find((z) => cx >= z.rect.x && cx < z.rect.x + z.rect.w && cz >= z.rect.z && cz < z.rect.z + z.rect.d);
      if (zone) ground[r * cols + c] = zone.elevation * 1000;
    }
  }

  const geo: GridGeometry = { cols, rows, cellM, origin: { x: minX, z: minZ }, ground, drain };
  for (const a of facility.assets) {
    const cells = footprintCells(geo, a.pos.x, a.pos.z, a.size.w, a.size.d, a.rot ?? 0, 0);
    if (a.type === 'drain') for (const i of cells) drain[i] = 1;
    else if (a.type !== 'pipe') for (const i of cells) if (!Number.isNaN(ground[i])) ground[i] += PLINTH_M * 1000;
  }
  return geo;
}

/**
 * Cells whose centre lies inside the (axis-aligned, after rotation snap) footprint grown by
 * `marginM`. Always returns at least the cell containing the centre.
 */
function footprintCells(geo: Pick<GridGeometry, 'cols' | 'rows' | 'cellM' | 'origin'>, x: number, z: number, w: number, d: number, rot: number, marginM: number): number[] {
  // Snap rotation to quarter turns: near ±90° swaps width and depth.
  const quarter = Math.round(rot / (Math.PI / 2));
  const [hw, hd] = Math.abs(quarter) % 2 === 1 ? [d / 2, w / 2] : [w / 2, d / 2];
  const out: number[] = [];
  const { cols, rows, cellM, origin } = geo;
  const c0 = Math.max(0, Math.floor((x - hw - marginM - origin.x) / cellM));
  const c1 = Math.min(cols - 1, Math.floor((x + hw + marginM - origin.x) / cellM));
  const r0 = Math.max(0, Math.floor((z - hd - marginM - origin.z) / cellM));
  const r1 = Math.min(rows - 1, Math.floor((z + hd + marginM - origin.z) / cellM));
  for (let r = r0; r <= r1; r++) {
    const cz = origin.z + (r + 0.5) * cellM;
    if (Math.abs(cz - z) > hd + marginM) continue;
    for (let c = c0; c <= c1; c++) {
      const cx = origin.x + (c + 0.5) * cellM;
      if (Math.abs(cx - x) <= hw + marginM) out.push(r * cols + c);
    }
  }
  if (out.length === 0) {
    const c = Math.floor((x - origin.x) / cellM);
    const r = Math.floor((z - origin.z) / cellM);
    if (c >= 0 && c < cols && r >= 0 && r < rows) out.push(r * cols + c);
  }
  return out;
}

export function simulateWater(
  facility: Facility,
  leak: Leak,
  horizonMin: number,
  frameEveryMin = 1,
  tuning: Partial<WaterTuning> = {},
): WaterGrid {
  const tp: WaterTuning = { ...DEFAULT_WATER_TUNING, ...tuning };
  const geo = buildGeometry(facility, tp.cellM);
  const { cols, rows, ground, drain } = geo;
  const n = cols * rows;

  // Source = non-wall cell nearest the leak point.
  let src = -1;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(ground[i])) continue;
    const cx = geo.origin.x + ((i % cols) + 0.5) * tp.cellM;
    const cz = geo.origin.z + (Math.floor(i / cols) + 0.5) * tp.cellM;
    const d = (cx - leak.x) ** 2 + (cz - leak.z) ** 2;
    if (d < bestD) { bestD = d; src = i; }
  }

  // Neighbour lists (E, W, S, N) as flat Int32Array, -1 = wall/out of bounds.
  const nb = new Int32Array(n * 4).fill(-1);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (Number.isNaN(ground[i])) continue;
      const cand = [c + 1 < cols ? i + 1 : -1, c > 0 ? i - 1 : -1, r + 1 < rows ? i + cols : -1, r > 0 ? i - cols : -1];
      for (let k = 0; k < 4; k++) nb[i * 4 + k] = cand[k] >= 0 && !Number.isNaN(ground[cand[k]]) ? cand[k] : -1;
    }
  }

  const depth = new Float64Array(n); // mm
  const outflow = new Float64Array(n * 4); // mm per substep, per direction
  const dt = 1 / tp.substepsPerMin;
  // 1 L over one cell area (m²) → mm of depth
  const mmPerLitre = 1 / (tp.cellM * tp.cellM);
  const srcPerStep = leak.ratePerMin * mmPerLitre * dt;
  const drainKeep = Math.pow(1 - DRAIN_PER_MIN, dt);

  const frames: WaterGrid['frames'] = [];
  const snapshot = (t: number) => frames.push({ t, depthMm: Float32Array.from(depth) });
  snapshot(0);

  const totalSteps = Math.round(horizonMin * tp.substepsPerMin);
  const stepsPerFrame = Math.max(1, Math.round(frameEveryMin * tp.substepsPerMin));
  for (let s = 1; s <= totalSteps; s++) {
    const t = s * dt;
    if (src >= 0 && t > leak.startT && (leak.stopT === undefined || t <= leak.stopT)) depth[src] += srcPerStep;

    // 1) compute outflows from the current state (Jacobi update)
    for (let i = 0; i < n; i++) {
      const d = depth[i];
      const o = i * 4;
      if (d <= tp.retainMm) { outflow[o] = outflow[o + 1] = outflow[o + 2] = outflow[o + 3] = 0; continue; }
      const surf = ground[i] + d;
      let total = 0;
      for (let k = 0; k < 4; k++) {
        const j = nb[o + k];
        let f = 0;
        if (j >= 0) {
          const ds = surf - (ground[j] + depth[j]);
          if (ds > 0) f = Math.min(tp.capMm, tp.alpha * ds);
        }
        outflow[o + k] = f;
        total += f;
      }
      const avail = d - tp.retainMm;
      if (total > avail) {
        const k = avail / total;
        outflow[o] *= k; outflow[o + 1] *= k; outflow[o + 2] *= k; outflow[o + 3] *= k;
      }
    }
    // 2) apply
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      for (let k = 0; k < 4; k++) {
        const f = outflow[o + k];
        if (f === 0) continue;
        depth[i] -= f;
        depth[nb[o + k]] += f;
      }
    }
    // 3) drains
    for (let i = 0; i < n; i++) if (drain[i]) depth[i] *= drainKeep;

    if (s % stepsPerFrame === 0) snapshot(Math.round(t * 1000) / 1000);
  }

  return { cols, rows, cellM: tp.cellM, origin: geo.origin, frames };
}

/** Frame index with the largest t ≤ `t` (frames are ascending). -1 if before the first frame. */
function frameIndexAt(grid: WaterGrid, t: number): number {
  let lo = 0, hi = grid.frames.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (grid.frames[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Water depth in mm at world (x, z), from the latest frame with t ≤ `t`. 0 outside the grid. */
export function depthAt(grid: WaterGrid, x: number, z: number, t: number): number {
  const fi = frameIndexAt(grid, t);
  if (fi < 0) return 0;
  const c = Math.floor((x - grid.origin.x) / grid.cellM);
  const r = Math.floor((z - grid.origin.z) / grid.cellM);
  if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return 0;
  return grid.frames[fi].depthMm[r * grid.cols + c];
}

/**
 * First frame `t` at which any cell under the asset footprint (grown by 0.5 m) is at or above
 * `thresholdMm`. Assets that never get wet are omitted. Pipes and drains are excluded.
 */
export function waterArrival(grid: WaterGrid, facility: Facility, thresholdMm = 1): Record<ID, number> {
  const out: Record<ID, number> = {};
  for (const a of facility.assets) {
    if (a.type === 'pipe' || a.type === 'drain') continue;
    const cells = footprintCells(grid, a.pos.x, a.pos.z, a.size.w, a.size.d, a.rot ?? 0, 0.5);
    for (const f of grid.frames) {
      const d = f.depthMm;
      let wet = false;
      for (const i of cells) if (d[i] >= thresholdMm) { wet = true; break; }
      if (wet) { out[a.id] = f.t; break; }
    }
  }
  return out;
}
