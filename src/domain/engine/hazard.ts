/**
 * Fire / smoke spread: a circular front growing from its origin at `spreadMPerMin` up to
 * `maxRadiusM`, limited to the hazard's zones. An ASSUMPTION-level model (no CFD, no fire
 * dynamics): it turns "fire in the UPS room" into arrival times the cascade can use, and into a
 * footprint the 3D twin can draw. Suppressing the origin (a fix) stops the front where it is.
 */
import type { Asset, Facility, Hazard, HazardFrame, ID } from '../types';

/** Distance from a point to an asset's footprint (axis-aligned box, rotation ignored), metres. */
export function distanceToFootprint(a: Asset, x: number, z: number): number {
  const dx = Math.max(0, Math.abs(a.pos.x - x) - a.size.w / 2);
  const dz = Math.max(0, Math.abs(a.pos.z - z) - a.size.d / 2);
  return Math.hypot(dx, dz);
}

/** Front radius at t; growth stops at `stopT` (origin suppressed). */
export function hazardRadius(h: Hazard, t: number, stopT = Infinity): number {
  if (t < h.startT) return 0;
  return Math.min(h.maxRadiusM, Math.max(0, (Math.min(t, stopT) - h.startT) * h.spreadMPerMin));
}

/**
 * Minute the front reaches each asset in its zones (origin = startT). Assets the front never
 * reaches before `stopT` or the horizon are omitted. Pipes and drains don't burn.
 */
export function hazardArrival(facility: Facility, h: Hazard, horizonMin: number, stopT = Infinity): Record<ID, number> {
  const out: Record<ID, number> = {};
  const zones = new Set(h.zoneIds);
  for (const a of facility.assets) {
    if (a.type === 'pipe' || a.type === 'drain') continue;
    if (a.id !== h.originAssetId && !zones.has(a.zoneId)) continue;
    const d = a.id === h.originAssetId ? 0 : distanceToFootprint(a, h.x, h.z);
    if (d > h.maxRadiusM) continue;
    const t = Math.round((h.startT + d / h.spreadMPerMin) * 10) / 10;
    if (t > horizonMin || t >= stopT) continue;
    out[a.id] = t;
  }
  return out;
}

export function hazardFrameAt(h: Hazard, t: number, stopT = Infinity): HazardFrame | null {
  if (t < h.startT) return null;
  return { kind: h.kind, x: h.x, z: h.z, radiusM: Math.round(hazardRadius(h, t, stopT) * 100) / 100, originAssetId: h.originAssetId, contained: stopT <= t };
}
