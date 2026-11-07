import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import type { AnchorRegistry } from './overlay';

/** Projects every registered DOM anchor to screen space on each rendered frame. */
export function AnchorProjector({ registry }: { registry: AnchorRegistry }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  const v = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    registry.onChange = () => invalidate();
    invalidate();
    return () => { registry.onChange = null; };
  }, [registry, invalidate]);

  useFrame(() => {
    for (const a of registry.anchors.values()) {
      const el = a.el;
      if (!el) continue;
      v.set(a.x, a.y, a.z).project(camera);
      if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.15 || Math.abs(v.y) > 1.15) {
        if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
        continue;
      }
      const px = (v.x * 0.5 + 0.5) * size.width;
      const py = (-v.y * 0.5 + 0.5) * size.height;
      el.style.visibility = 'visible';
      el.style.transform = `translate3d(${px.toFixed(1)}px,${py.toFixed(1)}px,0)`;
      el.style.zIndex = String(a.boost * 10000 + Math.round((1 - v.z) * 5000));
    }
  });

  return null;
}
