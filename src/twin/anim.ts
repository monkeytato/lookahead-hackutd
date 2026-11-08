/**
 * Shared animation state for the live twin. One mutable object per Canvas, advanced once per
 * rendered frame by <AnimDriver>. Components read it inside their own useFrame — no React
 * re-renders, no per-frame allocations.
 *
 *   time     scenario minute shown on screen, gliding toward the prop `t` (so steps of 0.5 min
 *            and +5 min jumps animate instead of snapping)
 *   build    0 → 1 build-in progress after mount or a scenario change
 *   clock    seconds since the Canvas started (flicker, pulses)
 *
 * The Canvas runs frameloop="demand"; anything that needs the next frame sets `wantFrame`.
 */
import { createContext, useContext } from 'react';
import { prefersReducedMotion } from './constants';

export const BUILD_S = 2.1;

export class TwinAnim {
  time = 0;
  target = 0;
  /** true until the first target arrives, so the first frame does not glide from 0 */
  primed = false;
  clock = 0;
  reduced = prefersReducedMotion();
  buildStart = -1;
  /** starts at 0 so the very first frame is already "unbuilt" (no flash before the wave) */
  build = this.reduced ? 1 : 0;
  /** Set by any effect that still needs frames; cleared by the driver each frame. */
  wantFrame = false;

  setTarget(t: number) {
    this.target = t;
    if (!this.primed || this.reduced) { this.time = t; this.primed = true; }
  }

  startBuild() {
    if (this.reduced) { this.build = 1; this.buildStart = -1; return; }
    this.buildStart = this.clock;
    this.build = 0;
  }

  /** Build-in progress for an item whose wave position is `order` ∈ [0, 1] (0 = first to rise). */
  buildAt(order: number, span = 0.42): number {
    if (this.build >= 1) return 1;
    const start = 0.18 + order * (1 - 0.18 - span); // floors use the first 18 %
    return easeOutBack(clamp01((this.build - start) / span));
  }

  /** Floor fade-in progress (first part of the build). */
  floorsAt(): number {
    if (this.build >= 1) return 1;
    return easeOutCubic(clamp01(this.build / 0.22));
  }
}

export const AnimContext = createContext<TwinAnim | null>(null);
export function useAnim(): TwinAnim {
  const a = useContext(AnimContext);
  if (!a) throw new Error('useAnim outside the twin Scene');
  return a;
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const easeOutCubic = (k: number) => 1 - Math.pow(1 - k, 3);
export function easeOutBack(k: number) {
  if (k <= 0) return 0;
  if (k >= 1) return 1;
  const c1 = 1.4, c3 = c1 + 1;
  return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
}

/** Pulse 0..1 whose rate rises as `minutesLeft` falls (≈0.5 Hz at 30 min, ≈2 Hz at 0). */
export function clockPulse(clock: number, minutesLeft: number) {
  const hz = 0.5 + 1.5 * clamp01(1 - minutesLeft / 30);
  return 0.5 + 0.5 * Math.sin(clock * hz * Math.PI * 2);
}
