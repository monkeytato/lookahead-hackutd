import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import type { HazardFrame, Zone } from '../domain/types';
import { useAnim } from './anim';

export type HazardFn = (t: number) => HazardFrame[];

const key = (h: HazardFrame) => `${h.kind}:${h.originAssetId}`;

/** Per-integer-minute cache of a run's hazard frames (hazardAt may be called every frame). */
function useHazardCache(hazardAt: HazardFn) {
  return useMemo(() => {
    const cache = new Map<number, Map<string, HazardFrame>>();
    return (m: number) => {
      let v = cache.get(m);
      if (!v) {
        v = new Map(hazardAt(m).map((h) => [key(h), h]));
        if (cache.size > 400) cache.clear();
        cache.set(m, v);
      }
      return v;
    };
  }, [hazardAt]);
}

const FIRE_VERT = /* glsl */ `
  varying vec2 vP;
  void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const FIRE_FRAG = /* glsl */ `
  uniform float time; uniform float strength;
  varying vec2 vP;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    float r = length(vP);                       // 0 centre … 1 edge (unit disc, scaled by the mesh)
    float ang = atan(vP.y, vP.x);
    float edge = 0.86 + 0.12 * noise(vec2(ang * 3.0, time * 1.7));   // ragged, moving front
    if (r > edge) discard;
    float n = noise(vP * 6.0 + vec2(time * 0.9, -time * 1.3));
    float heat = clamp(1.0 - r / edge, 0.0, 1.0);
    vec3 core = vec3(1.0, 0.86, 0.45), mid = vec3(1.0, 0.42, 0.08), rim = vec3(0.75, 0.08, 0.05);
    vec3 col = mix(rim, mix(mid, core, smoothstep(0.55, 1.0, heat + 0.25 * n)), smoothstep(0.0, 0.5, heat));
    float flick = 0.75 + 0.25 * noise(vec2(time * 6.0, r * 4.0));
    float a = (0.45 + 0.5 * smoothstep(0.0, 0.35, heat)) * flick * strength;
    a *= smoothstep(edge, edge - 0.08, r);       // soft rim
    gl_FragColor = vec4(col * (0.85 + 0.3 * n), a);
  }
`;

const EMBERS = 70;
const FLAMES = 11;
const PUFFS = 26;

/** One fire front: glowing ground disc + rising embers + a flickering light. */
function Fire({ radius, x, y, z, contained }: { radius: { current: number }; x: number; y: number; z: number; contained: boolean }) {
  const anim = useAnim();
  const disc = useRef<THREE.Mesh>(null);
  const pts = useRef<THREE.Points>(null);
  const light = useRef<THREE.PointLight>(null);
  const flames = useRef<THREE.InstancedMesh>(null);
  const flame = useMemo(() => ({
    geo: new THREE.ConeGeometry(0.32, 1, 7, 1, true).translate(0, 0.5, 0),
    mat: new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
    seed: Array.from({ length: FLAMES }, (_, i) => ({ a: (i / FLAMES) * Math.PI * 2 + Math.random() * 0.5, r: 0.15 + 0.6 * Math.sqrt(Math.random()), ph: Math.random() * 10, s: 0.7 + Math.random() * 0.6 })),
    o: new THREE.Object3D(), c: new THREE.Color(), hot: new THREE.Color('#ffb000'), red: new THREE.Color('#da1e28'),
  }), []);
  const mat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, strength: { value: 1 } },
    vertexShader: FIRE_VERT, fragmentShader: FIRE_FRAG,
    transparent: true, depthWrite: false, toneMapped: false, // normal blending: additive vanishes on the light floor
    polygonOffset: true, polygonOffsetFactor: -6,
  }), []);
  const discGeo = useMemo(() => new THREE.CircleGeometry(1, 72), []);
  const ember = useMemo(() => {
    const pos = new Float32Array(EMBERS * 3);
    const seed = Array.from({ length: EMBERS }, () => ({ a: Math.random() * Math.PI * 2, r: Math.sqrt(Math.random()), h: Math.random() * 3, v: 0.6 + Math.random() * 1.2 }));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ color: '#ff6a1a', size: 0.17, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false });
    return { pos, seed, g, m };
  }, []);
  useEffect(() => () => { mat.dispose(); discGeo.dispose(); ember.g.dispose(); ember.m.dispose(); flame.geo.dispose(); flame.mat.dispose(); }, [mat, discGeo, ember, flame]);

  useFrame((_, dt) => {
    const r = Math.max(0.01, radius.current);
    const str = contained ? 0.35 : 1;
    mat.uniforms.time.value = anim.clock;
    mat.uniforms.strength.value = str;
    if (disc.current) disc.current.scale.setScalar(r);
    if (light.current) light.current.intensity = (contained ? 6 : 18) * (0.8 + 0.2 * Math.sin(anim.clock * 13) * Math.sin(anim.clock * 7.3)) * Math.min(1, r / 2);
    const lim = contained ? EMBERS / 3 : EMBERS;
    const step = Math.min(dt, 0.1);
    for (let i = 0; i < EMBERS; i++) {
      const s = ember.seed[i];
      s.h += s.v * step;
      if (s.h > 3.2) { s.h = 0; s.a = Math.random() * Math.PI * 2; s.r = Math.sqrt(Math.random()); }
      const o = i * 3;
      const rr = s.r * r * 0.85;
      ember.pos[o] = i < lim ? Math.cos(s.a) * rr + Math.sin(anim.clock * 2 + i) * 0.08 : 0;
      ember.pos[o + 1] = i < lim ? s.h : -10;
      ember.pos[o + 2] = i < lim ? Math.sin(s.a) * rr : 0;
    }
    (ember.g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    // flame tongues: flickering cones inside the front, shorter and fewer once contained
    const fm = flames.current;
    if (fm) {
      const { o, c } = flame;
      for (let i = 0; i < FLAMES; i++) {
        const f = flame.seed[i];
        const on = !contained || i % 3 === 0;
        const h = on ? (0.7 + 0.9 * f.s) * (0.75 + 0.25 * Math.sin(anim.clock * (7 + i) + f.ph) * Math.sin(anim.clock * 3.1 + f.ph)) * Math.min(1.4, 0.35 + r * 0.3) * (contained ? 0.45 : 1) : 0.001;
        o.position.set(Math.cos(f.a) * f.r * r, 0.02, Math.sin(f.a) * f.r * r);
        o.rotation.set(0.12 * Math.sin(anim.clock * 2 + f.ph), f.ph, 0.12 * Math.cos(anim.clock * 2.3 + f.ph));
        o.scale.set(f.s * Math.min(1.3, 0.5 + r * 0.2), Math.max(0.001, h), f.s * Math.min(1.3, 0.5 + r * 0.2));
        o.updateMatrix();
        fm.setMatrixAt(i, o.matrix);
        c.copy(flame.red).lerp(flame.hot, 0.35 + 0.5 * f.r * (0.5 + 0.5 * Math.sin(anim.clock * 9 + f.ph)));
        fm.setColorAt(i, c);
      }
      fm.instanceMatrix.needsUpdate = true;
      if (fm.instanceColor) fm.instanceColor.needsUpdate = true;
    }
  });

  return (
    <group position={[x, y, z]}>
      <mesh ref={disc} geometry={discGeo} material={mat} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} renderOrder={4} />
      <instancedMesh ref={flames} args={[flame.geo, flame.mat, FLAMES]} frustumCulled={false} renderOrder={5} />
      <points ref={pts} geometry={ember.g} material={ember.m} frustumCulled={false} />
      <pointLight ref={light} color="#ff6a1a" distance={14} decay={1.6} position={[0, 1.4, 0]} />
    </group>
  );
}

let puffTex: THREE.CanvasTexture | null = null;
/** Soft round puff (radial gradient), shared by every smoke front. */
function puffTexture() {
  if (puffTex) return puffTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  puffTex = new THREE.CanvasTexture(c);
  return puffTex;
}

/** One smoke front: soft gray billboard puffs rising and drifting over the footprint. */
function Smoke({ radius, x, y, z, contained }: { radius: { current: number }; x: number; y: number; z: number; contained: boolean }) {
  const anim = useAnim();
  const pts = useMemo(() => {
    const pos = new Float32Array(PUFFS * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ color: '#6f6f6f', map: puffTexture(), size: 3.2, sizeAttenuation: true, transparent: true, opacity: 0.38, depthWrite: false });
    const seed = Array.from({ length: PUFFS }, (_, i) => ({ a: (i / PUFFS) * Math.PI * 2 + Math.random(), r: Math.sqrt(Math.random()), ph: Math.random() }));
    return { pos, g, m, seed };
  }, []);
  useEffect(() => () => { pts.g.dispose(); pts.m.dispose(); }, [pts]);
  useFrame(() => {
    const r = Math.max(0.01, radius.current);
    pts.m.opacity = (contained ? 0.18 : 0.42) * Math.min(1, r / 3);
    pts.m.size = 5 + Math.min(4, r * 0.3);
    for (let i = 0; i < PUFFS; i++) {
      const s = pts.seed[i];
      const k = (s.ph + anim.clock * 0.05) % 1; // 0 → 1 rise cycle
      const o = i * 3;
      const rr = s.r * r * (0.55 + 0.35 * k);
      pts.pos[o] = Math.cos(s.a + k * 0.6) * rr;
      pts.pos[o + 1] = 0.8 + k * 3.6;
      pts.pos[o + 2] = Math.sin(s.a + k * 0.6) * rr;
    }
    (pts.g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  });
  return <points geometry={pts.g} material={pts.m} position={[x, y, z]} frustumCulled={false} renderOrder={5} />;
}

/**
 * Fire / smoke fronts from run.hazardAt. Radii glide with the twin clock (between whole minutes),
 * so a front visibly grows while the scenario plays; a contained front stops and dims.
 */
export function HazardLayer({ hazardAt, t, zones }: { hazardAt: HazardFn; t: number; zones: Zone[] }) {
  const anim = useAnim();
  const invalidate = useThree((s) => s.invalidate);
  const frames = useHazardCache(hazardAt);
  // which fronts exist at the target time (React list; radii are animated refs)
  const list = useMemo(() => [...frames(Math.ceil(t)).values()], [frames, t]);
  const radii = useRef(new Map<string, { current: number }>());
  for (const h of list) if (!radii.current.has(key(h))) radii.current.set(key(h), { current: anim.reduced ? h.radiusM : 0 });

  useFrame(() => {
    const tt = Math.max(0, anim.time);
    const a = frames(Math.floor(tt)), b = frames(Math.ceil(tt));
    const w = tt - Math.floor(tt);
    for (const h of list) {
      const k = key(h);
      const ra = a.get(k)?.radiusM ?? 0, rb = b.get(k)?.radiusM ?? ra;
      const target = ra + (rb - ra) * w;
      const r = radii.current.get(k)!;
      r.current += (target - r.current) * (anim.reduced ? 1 : 0.2);
    }
    if (list.length && !anim.reduced) invalidate(); // flicker / embers need frames
  }, -0.5);

  const elev = (x: number, z: number) => zones.find((zn) => x >= zn.rect.x && x <= zn.rect.x + zn.rect.w && z >= zn.rect.z && z <= zn.rect.z + zn.rect.d)?.elevation ?? 0;

  return (
    <group>
      {list.map((h) => {
        const r = radii.current.get(key(h))!;
        const y = elev(h.x, h.z);
        return h.kind === 'fire'
          ? <Fire key={key(h)} radius={r} x={h.x} y={y} z={h.z} contained={h.contained} />
          : <Smoke key={key(h)} radius={r} x={h.x} y={y} z={h.z} contained={h.contained} />;
      })}
    </group>
  );
}

/** Prediction: dashed rings where each front will be at the ghost time. */
export function GhostHazards({ hazardAt, t, zones }: { hazardAt: HazardFn; t: number; zones: Zone[] }) {
  const rings = useMemo(() => hazardAt(t).map((h) => {
    const y = zones.find((zn) => h.x >= zn.rect.x && h.x <= zn.rect.x + zn.rect.w && h.z >= zn.rect.z && h.z <= zn.rect.z + zn.rect.d)?.elevation ?? 0;
    const pts: [number, number, number][] = [];
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      pts.push([h.x + Math.cos(a) * h.radiusM, y + 0.05, h.z + Math.sin(a) * h.radiusM]);
    }
    return { k: key(h), pts, fire: h.kind === 'fire' };
  }), [hazardAt, t, zones]);
  return (
    <group>
      {rings.map((r) => (
        <Line key={r.k} points={r.pts} color={r.fire ? '#a37d7d' : '#7d8fa3'} lineWidth={2} dashed dashSize={0.5} gapSize={0.35} transparent opacity={0.9} toneMapped={false} />
      ))}
    </group>
  );
}
