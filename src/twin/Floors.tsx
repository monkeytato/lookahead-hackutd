import { Suspense, useMemo } from 'react';
import * as THREE from 'three';
import { Text } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Asset, Zone } from '../domain/types';
import { COLORS, FONT_URL, WALL, ZONE_FLOOR } from './constants';

const SLAB = 0.12;
const TILE_M = 0.6;
const DOOR_W = 1.6;

/**
 * Door gaps where the walk graph crosses a zone boundary (fixture waypoints C-1/C-2/C-3,
 * H-W↔M-1, C-0 → yard, C-4 ops door). Explicit so restricted rooms keep their single door.
 */
export const DOORS: { x: number; z: number }[] = [
  { x: 32, z: 11.5 }, // hall east door (C-2 ↔ H-E)
  { x: 34, z: 6 },    // UPS room (C-1 ↔ U-1)
  { x: 34, z: 18 },   // battery room (C-3 ↔ B-1)
  { x: 8, z: 11.5 },  // plant room (H-W ↔ M-1)
  { x: 33, z: 0 },    // corridor north exit
  { x: 33, z: 24 },   // ops room door (C-4)
  { x: 34, z: -1.6 }, // yard gate (C-0 ↔ Y-1)
];

let tileTex: THREE.CanvasTexture | null = null;
function tileTexture() {
  if (tileTex) return tileTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#e9e9e9';
  g.fillRect(0, 0, 64, 2);
  g.fillRect(0, 0, 2, 64);
  tileTex = new THREE.CanvasTexture(c);
  tileTex.wrapS = tileTex.wrapT = THREE.RepeatWrapping;
  tileTex.colorSpace = THREE.SRGBColorSpace;
  tileTex.anisotropy = 8;
  return tileTex;
}

function buildFloor(zones: Zone[]) {
  const color = new THREE.Color();
  const parts = zones.map((z) => {
    const { x, z: zz, w, d } = z.rect;
    const g = new THREE.BoxGeometry(w, SLAB, d).translate(x + w / 2, z.elevation - SLAB / 2, zz + d / 2);
    const pos = g.getAttribute('position');
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    color.set(ZONE_FLOOR[z.kind] ?? '#e0e0e0');
    for (let i = 0; i < pos.count; i++) {
      col[i * 3] = color.r; col[i * 3 + 1] = color.g; col[i * 3 + 2] = color.b;
      // raised-floor tile grid in the hall only; other zones sample the tile centre (no line)
      if (z.kind === 'hall') uv.setXY(i, pos.getX(i) / TILE_M, pos.getZ(i) / TILE_M);
      else uv.setXY(i, 0.5, 0.5);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  });
  const merged = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return merged;
}

interface Seg { horiz: boolean; c: number; a: number; b: number }

function buildWalls(zones: Zone[]): Seg[] {
  const lines = new Map<string, Seg[]>();
  const add = (horiz: boolean, c: number, a: number, b: number) => {
    const key = `${horiz ? 'h' : 'v'}:${c.toFixed(2)}`;
    const arr = lines.get(key) ?? [];
    arr.push({ horiz, c, a: Math.min(a, b), b: Math.max(a, b) });
    lines.set(key, arr);
  };
  for (const z of zones) {
    const { x, z: zz, w, d } = z.rect;
    add(true, zz, x, x + w); add(true, zz + d, x, x + w);
    add(false, x, zz, zz + d); add(false, x + w, zz, zz + d);
  }
  const out: Seg[] = [];
  for (const segs of lines.values()) {
    segs.sort((p, q) => p.a - q.a);
    const merged: Seg[] = [];
    for (const s of segs) {
      const last = merged[merged.length - 1];
      if (last && s.a <= last.b + 1e-6) last.b = Math.max(last.b, s.b);
      else merged.push({ ...s });
    }
    for (const m of merged) {
      // subtract door gaps
      let pieces: Seg[] = [m];
      for (const door of DOORS) {
        const onLine = m.horiz ? Math.abs(door.z - m.c) < 0.05 : Math.abs(door.x - m.c) < 0.05;
        if (!onLine) continue;
        const along = m.horiz ? door.x : door.z;
        const g0 = along - DOOR_W / 2, g1 = along + DOOR_W / 2;
        pieces = pieces.flatMap((p) => {
          if (g1 <= p.a || g0 >= p.b) return [p];
          const res: Seg[] = [];
          if (g0 > p.a) res.push({ ...p, b: g0 });
          if (g1 < p.b) res.push({ ...p, a: g1 });
          return res;
        });
      }
      out.push(...pieces.filter((p) => p.b - p.a > 0.25));
    }
  }
  return out;
}

export function Floors({ zones, assets, onFloorClick }: {
  zones: Zone[];
  assets: Asset[];
  onFloorClick: (e: ThreeEvent<MouseEvent>) => void;
}) {
  const floorGeo = useMemo(() => buildFloor(zones), [zones]);
  const floorMat = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, map: tileTexture() }), []);

  const walls = useMemo(() => buildWalls(zones), [zones]);
  const wallGeo = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const wallMat = useMemo(() => new THREE.MeshStandardMaterial({ color: COLORS.wall, roughness: 0.9 }), []);
  const wallMesh = useMemo(() => {
    const m = new THREE.InstancedMesh(wallGeo, wallMat, Math.max(1, walls.length));
    const o = new THREE.Object3D();
    walls.forEach((s, i) => {
      const len = s.b - s.a + WALL.thick;
      const mid = (s.a + s.b) / 2;
      const h = WALL.height + SLAB;
      if (s.horiz) { o.position.set(mid, h / 2 - SLAB, s.c); o.scale.set(len, h, WALL.thick); }
      else { o.position.set(s.c, h / 2 - SLAB, mid); o.scale.set(WALL.thick, h, len); }
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    });
    m.count = walls.length;
    m.castShadow = true;
    m.receiveShadow = true;
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
    return m;
  }, [walls, wallGeo, wallMat]);

  const rowLabels = useMemo(() => {
    const rows = new Map<string, { x: number; z: number }>();
    for (const a of assets) {
      if (a.type !== 'rack' || !a.location.row) continue;
      const r = rows.get(a.location.row);
      if (!r || a.pos.x < r.x) rows.set(a.location.row, { x: a.pos.x, z: a.pos.z });
    }
    return [...rows.entries()];
  }, [assets]);

  return (
    <group>
      <mesh geometry={floorGeo} material={floorMat} receiveShadow onClick={onFloorClick} />
      <primitive object={wallMesh} />
      <Suspense fallback={null}>
      {zones.map((z) => {
        // narrow zones (corridors) get their label running along the long axis, reading south → north
        const along = z.rect.d > z.rect.w * 2.5;
        return (
          <group
            key={z.id}
            position={along
              ? [z.rect.x + z.rect.w / 2, z.elevation + 0.012, z.rect.z + z.rect.d - 3.2]
              : [z.rect.x + 0.55, z.elevation + 0.012, z.rect.z + 0.5]}
            rotation={[0, along ? Math.PI / 2 : 0, 0]}
          >
            <Text
              font={FONT_URL}
              fontSize={z.kind === 'hall' ? 0.62 : 0.46}
              letterSpacing={0.12}
              color={COLORS.label}
              anchorX="left"
              anchorY={along ? 'middle' : 'top'}
              rotation={[-Math.PI / 2, 0, 0]}
              maxWidth={along ? z.rect.d - 1 : z.rect.w - 1}
            >
              {z.name.toUpperCase()}
            </Text>
          </group>
        );
      })}
      {rowLabels.map(([row, p]) => (
        <Text
          key={row}
          font={FONT_URL}
          fontSize={0.42}
          letterSpacing={0.12}
          color={COLORS.label}
          anchorX="right"
          anchorY="middle"
          rotation={[-Math.PI / 2, 0, 0]}
          position={[p.x - 0.75, 0.035, p.z]}
        >
          {`ROW ${row}`}
        </Text>
      ))}
      </Suspense>
    </group>
  );
}
