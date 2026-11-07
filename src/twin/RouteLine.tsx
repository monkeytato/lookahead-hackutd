import { useMemo } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import type { Waypoint, Zone } from '../domain/types';
import { COLORS, zoneElevation } from './constants';

export function RouteLine({ route, zones }: { route: Waypoint[]; zones: Zone[] }) {
  const pts = useMemo(
    () => route.map((w) => new THREE.Vector3(w.x, zoneElevation(zones, w.zoneId) + 0.035, w.z)),
    [route, zones],
  );
  const geo = useMemo(() => ({
    dot: new THREE.CircleGeometry(0.2, 24).rotateX(-Math.PI / 2),
    ring: new THREE.RingGeometry(0.34, 0.46, 32).rotateX(-Math.PI / 2),
    core: new THREE.CircleGeometry(0.12, 20).rotateX(-Math.PI / 2),
  }), []);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: COLORS.interactive, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3 }), []);

  if (pts.length < 2) return null;
  const start = pts[0], end = pts[pts.length - 1];
  return (
    <group renderOrder={4}>
      <Line points={pts} color={COLORS.interactive} lineWidth={3} dashed dashSize={0.45} gapSize={0.3} toneMapped={false} />
      <mesh geometry={geo.dot} material={mat} position={start} />
      <mesh geometry={geo.ring} material={mat} position={end} />
      <mesh geometry={geo.core} material={mat} position={end} />
    </group>
  );
}
