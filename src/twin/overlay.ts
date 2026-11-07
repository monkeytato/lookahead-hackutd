/**
 * Lightweight DOM overlay for labels. Instead of one drei <Html> portal/root per label (which
 * churns React roots as markers come and go), labels are ordinary DOM in the Twin tree; a single
 * projector inside the canvas writes their screen transform each rendered frame.
 */
import { useCallback, useEffect, useRef } from 'react';

interface Anchor { el: HTMLElement | null; x: number; y: number; z: number; boost: number }

export class AnchorRegistry {
  readonly anchors = new Map<string, Anchor>();
  /** Set by the projector: requests a frame when anchors change (frameloop="demand"). */
  onChange: (() => void) | null = null;

  upsert(key: string, el: HTMLElement | null, x: number, y: number, z: number, boost: number) {
    const a = this.anchors.get(key);
    if (a) { a.el = el; a.x = x; a.y = y; a.z = z; a.boost = boost; }
    else this.anchors.set(key, { el, x, y, z, boost });
    this.onChange?.();
  }

  remove(key: string) {
    this.anchors.delete(key);
  }
}

/** Ref callback that pins a DOM element to a world position. */
export function useAnchor(registry: AnchorRegistry, key: string, pos: readonly [number, number, number], boost = 0) {
  const elRef = useRef<HTMLElement | null>(null);
  const [x, y, z] = pos;
  useEffect(() => {
    registry.upsert(key, elRef.current, x, y, z, boost);
  }, [registry, key, x, y, z, boost]);
  useEffect(() => () => registry.remove(key), [registry, key]);
  return useCallback((el: HTMLElement | null) => {
    elRef.current = el;
    if (el) el.style.visibility = 'hidden'; // until first projection
    const a = registry.anchors.get(key);
    if (a) { a.el = el; registry.onChange?.(); }
  }, [registry, key]);
}
