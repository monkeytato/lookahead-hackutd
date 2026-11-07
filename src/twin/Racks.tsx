import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Asset, AssetVisualState } from '../domain/types';
import { GPU_RACKS } from '../domain/fixture';
import { COLORS, SEVERITY_COLOR } from './constants';

const W = 0.6, H = 2.2, D = 1.2;

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

export function Racks({ racks, elevation, visual, hoveredId, onHover, onPick }: Props) {
  const invalidate = useThree((s) => s.invalidate);
  const bodyRef = useRef<THREE.InstancedMesh>(null);
  const stripRef = useRef<THREE.InstancedMesh>(null);

  const bodyGeo = useMemo(rackGeometry, []);
  const stripGeo = useMemo(stripGeometry, []);
  const bodyMat = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.05 }), []);
  const stripMat = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false }), []);

  // transforms — once per rack set
  useLayoutEffect(() => {
    const o = new THREE.Object3D();
    racks.forEach((r, i) => {
      o.position.set(r.pos.x, elevation, r.pos.z);
      o.rotation.set(0, r.rot ?? 0, 0);
      o.updateMatrix();
      bodyRef.current!.setMatrixAt(i, o.matrix);
      stripRef.current!.setMatrixAt(i, o.matrix);
    });
    for (const m of [bodyRef.current!, stripRef.current!]) {
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
      m.computeBoundingBox();
    }
    invalidate();
  }, [racks, elevation, invalidate]);

  // colours — whenever state / hover changes
  const c = useMemo(() => new THREE.Color(), []);
  useLayoutEffect(() => {
    const body = bodyRef.current!, strip = stripRef.current!;
    racks.forEach((r, i) => {
      const v = visual[r.id];
      const stale = v?.freshness === 'stale' || v?.freshness === 'missing';
      const base = stale ? COLORS.rackStale : GPU_RACKS.includes(r.id) ? COLORS.rackGpu : COLORS.rack;
      c.set(base);
      if (hoveredId === r.id) c.lerp(tmpHover, 0.45);
      body.setColorAt(i, c);
      const sev = v?.severity ?? 'normal';
      c.set(sev !== 'normal' ? SEVERITY_COLOR[sev] : stale ? COLORS.stripStale : COLORS.stripNormal);
      strip.setColorAt(i, c);
    });
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    if (strip.instanceColor) strip.instanceColor.needsUpdate = true;
    invalidate();
  }, [racks, visual, hoveredId, c, invalidate]);

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
      <instancedMesh ref={bodyRef} args={[bodyGeo, bodyMat, racks.length]} castShadow receiveShadow {...handlers} />
      <instancedMesh ref={stripRef} args={[stripGeo, stripMat, racks.length]} {...handlers} />
    </group>
  );
}

const tmpHover = new THREE.Color('#b0b0b0');
