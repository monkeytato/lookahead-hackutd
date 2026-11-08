import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import type { Asset, AssetVisualState, Zone } from '../domain/types';
import { COLORS, PIPE_Y, SEVERITY_COLOR, zoneElevation } from './constants';
import { useAnim } from './anim';

// ---------------------------------------------------------------- floors build-in

/** Fades and lifts its children in during the first part of the build-in. */
export function BuildFade({ children }: { children: ReactNode }) {
  const anim = useAnim();
  const ref = useRef<THREE.Group>(null);
  const mats = useRef<{ m: THREE.Material; opacity: number; transparent: boolean }[] | null>(null);
  const done = useRef(true);
  useFrame(() => {
    const g = ref.current;
    if (!g) return;
    const f = anim.floorsAt();
    if (f >= 1) {
      if (!done.current && mats.current) {
        for (const x of mats.current) { x.m.opacity = x.opacity; x.m.transparent = x.transparent; x.m.needsUpdate = true; }
        g.position.y = 0;
      }
      done.current = true;
      return;
    }
    if (done.current || !mats.current) {
      const seen = new Set<THREE.Material>();
      mats.current = [];
      g.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        for (const x of Array.isArray(m) ? m : m ? [m] : []) {
          if (seen.has(x)) continue;
          seen.add(x);
          mats.current!.push({ m: x, opacity: x.opacity, transparent: x.transparent });
          x.transparent = true; x.needsUpdate = true;
        }
      });
      done.current = false;
    }
    for (const x of mats.current) x.m.opacity = x.opacity * f;
    g.position.y = -0.35 * (1 - f);
  });
  return <group ref={ref}>{children}</group>;
}

// ---------------------------------------------------------------- heat bloom

const BLOOM_MIN = 0.58; // heat ≈ 26 °C inlet: below this the hall stays grayscale

/** Shimmering heat columns above racks whose inlet heat is high. Instanced, glides. */
export function HeatBloom({ racks, elevation, visual }: { racks: Asset[]; elevation: number; visual: Record<string, AssetVisualState> }) {
  const anim = useAnim();
  const invalidate = useThree((s) => s.invalidate);
  const ref = useRef<THREE.InstancedMesh>(null);
  const n = racks.length;
  const geo = useMemo(() => new THREE.CylinderGeometry(0.42, 0.62, 1, 16, 1, true).translate(0, 0.5, 0), []);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }), []);
  useEffect(() => () => { geo.dispose(); mat.dispose(); }, [geo, mat]);
  const cur = useMemo(() => new Float32Array(n), [n]);
  const tgt = useMemo(() => new Float32Array(n), [n]);
  useLayoutEffect(() => {
    racks.forEach((r, i) => {
      const v = visual[r.id];
      const h = v && !v.lost ? v.heat : 0;
      tgt[i] = h > BLOOM_MIN ? (h - BLOOM_MIN) / (1 - BLOOM_MIN) : 0;
    });
    invalidate();
  }, [racks, visual, tgt, invalidate]);
  const o = useMemo(() => new THREE.Object3D(), []);
  const c = useMemo(() => new THREE.Color(), []);
  const hot = useMemo(() => new THREE.Color(COLORS.heatHot), []);
  useFrame((_, dt) => {
    const m = ref.current;
    if (!m) return;
    const k = 1 - Math.exp(-Math.min(dt, 0.1) * 3);
    let any = false;
    for (let i = 0; i < n; i++) {
      cur[i] += (tgt[i] - cur[i]) * (anim.reduced ? 1 : k);
      const v = cur[i] < 0.01 ? 0 : cur[i];
      if (v > 0) any = true;
      const r = racks[i];
      const shimmer = anim.reduced ? 1 : 0.85 + 0.15 * Math.sin(anim.clock * 3.1 + i * 1.7);
      o.position.set(r.pos.x, elevation + 2.2, r.pos.z);
      o.scale.set(1, Math.max(0.001, v * 2.4 * shimmer * anim.buildAt(1)), 1);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
      c.copy(hot).multiplyScalar(0.55 * v);
      m.setColorAt(i, c);
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    if (any && !anim.reduced) invalidate();
  });
  return <instancedMesh ref={ref} args={[geo, mat, n]} frustumCulled={false} renderOrder={6} />;
}

// ---------------------------------------------------------------- event effects

const RIPPLES = 8;
const SWEEPS = 6;
const RIPPLE_S = 1.5;
const SWEEP_S = 1.4;
const RECOVER = '#08bdba';

interface Slot { on: boolean; t0: number; x: number; y: number; z: number; size: number; h: number; lost: boolean }

/**
 * One-shot effects driven by state transitions (not by time):
 *  - asset becomes critical or is lost → ripple ring on the floor + the asset's own pulse
 *  - a fix takes effect (restored)     → calm cyan scan sweeping up the asset
 * Calls `onCritical` with the newest critical asset so the presenter camera can swing to it.
 */
export function EventEffects({ assets, zones, visual, onCritical }: {
  assets: Asset[]; zones: Zone[]; visual: Record<string, AssetVisualState>; onCritical?: (id: string) => void;
}) {
  const anim = useAnim();
  const invalidate = useThree((s) => s.invalidate);
  const prev = useRef<Record<string, AssetVisualState> | null>(null);
  const ripples = useMemo<Slot[]>(() => Array.from({ length: RIPPLES }, () => ({ on: false, t0: 0, x: 0, y: 0, z: 0, size: 1, h: 1, lost: false })), []);
  const sweeps = useMemo<Slot[]>(() => Array.from({ length: SWEEPS }, () => ({ on: false, t0: 0, x: 0, y: 0, z: 0, size: 1, h: 1, lost: false })), []);
  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);

  useEffect(() => {
    const p = prev.current;
    prev.current = visual;
    if (!p || anim.reduced || anim.build < 1) return; // no storm on mount / scenario change
    let spawned = 0, newest: string | null = null;
    for (const [id, v] of Object.entries(visual)) {
      if (spawned >= 6) break;
      const was = p[id];
      const a = byId.get(id);
      if (!a || !was) continue;
      const elev = zoneElevation(zones, a.zoneId);
      const y = a.type === 'pipe' ? PIPE_Y - 3 : elev;
      const size = Math.min(1.6, Math.max(a.size.w, a.size.d)); // long battery strings must not flood the view
      const becameCritical = v.severity === 'critical' && was.severity !== 'critical';
      const becameLost = !!v.lost && !was.lost;
      if (becameCritical || becameLost) {
        const s = ripples.find((r) => !r.on) ?? ripples.reduce((o, r) => (r.t0 < o.t0 ? r : o));
        Object.assign(s, { on: true, t0: anim.clock, x: a.pos.x, y, z: a.pos.z, size, h: a.size.h, lost: becameLost });
        spawned++;
        newest = id;
      }
      if (v.restored && !was.restored) {
        const s = sweeps.find((r) => !r.on) ?? sweeps.reduce((o, r) => (r.t0 < o.t0 ? r : o));
        Object.assign(s, { on: true, t0: anim.clock, x: a.pos.x, y, z: a.pos.z, size: Math.max(a.size.w, a.size.d), h: a.type === 'pipe' ? 0.6 : a.size.h, lost: false });
        spawned++;
      }
    }
    if (newest && onCritical) onCritical(newest);
    if (spawned) invalidate();
  }, [visual, byId, zones, ripples, sweeps, anim, invalidate, onCritical]);

  const ringGeo = useMemo(() => new THREE.RingGeometry(0.86, 1, 64).rotateX(-Math.PI / 2), []);
  const sweepGeo = useMemo(() => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), []);
  const boxGeo = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)), []);
  const ringMats = useMemo(() => ripples.map(() => new THREE.MeshBasicMaterial({ color: SEVERITY_COLOR.critical, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide })), [ripples]);
  const sweepMats = useMemo(() => sweeps.map(() => new THREE.MeshBasicMaterial({ color: RECOVER, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })), [sweeps]);
  const boxMats = useMemo(() => sweeps.map(() => new THREE.LineBasicMaterial({ color: RECOVER, transparent: true, toneMapped: false })), [sweeps]);
  useEffect(() => () => { ringGeo.dispose(); sweepGeo.dispose(); boxGeo.dispose(); [...ringMats, ...sweepMats, ...boxMats].forEach((m) => m.dispose()); }, [ringGeo, sweepGeo, boxGeo, ringMats, sweepMats, boxMats]);

  const ringRefs = useRef<(THREE.Mesh | null)[]>([]);
  const sweepRefs = useRef<(THREE.Mesh | null)[]>([]);
  const boxRefs = useRef<(THREE.LineSegments | null)[]>([]);

  useFrame(() => {
    let active = false;
    ripples.forEach((s, i) => {
      const m = ringRefs.current[i];
      if (!m) return;
      const k = (anim.clock - s.t0) / RIPPLE_S;
      if (!s.on || k >= 1) { s.on = false; m.visible = false; return; }
      active = true;
      m.visible = true;
      const r = 0.6 + s.size * (0.5 + 1.9 * (1 - Math.pow(1 - k, 2)));
      m.position.set(s.x, s.y + 0.04, s.z);
      m.scale.setScalar(r);
      ringMats[i].opacity = (1 - k) * 0.9;
      ringMats[i].color.set(s.lost ? '#8a1c22' : SEVERITY_COLOR.critical);
    });
    sweeps.forEach((s, i) => {
      const m = sweepRefs.current[i], b = boxRefs.current[i];
      if (!m || !b) return;
      const k = (anim.clock - s.t0) / SWEEP_S;
      if (!s.on || k >= 1) { s.on = false; m.visible = false; b.visible = false; return; }
      active = true;
      m.visible = b.visible = true;
      const pad = 0.25;
      m.position.set(s.x, s.y + 0.05 + s.h * k, s.z);
      m.scale.set(s.size + pad, 1, s.size + pad);
      sweepMats[i].opacity = 0.55 * Math.sin(Math.PI * k);
      b.position.set(s.x, s.y, s.z);
      b.scale.set(s.size + pad, s.h + 0.1, s.size + pad);
      boxMats[i].opacity = 0.9 * (1 - k);
    });
    if (active) invalidate();
  });

  return (
    <group>
      {ripples.map((_, i) => <mesh key={`r${i}`} ref={(m) => { ringRefs.current[i] = m; }} geometry={ringGeo} material={ringMats[i]} visible={false} renderOrder={7} />)}
      {sweeps.map((_, i) => <mesh key={`s${i}`} ref={(m) => { sweepRefs.current[i] = m; }} geometry={sweepGeo} material={sweepMats[i]} visible={false} renderOrder={7} />)}
      {sweeps.map((_, i) => <lineSegments key={`b${i}`} ref={(m) => { boxRefs.current[i] = m; }} geometry={boxGeo} material={boxMats[i]} visible={false} />)}
    </group>
  );
}

// ---------------------------------------------------------------- prediction ghost: assets

const GHOST = '#7d8fa3';

/** Dashed blue-gray outlines around assets the forecast loses by the ghost time (not lost yet). */
export function GhostAssets({ assets, zones, ids }: { assets: Asset[]; zones: Zone[]; ids: string[] }) {
  const geo = useMemo(() => {
    const pts: number[] = [];
    const set = new Set(ids);
    for (const a of assets) {
      if (!set.has(a.id)) continue;
      const elev = zoneElevation(zones, a.zoneId);
      const quarter = a.rot && Math.abs(Math.abs(a.rot) - Math.PI / 2) < 1e-3;
      const w = (quarter ? a.size.d : a.size.w) + 0.16, d = (quarter ? a.size.w : a.size.d) + 0.16;
      const pipe = a.type === 'pipe';
      const y0 = pipe ? PIPE_Y - a.size.h / 2 - 0.08 : elev + 0.01, y1 = pipe ? PIPE_Y + a.size.h / 2 + 0.08 : elev + a.size.h + 0.08;
      const x0 = a.pos.x - w / 2, x1 = a.pos.x + w / 2, z0 = a.pos.z - d / 2, z1 = a.pos.z + d / 2;
      const c = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
      for (const [i, j] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) pts.push(...c[i], ...c[j]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [assets, zones, ids]);
  const mat = useMemo(() => new THREE.LineDashedMaterial({ color: GHOST, dashSize: 0.22, gapSize: 0.14, transparent: true, opacity: 0.95, toneMapped: false }), []);
  const ref = useRef<THREE.LineSegments>(null);
  useLayoutEffect(() => { ref.current?.computeLineDistances(); }, [geo]);
  useEffect(() => () => geo.dispose(), [geo]);
  useEffect(() => () => mat.dispose(), [mat]);
  if (!ids.length) return null;
  return <lineSegments ref={ref} geometry={geo} material={mat} renderOrder={8} />;
}
