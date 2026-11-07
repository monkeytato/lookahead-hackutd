import type { StampedFrame } from '../../src/domain/rig/protocol';
import { SimRig, stamp } from '../../src/domain/rig/simDevice';

export const T0 = Date.parse('2026-11-07T15:00:00.000Z');
export const iso = (ms: number) => new Date(ms).toISOString();

/** Drives a SimRig at 1 Hz, stamping frames like the bridge does. */
export class Harness {
  readonly rig: SimRig;
  readonly frames: StampedFrame[] = [];
  private t = 0;
  constructor(seed = 7) {
    this.rig = new SimRig(seed);
  }
  run(seconds: number): this {
    for (let i = 0; i < seconds; i++) {
      this.t += 1;
      this.frames.push(stamp(this.rig.tick(1), iso(T0 + this.t * 1000)));
    }
    return this;
  }
  cmd(...lines: string[]): this {
    for (const l of lines) this.rig.command(l);
    return this;
  }
  /** Frames from the last `s` seconds. */
  last(s: number): StampedFrame[] {
    return this.frames.slice(-s);
  }
  get now(): string {
    return iso(T0 + this.t * 1000);
  }
}
