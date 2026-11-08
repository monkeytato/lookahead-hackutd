import { useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { BUILD_S, type TwinAnim } from './anim';

/**
 * Advances the shared TwinAnim once per rendered frame and keeps the demand loop alive while
 * something is moving: the time glide, the build-in, or any effect that set `wantFrame`.
 * Runs first (priority -1) so every other useFrame sees this frame's values.
 */
export function AnimDriver({ anim, t, buildKey }: { anim: TwinAnim; t: number; buildKey: string }) {
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => { anim.setTarget(t); invalidate(); }, [anim, t, invalidate]);
  useEffect(() => { anim.startBuild(); invalidate(); }, [anim, buildKey, invalidate]);

  useFrame((_, dt) => {
    const step = Math.min(dt, 0.1);
    anim.clock += step;
    // glide toward the target time; ~90 % of the way in 0.35 s, so a +5 min jump visibly "grows"
    const gap = anim.target - anim.time;
    if (Math.abs(gap) > 0.002) anim.time += gap * (1 - Math.exp(-step * 6.5));
    else anim.time = anim.target;
    if (anim.buildStart >= 0) {
      anim.build = Math.min(1, (anim.clock - anim.buildStart) / BUILD_S);
      if (anim.build >= 1) anim.buildStart = -1;
    }
    const busy = anim.time !== anim.target || anim.build < 1 || anim.wantFrame;
    anim.wantFrame = false;
    if (busy) invalidate();
  }, -1);

  return null;
}
