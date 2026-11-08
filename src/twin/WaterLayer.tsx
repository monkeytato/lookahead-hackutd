import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import type { WaterGrid, Zone } from '../domain/types';
import { COLORS } from './constants';
import { useAnim } from './anim';

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

/** The two frames around `t` and the blend weight between them. */
function bracket(grid: WaterGrid, t: number): [WaterGrid['frames'][number], WaterGrid['frames'][number], number] {
  const fs = grid.frames;
  if (t <= fs[0].t) return [fs[0], fs[0], 0];
  for (let i = 1; i < fs.length; i++) {
    if (fs[i].t >= t) {
      const a = fs[i - 1], b = fs[i];
      return [a, b, b.t > a.t ? (t - a.t) / (b.t - a.t) : 0];
    }
  }
  const last = fs[fs.length - 1];
  return [last, last, 0];
}

const GHOST_VERT = /* glsl */ `
  varying vec2 vUv; varying vec3 vWorld;
  void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }
`;
const GHOST_FRAG = /* glsl */ `
  uniform sampler2D map; uniform vec3 color; uniform float time;
  varying vec2 vUv; varying vec3 vWorld;
  void main() {
    float a = texture2D(map, vUv).a;
    if (a < 0.02) discard;
    // diagonal hatch drifting slowly: unmistakably "not real yet"
    float s = step(0.5, fract((vWorld.x + vWorld.z) * 1.4 - time * 0.15));
    gl_FragColor = vec4(color, (0.10 + 0.32 * s) * clamp(a * 2.2, 0.0, 1.0));
  }
`;

/**
 * Floor-hugging water depth. One shared DataTexture (cols × rows, linear filtered) rewritten
 * when the shown time moves; frames are blended, so the wet front spreads smoothly between
 * scenario minutes. `ghost` draws a hatched, desaturated preview of a future time instead.
 */
export function WaterLayer({ grid, zones, t, ghost = false }: { grid: WaterGrid; zones: Zone[]; t: number; ghost?: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  const anim = useAnim();
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

  const ramp = useMemo(() => {
    const d = new THREE.Color(COLORS.water), s = new THREE.Color(COLORS.waterShallow);
    return { D: [d.r * 255, d.g * 255, d.b * 255], S: [s.r * 255, s.g * 255, s.b * 255] };
  }, []);

  // present water follows the gliding clock; the ghost sits at its own (prediction) time
  const offset = t - (ghost ? t : anim.target);
  const shown = useRef(NaN);
  const write = (tt: number) => {
    if (!grid.frames.length) return;
    const [a, b, w] = bracket(grid, tt);
    const data = tex.image.data as Uint8Array;
    const lnSpan = Math.log(FULL_MM / MIN_MM);
    const { D, S } = ramp;
    for (let i = 0, n = cols * rows; i < n; i++) {
      const mm = a.depthMm[i] + (b.depthMm[i] - a.depthMm[i]) * w;
      let k = 0, al = 0;
      if (mm >= MIN_MM) {
        k = Math.min(1, Math.log(mm / MIN_MM) / lnSpan);
        al = ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * k;
      } else if (mm > MIN_MM * 0.4) {
        al = ALPHA_MIN * ((mm - MIN_MM * 0.4) / (MIN_MM * 0.6)); // feathered front edge
      }
      const o = i * 4;
      data[o] = S[0] + (D[0] - S[0]) * k;
      data[o + 1] = S[1] + (D[1] - S[1]) * k;
      data[o + 2] = S[2] + (D[2] - S[2]) * k;
      data[o + 3] = Math.round(al * 255);
    }
    tex.needsUpdate = true;
    shown.current = tt;
  };

  // ghost and reduced-motion: write on change; present: glide in useFrame
  useEffect(() => {
    if (ghost || anim.reduced) { write(t); invalidate(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghost, t, grid, tex]);

  useFrame(() => {
    if (ghost) {
      if (mat.uniforms && !anim.reduced) { mat.uniforms.time.value = anim.clock; invalidate(); }
      return;
    }
    if (anim.reduced) return;
    const tt = anim.time + offset;
    if (Math.abs(tt - shown.current) > 0.015 || Number.isNaN(shown.current)) write(tt);
  });

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
      out.push({ id: z.id, geo, y: z.elevation + (ghost ? 0.02 : 0.012) });
    }
    return out;
  }, [zones, origin.x, origin.z, cols, rows, cellM, ghost]);
  useEffect(() => () => planes.forEach((p) => p.geo.dispose()), [planes]);

  const mat = useMemo<THREE.Material & { uniforms?: Record<string, THREE.IUniform> }>(() => (ghost
    ? new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, color: { value: new THREE.Color('#7d8fa3') }, time: { value: 0 } },
      vertexShader: GHOST_VERT, fragmentShader: GHOST_FRAG, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -5,
    })
    : new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -4,
    })), [tex, ghost]);
  useEffect(() => () => mat.dispose(), [mat]);

  return (
    <group>
      {planes.map((p) => (
        <mesh key={p.id} geometry={p.geo} material={mat} position={[0, p.y, 0]} renderOrder={ghost ? 1 : 2} />
      ))}
    </group>
  );
}
