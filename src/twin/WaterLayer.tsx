import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import type { WaterGrid, Zone } from '../domain/types';
import { COLORS } from './constants';

const MIN_MM = 0.5;
const FULL_MM = 10;
const ALPHA_MIN = 0.14; // wet front stays visible
const ALPHA_MAX = 0.55;

export function nearestFrame(grid: WaterGrid, t: number) {
  let best = grid.frames[0], bd = Infinity;
  for (const f of grid.frames) {
    const d = Math.abs(f.t - t);
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}

/**
 * Floor-hugging water depth. One shared DataTexture (cols × rows, linear filtered) updated
 * in place when `t` changes; one plane per zone so each sits on its own floor elevation.
 */
export function WaterLayer({ grid, zones, t }: { grid: WaterGrid; zones: Zone[]; t: number }) {
  const invalidate = useThree((s) => s.invalidate);
  const { cols, rows, cellM, origin } = grid;

  const tex = useMemo(() => {
    const data = new Uint8Array(cols * rows * 4);
    const tx = new THREE.DataTexture(data, cols, rows, THREE.RGBAFormat);
    tx.magFilter = THREE.LinearFilter;
    tx.minFilter = THREE.LinearFilter;
    tx.colorSpace = THREE.SRGBColorSpace;
    tx.needsUpdate = true;
    return tx;
  }, [cols, rows]);
  useEffect(() => () => tex.dispose(), [tex]);

  const deep = useMemo(() => new THREE.Color(COLORS.water), []);
  const shallow = useMemo(() => new THREE.Color(COLORS.waterShallow), []);

  const frame = grid.frames.length ? nearestFrame(grid, t) : undefined;
  useEffect(() => {
    const data = tex.image.data as Uint8Array;
    const depth = frame?.depthMm;
    const lnSpan = Math.log(FULL_MM / MIN_MM);
    const dr = deep.getHexString(), sr = shallow.getHexString();
    const D = [parseInt(dr.slice(0, 2), 16), parseInt(dr.slice(2, 4), 16), parseInt(dr.slice(4, 6), 16)];
    const S = [parseInt(sr.slice(0, 2), 16), parseInt(sr.slice(2, 4), 16), parseInt(sr.slice(4, 6), 16)];
    for (let i = 0, n = cols * rows; i < n; i++) {
      const mm = depth ? depth[i] : 0;
      let k = 0, a = 0;
      if (mm >= MIN_MM) {
        k = Math.min(1, Math.log(mm / MIN_MM) / lnSpan);
        a = ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * k;
      }
      const o = i * 4;
      data[o] = S[0] + (D[0] - S[0]) * k;
      data[o + 1] = S[1] + (D[1] - S[1]) * k;
      data[o + 2] = S[2] + (D[2] - S[2]) * k;
      data[o + 3] = Math.round(a * 255);
    }
    tex.needsUpdate = true;
    invalidate();
  }, [frame, tex, cols, rows, deep, shallow, invalidate]);

  // per-zone planes clipped to the grid extent, UVs mapped to grid space
  const planes = useMemo(() => {
    const gx0 = origin.x, gz0 = origin.z, gx1 = gx0 + cols * cellM, gz1 = gz0 + rows * cellM;
    const out: { id: string; geo: THREE.BufferGeometry; y: number }[] = [];
    for (const z of zones) {
      const x0 = Math.max(gx0, z.rect.x), x1 = Math.min(gx1, z.rect.x + z.rect.w);
      const z0 = Math.max(gz0, z.rect.z), z1 = Math.min(gz1, z.rect.z + z.rect.d);
      if (x1 - x0 < 0.05 || z1 - z0 < 0.05) continue;
      const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2).translate((x0 + x1) / 2, 0, (z0 + z1) / 2);
      const pos = geo.getAttribute('position');
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        uv.setXY(i, (pos.getX(i) - gx0) / (gx1 - gx0), (pos.getZ(i) - gz0) / (gz1 - gz0));
      }
      out.push({ id: z.id, geo, y: z.elevation + 0.012 });
    }
    return out;
  }, [zones, origin.x, origin.z, cols, rows, cellM]);
  useEffect(() => () => planes.forEach((p) => p.geo.dispose()), [planes]);

  const mat = useMemo(() => new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -4,
  }), [tex]);
  useEffect(() => () => mat.dispose(), [mat]);

  return (
    <group>
      {planes.map((p) => (
        <mesh key={p.id} geometry={p.geo} material={mat} position={[0, p.y, 0]} renderOrder={2} />
      ))}
    </group>
  );
}
