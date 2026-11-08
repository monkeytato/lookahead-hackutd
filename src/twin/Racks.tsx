import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Asset, AssetVisualState } from '../domain/types';
import { GPU_RACKS } from '../domain/fixture';
import { COLORS, SEVERITY_COLOR } from './constants';
import { clockPulse, useAnim } from './anim';

const W = 0.6, H = 2.2, D = 1.2;
const SINK = 0.14;

function rackGeometry() {
  const paint = (g: THREE.BufferGeometry, v: number) => {
    const n = g.getAttribute('position').count;
    const a = new Float32Array(n * 3).fill(v);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  };
  // vertex colours multiply the per-instance colour: body darker, perforated front door lighter
  const body = paint(new THREE.BoxGeometry(W, H, D).translate(0, H / 2, 0), 0.36);
  const door = paint(new THREE.BoxGeometry(W - 0.08, H - 0.22, 0.02).translate(0, H / 2 - 0.04, D / 2 + 0.005), 1.0);
  const plinth = paint(new THREE.BoxGeometry(W - 0.02, 0.06, D - 0.02).translate(0, 0.03, 0), 0.18);
  const g = mergeGeometries([body, door, plinth])!;
  body.dispose(); door.dispose(); plinth.dispose();
  return g;
}

/** Status strip across the top-front edge: visible from above and from the front. */
const stripGeometry = () => new THREE.BoxGeometry(W - 0.04, 0.09, 0.32).translate(0, H - 0.035, D / 2 - 0.15);

interface Props {
  racks: Asset[];
  elevation: number;
  visual: Record<string, AssetVisualState>;
  hoveredId: string | null;
  onHover: (id: string | null) => void;
  onPick: (id: string, e: ThreeEvent<MouseEvent>) => void;
}

const LOST_BODY = new THREE.Color('#2e2e2e');
const LOST_STRIP = new THREE.Color('#5a1a1d');
const HOVER = new THREE.Color('#b0b0b0');
const DIM = new THREE.Color('#3a3a3a');

/**
 * Instanced racks. Everything that moves is done per frame on preallocated arrays:
 *  - build-in: racks rise from the floor in a west → east wave
 *  - colours glide toward their target (no snapping between scenario minutes)
 *  - racks on a clock pulse their strip faster as time runs out
 *  - lost racks go dark, sink a little and lean, like a dead cabinet
 */
export function Racks({ racks, elevation, visual, hoveredId, onHover, onPick }: Props) {
  const invalidate = useThree((s) => s.invalidate);
  const anim = useAnim();
  const bodyRef = useRef<THREE.InstancedMesh>(null);
  const stripRef = useRef<THREE.InstancedMesh>(null);

  const bodyGeo = useMemo(rackGeometry, []);
  const stripGeo = useMemo(stripGeometry, []);
  const bodyMat = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.05 }), []);
  const stripMat = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false }), []);

  const n = racks.length;
  // per-instance animation state (allocated once per rack set)
  const st = useMemo(() => {
    let minK = Infinity, maxK = -Infinity;
    const keys = racks.map((r) => r.pos.x + r.pos.z * 0.35);
    for (const k of keys) { minK = Math.min(minK, k); maxK = Math.max(maxK, k); }
    return {
      order: Float32Array.from(keys, (k) => (maxK > minK ? (k - minK) / (maxK - minK) : 0)),
      bodyCur: new Float32Array(n * 3), bodyTgt: new Float32Array(n * 3),
      stripCur: new Float32Array(n * 3), stripTgt: new Float32Array(n * 3),
      sinkCur: new Float32Array(n), sinkTgt: new Float32Array(n),
      clock: new Float32Array(n).fill(-1),
      primed: false,
      dirty: true,
      lastBuild: -1,
    };
  }, [racks, n]);

  const o = useMemo(() => new THREE.Object3D(), []);
  const c = useMemo(() => new THREE.Color(), []);
  const p = useMemo(() => new THREE.Color(), []);

  // targets — whenever state / hover changes
  useLayoutEffect(() => {
    racks.forEach((r, i) => {
      const v = visual[r.id];
      const stale = v?.freshness === 'stale' || v?.freshness === 'missing';
      const lost = !!v?.lost;
      if (lost) c.copy(LOST_BODY);
      else {
        c.set(stale ? COLORS.rackStale : GPU_RACKS.includes(r.id) ? COLORS.rackGpu : COLORS.rack);
        if (hoveredId === r.id) c.lerp(HOVER, 0.45);
      }
      c.toArray(st.bodyTgt, i * 3);
      const sev = v?.severity ?? 'normal';
      if (lost) c.copy(LOST_STRIP);
      else c.set(sev !== 'normal' ? SEVERITY_COLOR[sev] : stale ? COLORS.stripStale : COLORS.stripNormal);
      c.toArray(st.stripTgt, i * 3);
      st.sinkTgt[i] = lost ? 1 : 0;
      st.clock[i] = !lost && v?.clockMin != null ? v.clockMin : -1;
    });
    if (!st.primed || anim.reduced) {
      st.bodyCur.set(st.bodyTgt); st.stripCur.set(st.stripTgt); st.sinkCur.set(st.sinkTgt);
      st.primed = true;
    }
    st.dirty = true;
    invalidate();
  }, [racks, visual, hoveredId, c, st, anim, invalidate]);

  useFrame((_, dt) => {
    const body = bodyRef.current, strip = stripRef.current;
    if (!body || !strip) return;
    const k = 1 - Math.exp(-Math.min(dt, 0.1) * 5);
    let moving = false, matrices = anim.build < 1 || st.lastBuild < 1, colors = st.dirty, pulsing = false;
    st.dirty = false;
    st.lastBuild = anim.build;
    for (let i = 0; i < n; i++) {
      // sink
      const sd = st.sinkTgt[i] - st.sinkCur[i];
      if (Math.abs(sd) > 0.001) { st.sinkCur[i] += sd * k; matrices = true; moving = true; }
      // colours
      for (let j = i * 3; j < i * 3 + 3; j++) {
        const bd = st.bodyTgt[j] - st.bodyCur[j];
        const sdd = st.stripTgt[j] - st.stripCur[j];
        if (Math.abs(bd) > 0.002) { st.bodyCur[j] += bd * k; colors = true; moving = true; }
        if (Math.abs(sdd) > 0.002) { st.stripCur[j] += sdd * k; colors = true; moving = true; }
      }
      if (st.clock[i] >= 0) { colors = true; pulsing = true; }
    }
    if (matrices) {
      for (let i = 0; i < n; i++) {
        const r = racks[i];
        const b = anim.buildAt(st.order[i]);
        const s = st.sinkCur[i];
        o.position.set(r.pos.x, elevation - SINK * s, r.pos.z);
        o.rotation.set(0, r.rot ?? 0, 0.045 * s);
        o.scale.set(1, Math.max(0.001, b), 1);
        o.updateMatrix();
        body.setMatrixAt(i, o.matrix);
        strip.setMatrixAt(i, o.matrix);
      }
      body.instanceMatrix.needsUpdate = true;
      strip.instanceMatrix.needsUpdate = true;
      if (anim.build >= 1) { body.computeBoundingSphere(); strip.computeBoundingSphere(); }
    }
    if (colors) {
      for (let i = 0; i < n; i++) {
        c.fromArray(st.bodyCur, i * 3);
        body.setColorAt(i, c);
        c.fromArray(st.stripCur, i * 3);
        if (st.clock[i] >= 0 && !anim.reduced) {
          // breathe between full severity colour and a dim version, faster as the clock runs down
          p.copy(c).lerp(DIM, 0.55 * (1 - clockPulse(anim.clock, st.clock[i])));
          strip.setColorAt(i, p);
        } else strip.setColorAt(i, c);
      }
      if (body.instanceColor) body.instanceColor.needsUpdate = true;
      if (strip.instanceColor) strip.instanceColor.needsUpdate = true;
    }
    if (moving || matrices || (pulsing && !anim.reduced)) invalidate();
  });

  const idAt = (e: ThreeEvent<PointerEvent | MouseEvent>) => (e.instanceId != null ? racks[e.instanceId]?.id : undefined);

  const handlers = {
    onPointerMove: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      const id = idAt(e);
      if (id && id !== hoveredId) onHover(id);
    },
    onPointerOut: () => onHover(null),
    onClick: (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      const id = idAt(e);
      if (id) onPick(id, e);
    },
  };

  return (
    <group>
      <instancedMesh ref={bodyRef} args={[bodyGeo, bodyMat, n]} castShadow receiveShadow frustumCulled={false} {...handlers} />
      <instancedMesh ref={stripRef} args={[stripGeo, stripMat, n]} frustumCulled={false} {...handlers} />
    </group>
  );
}
