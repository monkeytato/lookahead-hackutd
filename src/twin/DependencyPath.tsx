import { useMemo } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import type { Asset, DependencyEdge, Zone } from '../domain/types';
import { COLORS, DEP_Y, assetTop, zoneElevation } from './constants';

const UP = new THREE.Vector3(0, 1, 0);

/** Fault → impacted path as an overhead polyline with arrowheads; shares_space hops dashed. */
export function DependencyPath({ path, assets, zones, edges }: { path: string[]; assets: Asset[]; zones: Zone[]; edges: DependencyEdge[] }) {
  const data = useMemo(() => {
    const byId = new Map(assets.map((a) => [a.id, a]));
    const nodes = path.map((id) => byId.get(id)).filter((a): a is Asset => !!a);
    const pts = nodes.map((a) => {
      const top = assetTop(a, zoneElevation(zones, a.zoneId));
      return { a, top, p: new THREE.Vector3(top[0], Math.max(DEP_Y, top[1] + 0.35), top[2]) };
    });
    const segs = [] as { from: THREE.Vector3; to: THREE.Vector3; dashed: boolean; arrowPos: THREE.Vector3; arrowQuat: THREE.Quaternion }[];
    for (let i = 0; i < pts.length - 1; i++) {
      const A = pts[i], B = pts[i + 1];
      const e = edges.find((x) => (x.from === A.a.id && x.to === B.a.id) || (x.from === B.a.id && x.to === A.a.id));
      const dir = B.p.clone().sub(A.p);
      const len = dir.length();
      if (len < 1e-3) continue;
      dir.normalize();
      segs.push({
        from: A.p, to: B.p,
        dashed: e?.kind === 'shares_space',
        arrowPos: A.p.clone().addScaledVector(dir, len * 0.55),
        arrowQuat: new THREE.Quaternion().setFromUnitVectors(UP, dir),
      });
    }
    // vertical droppers from the overhead path to each node's top
    const drops: THREE.Vector3[] = [];
    for (const n of pts) {
      if (n.p.y - n.top[1] > 0.05) drops.push(new THREE.Vector3(...n.top), n.p);
    }
    return { pts, segs, drops };
  }, [path, assets, zones, edges]);

  const coneGeo = useMemo(() => new THREE.ConeGeometry(0.13, 0.42, 14), []);
  const dotGeo = useMemo(() => new THREE.SphereGeometry(0.1, 14, 10), []);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: COLORS.interactive, toneMapped: false }), []);

  if (data.pts.length < 2) return null;
  return (
    <group>
      {data.segs.map((s, i) => (
        <Line
          key={i}
          points={[s.from, s.to]}
          color={COLORS.interactive}
          lineWidth={s.dashed ? 2 : 2.5}
          dashed={s.dashed}
          dashSize={0.35}
          gapSize={0.25}
          toneMapped={false}
        />
      ))}
      {data.drops.length > 0 && (
        <Line points={data.drops} segments color={COLORS.interactive} lineWidth={1} transparent opacity={0.5} toneMapped={false} />
      )}
      {data.segs.map((s, i) => (
        <mesh key={`a${i}`} geometry={coneGeo} material={mat} position={s.arrowPos} quaternion={s.arrowQuat} />
      ))}
      {data.pts.map((n) => (
        <mesh key={n.a.id} geometry={dotGeo} material={mat} position={n.p} />
      ))}
    </group>
  );
}
