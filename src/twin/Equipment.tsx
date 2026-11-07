import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { Asset, AssetVisualState, Waypoint, Zone } from '../domain/types';
import { SEVERITY_COLOR, zoneElevation } from './constants';
import { buildAssetGeometry } from './shapes';

interface Props {
  assets: Asset[];
  zones: Zone[];
  waypoints: Waypoint[];
  visual: Record<string, AssetVisualState>;
  hoveredId: string | null;
  onHover: (id: string | null) => void;
  onPick: (id: string, e: ThreeEvent<MouseEvent>) => void;
}

/** Floor frame around an abnormal asset: severity colour as a marker, never a body fill. */
function frameGeometry(w: number, d: number, inset = 0.22, band = 0.1) {
  const hw = w / 2 + inset, hd = d / 2 + inset;
  const s = new THREE.Shape();
  s.moveTo(-hw, -hd); s.lineTo(hw, -hd); s.lineTo(hw, hd); s.lineTo(-hw, hd); s.closePath();
  const h = new THREE.Path();
  const iw = hw - band, id = hd - band;
  h.moveTo(-iw, -id); h.lineTo(-iw, id); h.lineTo(iw, id); h.lineTo(iw, -id); h.closePath();
  s.holes.push(h);
  return new THREE.ShapeGeometry(s).rotateX(-Math.PI / 2);
}

export function Equipment({ assets, zones, waypoints, visual, hoveredId, onHover, onPick }: Props) {
  const items = useMemo(() => {
    const wpById = new Map(waypoints.map((w) => [w.id, w]));
    return assets.map((a) => ({
      a,
      elev: zoneElevation(zones, a.zoneId),
      geo: buildAssetGeometry(a, wpById.get(a.accessWaypoint)),
    }));
  }, [assets, zones, waypoints]);

  useEffect(() => () => items.forEach((i) => i.geo.dispose()), [items]);

  const mats = useMemo(() => ({
    base: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 }),
    hover: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05, emissive: new THREE.Color('#2a2a2a') }),
    stale: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, transparent: true, opacity: 0.55, depthWrite: true }),
    frame: Object.fromEntries((['advisory', 'warning', 'critical'] as const).map((s) => [
      s, new THREE.MeshBasicMaterial({ color: SEVERITY_COLOR[s], toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2 }),
    ])) as Record<'advisory' | 'warning' | 'critical', THREE.MeshBasicMaterial>,
  }), []);

  const frames = useMemo(() => {
    const out: { id: string; geo: THREE.BufferGeometry; sev: 'advisory' | 'warning' | 'critical'; x: number; y: number; z: number }[] = [];
    for (const { a, elev } of items) {
      const v = visual[a.id];
      if (!v || v.severity === 'normal') continue; // pipe: frame drawn on the floor below it
      out.push({ id: a.id, geo: frameGeometry(a.size.w, a.size.d), sev: v.severity, x: a.pos.x, y: elev + 0.006, z: a.pos.z });
    }
    return out;
  }, [items, visual]);
  useEffect(() => () => frames.forEach((f) => f.geo.dispose()), [frames]);

  return (
    <group>
      {items.map(({ a, elev, geo }) => {
        const v = visual[a.id];
        const stale = v?.freshness === 'stale' || v?.freshness === 'missing';
        const mat = hoveredId === a.id ? mats.hover : stale ? mats.stale : mats.base;
        return (
          <mesh
            key={a.id}
            geometry={geo}
            material={mat}
            position={[a.pos.x, a.type === 'pipe' ? 0 : elev, a.pos.z]}
            castShadow={a.type !== 'drain'}
            receiveShadow
            userData={{ assetId: a.id }}
            onPointerMove={(e) => { e.stopPropagation(); if (hoveredId !== a.id) onHover(a.id); }}
            onPointerOut={() => onHover(null)}
            onClick={(e) => { e.stopPropagation(); onPick(a.id, e); }}
          />
        );
      })}
      {frames.map((f) => (
        <mesh key={f.id} geometry={f.geo} material={mats.frame[f.sev]} position={[f.x, f.y, f.z]} renderOrder={1} />
      ))}
    </group>
  );
}
