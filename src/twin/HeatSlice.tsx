import { Suspense, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { Text } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import type { Asset, AssetVisualState, Zone } from '../domain/types';
import { COLORS, FONT_URL } from './constants';

const RES = 64;
const SLICE_Y = 1.2;

const cold = new THREE.Color(COLORS.heatCold);
const mid = new THREE.Color(COLORS.heatMid);
const hot = new THREE.Color(COLORS.heatHot);
const tmp = new THREE.Color();

/** Diverging ramp cyan → gray → red (sRGB-space lerp keeps the Carbon hues recognisable). */
function ramp(h: number, out: THREE.Color) {
  // ease away from neutral so modest deviations still read
  if (h < 0.5) out.copy(mid).lerp(cold, Math.pow((0.5 - h) / 0.5, 0.6));
  else out.copy(mid).lerp(hot, Math.pow((h - 0.5) / 0.5, 0.6));
  return out;
}

/** Indicative heat slice over the hall at 1.2 m: inverse-distance blend of rack `heat`. */
export function HeatSlice({ hall, racks, visual }: { hall: Zone; racks: Asset[]; visual: Record<string, AssetVisualState> }) {
  const invalidate = useThree((s) => s.invalidate);
  const { x, z, w, d } = hall.rect;

  const tex = useMemo(() => {
    const tx = new THREE.DataTexture(new Uint8Array(RES * RES * 4), RES, RES, THREE.RGBAFormat);
    tx.magFilter = tx.minFilter = THREE.LinearFilter;
    tx.colorSpace = THREE.SRGBColorSpace;
    return tx;
  }, []);
  useEffect(() => () => tex.dispose(), [tex]);

  const samples = useMemo(() => racks
    .map((r) => ({ x: r.pos.x, z: r.pos.z, h: visual[r.id]?.heat }))
    .filter((s): s is { x: number; z: number; h: number } => typeof s.h === 'number'), [racks, visual]);

  useEffect(() => {
    const data = tex.image.data as Uint8Array;
    for (let j = 0; j < RES; j++) {
      const pz = z + ((j + 0.5) / RES) * d;
      for (let i = 0; i < RES; i++) {
        const px = x + ((i + 0.5) / RES) * w;
        let sw = 0, sh = 0;
        for (const s of samples) {
          const dx = px - s.x, dz = (pz - s.z) * 0.8;
          const q = dx * dx + dz * dz + 0.25;
          const wgt = 1 / (q * q); // ~1/d^4: each rack owns its own neighbourhood
          sw += wgt; sh += wgt * s.h;
        }
        // far from any rack the field relaxes to neutral
        const conf = sw / (sw + 0.02);
        const h = sw > 0 ? 0.5 + (sh / sw - 0.5) * conf : 0.5;
        ramp(h, tmp);
        const dev = Math.min(1, Math.abs(h - 0.5) * 2);
        const o = (j * RES + i) * 4;
        const hex = tmp.getHex(THREE.SRGBColorSpace);
        data[o] = (hex >> 16) & 255; data[o + 1] = (hex >> 8) & 255; data[o + 2] = hex & 255;
        data[o + 3] = Math.round((0.03 + 0.42 * Math.sqrt(dev)) * conf * 255);
      }
    }
    tex.needsUpdate = true;
    invalidate();
  }, [samples, tex, x, z, w, d, invalidate]);

  const geo = useMemo(() => {
    const g = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2);
    // PlaneGeometry v=0 is the +z edge after rotation; flip so texture row 0 is the north edge
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    return g;
  }, [w, d]);
  useEffect(() => () => geo.dispose(), [geo]);

  const mat = useMemo(() => new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }), [tex]);
  useEffect(() => () => mat.dispose(), [mat]);

  return (
    <group>
      <mesh geometry={geo} material={mat} position={[x + w / 2, hall.elevation + SLICE_Y, z + d / 2]} renderOrder={3} />
      <Suspense fallback={null}>
      <Text
        font={FONT_URL}
        fontSize={0.36}
        letterSpacing={0.1}
        color={COLORS.label}
        anchorX="right"
        anchorY="bottom"
        rotation={[-Math.PI / 2, 0, 0]}
        position={[x + w - 0.5, hall.elevation + 0.012, z + d - 0.45]}
      >
        HEAT SLICE · 1.2 M · INDICATIVE, NOT CFD
      </Text>
      </Suspense>
    </group>
  );
}
