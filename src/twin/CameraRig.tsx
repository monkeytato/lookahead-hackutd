import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { OVERVIEW, prefersReducedMotion } from './constants';

const FLY_MS = 600;
const SWING_MS = 1400;
/** Presenter: idle seconds before the slow orbit starts, min gap between event swings, hold time at an event */
const IDLE_S = 6, SWING_GAP_S = 8, HOLD_S = 11;
const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

export interface FocusTarget { x: number; y: number; z: number; size: number }

/** Overview distance that fits the footprint radius for the current aspect. */
export function overviewDistance(aspect: number) {
  const vfov = THREE.MathUtils.degToRad(OVERVIEW.fov);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  const fit = Math.min(vfov * 1.12, hfov); // tilted floor foreshortens vertically
  return THREE.MathUtils.clamp(OVERVIEW.radius / Math.sin(fit / 2), 40, 120);
}

function overviewPose(aspect: number, outPos: THREE.Vector3, outTarget: THREE.Vector3) {
  const el = THREE.MathUtils.degToRad(OVERVIEW.elevationDeg);
  const az = THREE.MathUtils.degToRad(OVERVIEW.azimuthDeg);
  const d = overviewDistance(aspect);
  outTarget.set(...OVERVIEW.target);
  outPos.set(
    outTarget.x + d * Math.cos(el) * Math.sin(az),
    outTarget.y + d * Math.sin(el),
    outTarget.z + d * Math.cos(el) * Math.cos(az),
  );
}

export function CameraRig({ focus, focusKey, resetViewKey, presenter = false, eventFocus = null, eventKey = null }: {
  focus: FocusTarget | null;
  focusKey: string | null;
  resetViewKey?: number;
  /** Cinematic mode for the projector: idle orbit + swing to new critical events */
  presenter?: boolean;
  eventFocus?: FocusTarget | null;
  eventKey?: string | null;
}) {
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);

  const anim = useMemo(() => ({
    active: false, start: 0, ms: FLY_MS,
    lastInteract: performance.now() / 1000, lastSwing: -1e9, returnAt: 0,
    fromP: new THREE.Vector3(), toP: new THREE.Vector3(),
    fromT: new THREE.Vector3(), toT: new THREE.Vector3(),
    dir: new THREE.Vector3(),
  }), []);

  const flyTo = (toP: THREE.Vector3, toT: THREE.Vector3, ms = FLY_MS) => {
    const c = controls.current;
    if (!c) return;
    if (prefersReducedMotion()) {
      camera.position.copy(toP);
      c.target.copy(toT);
      c.update();
      invalidate();
      return;
    }
    anim.fromP.copy(camera.position);
    anim.fromT.copy(c.target);
    anim.toP.copy(toP);
    anim.toT.copy(toT);
    anim.start = performance.now();
    anim.ms = ms;
    anim.active = true;
    invalidate();
  };

  // initial overview — applied once the controls instance exists (it may mount after us)
  const initialised = useRef(false);
  const applyOverview = () => {
    const c = controls.current;
    if (!c) return false;
    overviewPose(size.width / Math.max(1, size.height), anim.toP, anim.toT);
    camera.position.copy(anim.toP);
    c.target.copy(anim.toT);
    c.update();
    return true;
  };
  useLayoutEffect(() => {
    if (!initialised.current) initialised.current = applyOverview();
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // reset view
  const firstReset = useRef(true);
  useEffect(() => {
    if (firstReset.current) { firstReset.current = false; return; }
    const p = new THREE.Vector3(), t = new THREE.Vector3();
    overviewPose(size.width / Math.max(1, size.height), p, t);
    flyTo(p, t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetViewKey]);

  const flyToFocus = (f: FocusTarget, ms = FLY_MS) => {
    const c = controls.current;
    if (!c) return;
    const t = new THREE.Vector3(f.x, f.y, f.z);
    // keep the current viewing direction, but never flatter than ~28°
    anim.dir.copy(camera.position).sub(c.target).normalize();
    const minY = Math.sin(THREE.MathUtils.degToRad(28));
    if (anim.dir.y < minY) {
      const horiz = Math.hypot(anim.dir.x, anim.dir.z) || 1;
      const k = Math.cos(Math.asin(minY)) / horiz;
      anim.dir.set(anim.dir.x * k, minY, anim.dir.z * k);
    }
    const dist = THREE.MathUtils.clamp(f.size * 3.2 + 9, 11, 26) * (presenter ? 1.35 : 1);
    flyTo(t.clone().addScaledVector(anim.dir, dist), t, ms);
  };

  // fly to selection / stage focus
  useEffect(() => {
    if (!focus) return;
    flyToFocus(focus);
    anim.returnAt = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  // presenter: swing toward the newest critical event, rate-limited, never while someone is steering
  useEffect(() => {
    if (!presenter || !eventFocus || !eventKey || focusKey) return;
    const now = performance.now() / 1000;
    if (now - anim.lastSwing < SWING_GAP_S || now - anim.lastInteract < IDLE_S) return;
    anim.lastSwing = now;
    anim.returnAt = now + HOLD_S;
    flyToFocus(eventFocus, SWING_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventKey]);

  useFrame(() => {
    if (!initialised.current) {
      initialised.current = applyOverview();
      invalidate();
      return;
    }
    const c = controls.current;
    if (!c) return;
    if (presenter && !anim.active) {
      const now = performance.now() / 1000;
      if (anim.returnAt && now > anim.returnAt && now - anim.lastInteract > IDLE_S && !focusKey) {
        anim.returnAt = 0;
        const p = new THREE.Vector3(), t = new THREE.Vector3();
        overviewPose(size.width / Math.max(1, size.height), p, t);
        flyTo(p, t, SWING_MS);
      }
      const idle = now - anim.lastInteract > IDLE_S && !anim.active && !prefersReducedMotion();
      if (c.autoRotate !== idle) c.autoRotate = idle;
      if (idle) invalidate(); // drei OrbitControls updates itself each rendered frame
    } else if (c.autoRotate) c.autoRotate = false;
    if (!anim.active) return;
    const k = Math.min(1, (performance.now() - anim.start) / anim.ms);
    const e = easeInOut(k);
    camera.position.lerpVectors(anim.fromP, anim.toP, e);
    c.target.lerpVectors(anim.fromT, anim.toT, e);
    c.update();
    if (k >= 1) anim.active = false;
    invalidate();
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.09}
      rotateSpeed={0.6}
      zoomSpeed={0.8}
      minDistance={5}
      maxDistance={120}
      minPolarAngle={0.12}
      maxPolarAngle={Math.PI / 2 - 0.1}
      autoRotateSpeed={0.35}
      onStart={() => { anim.active = false; anim.lastInteract = performance.now() / 1000; anim.returnAt = 0; }}
      onEnd={() => { anim.lastInteract = performance.now() / 1000; }}
    />
  );
}
