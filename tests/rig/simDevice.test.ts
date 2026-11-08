import { describe, expect, it } from 'vitest';
import type { RigFrame } from '../../src/domain/rig/protocol';
import { SimRig } from '../../src/domain/rig/simDevice';

function run(rig: SimRig, s: number): RigFrame[] {
  return Array.from({ length: s }, () => rig.tick(1));
}

describe('SimRig determinism', () => {
  it('same seed → identical frames; different seed → different noise', () => {
    const a = run(new SimRig(5), 120);
    const b = run(new SimRig(5), 120);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = run(new SimRig(6), 120);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it('is deterministic through staged commands too', () => {
    const go = () => {
      const r = new SimRig(11);
      const out = run(r, 20);
      r.command('auto off');
      r.command('flap open');
      out.push(...run(r, 30));
      r.command('sim power off');
      out.push(...run(r, 30));
      return JSON.stringify(out);
    };
    expect(go()).toBe(go());
  });
});

describe('SimRig frame shape and physics', () => {
  it('emits protocol v2 frames with plausible baseline values', () => {
    const frames = run(new SimRig(1), 60);
    const f = frames[59];
    expect(Object.keys(f)).toEqual([
      'v', 'dev', 'fw', 'seq', 'up_ms', 'temp_c', 'vib', 'drip_raw', 'pack_v', 'flap', 'valve', 'fan_pct', 'auto', 'flags', 'event',
    ]);
    expect(f).toMatchObject({ v: 2, seq: 59, up_ms: 60000, flap: 'closed', valve: 'closed', fan_pct: [70, 70], auto: true, flags: [], event: null });
    expect('source' in f).toBe(false);
    expect(f.temp_c!).toBeGreaterThan(22);
    expect(f.temp_c!).toBeLessThan(24);
    for (const fan of ['fan_a', 'fan_b'] as const) {
      const v = f.vib[fan];
      expect(v.dist_mm).toBeGreaterThan(40);
      expect(v.disp_mm!).toBeGreaterThan(0.005);
      expect(v.disp_mm!).toBeLessThan(0.02);
      expect(v.freq_hz!).toBeGreaterThan(20);
      expect(v.vel_mm_s!).toBeGreaterThan(0.8);
      expect(v.vel_mm_s!).toBeLessThan(2.8);
      expect(v.n).toBe(61);
    }
    expect(f.drip_raw).toBeLessThan(5);
    expect(f.pack_v!).toBeGreaterThan(8);
  });

  it('the probe refreshes every 2 s in 1/16 °C steps', () => {
    const frames = run(new SimRig(2), 40);
    for (const f of frames) expect(Math.abs(f.temp_c! / 0.0625 - Math.round(f.temp_c! / 0.0625))).toBeLessThan(1e-6);
    // consecutive frames come in pairs sharing a value (2 s period) more often than not
    let same = 0;
    for (let i = 1; i < frames.length; i++) if (frames[i].temp_c === frames[i - 1].temp_c) same++;
    expect(same).toBeGreaterThan(10);
  });

  it('flap open with auto off: inlet climbs by several degrees over ~90 s', () => {
    const r = new SimRig(3);
    const before = run(r, 20).at(-1)!.temp_c!;
    r.command('auto off');
    r.command('flap open');
    const after = run(r, 90).at(-1)!.temp_c!;
    expect(after - before).toBeGreaterThan(2.5);
  });

  it('auto mode closes the flap itself once the inlet is ≥ 1.5 °C over baseline', () => {
    const r = new SimRig(4);
    run(r, 20);
    r.command('flap open');
    const frames = run(r, 120);
    const ev = frames.find((f) => f.event === 'flap_closed');
    expect(ev).toBeDefined();
    expect(ev!.flap).toBe('closed');
    expect(frames.filter((f) => f.event === 'flap_closed')).toHaveLength(1);
  });

  it('valve open wets the tray after ~6 s; auto closes the valve and the tray stops rising', () => {
    const r = new SimRig(5);
    run(r, 10);
    r.command('valve open');
    const frames = run(r, 40);
    expect(frames[3].drip_raw).toBeLessThan(20);
    const wetAt = frames.findIndex((f) => f.drip_raw >= 120);
    expect(wetAt).toBeGreaterThan(4);
    expect(wetAt).toBeLessThan(15);
    const closed = frames.find((f) => f.event === 'valve_closed');
    expect(closed).toBeDefined();
    const tail = frames.slice(-10).map((f) => f.drip_raw);
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(6);
  });

  it('power off: pack ~0.4 V, fans 0, fans go still, servos cannot move', () => {
    const r = new SimRig(6);
    run(r, 10);
    r.command('sim power off');
    const f = run(r, 10).at(-1)!;
    expect(f.pack_v!).toBeLessThan(1);
    expect(f.fan_pct).toEqual([0, 0]);
    expect(f.flags).toContain('pack_low');
    expect(f.vib.fan_a.vel_mm_s).toBeNull();
    expect(f.vib.fan_a.disp_mm!).toBeLessThan(0.005);
    expect(r.command('valve open')).toMatch(/no power/);
    expect(run(r, 2).at(-1)!.valve).toBe('closed');
  });

  it('imbalance raises one fan channel ~3× and keeps the other; a bump goes further', () => {
    const r = new SimRig(8);
    const base = run(r, 10).at(-1)!;
    r.command('sim imbalance fan_a');
    const f = run(r, 5).at(-1)!;
    expect(f.vib.fan_a.vel_mm_s! / base.vib.fan_a.vel_mm_s!).toBeGreaterThan(2.2);
    expect(f.vib.fan_b.vel_mm_s! / base.vib.fan_b.vel_mm_s!).toBeLessThan(1.6);
    r.command('sim balance');
    r.command('sim bump fan_b');
    const g = run(r, 5).at(-1)!;
    expect(g.vib.fan_b.vel_mm_s!).toBeGreaterThan(f.vib.fan_a.vel_mm_s!);
  });

  it('fan_a fail: its mount goes still and the pack rises with commands unchanged', () => {
    const r = new SimRig(9);
    const before = run(r, 10).at(-1)!;
    r.command('sim fan_a fail');
    const after = run(r, 10).at(-1)!;
    expect(after.fan_pct).toEqual([70, 70]);
    expect(after.vib.fan_a.vel_mm_s).toBeNull();
    expect(after.vib.fan_b.vel_mm_s!).toBeGreaterThan(0.8);
    expect(after.pack_v! - before.pack_v!).toBeGreaterThan(0.05);
  });

  it('staged faults: temp bias → temp_invalid flag; blocked sensor → short distance + obstructed', () => {
    const r = new SimRig(10);
    run(r, 5);
    r.command('sim fault temp');
    expect(run(r, 3).at(-1)!.flags).toContain('temp_invalid');
    r.command('sim fault clear');
    r.command('sim block fan_a');
    const f = run(r, 2).at(-1)!;
    expect(f.flags).toContain('fan_a_obstructed');
    expect(f.vib.fan_a.dist_mm!).toBeLessThan(15);
    expect(f.vib.fan_a.vel_mm_s).toBeNull();
  });

  it('answers commands like the firmware', () => {
    const r = new SimRig(1);
    expect(r.command('PING')).toBe('pong');
    expect(r.command('fan 90 10')).toBe('ok fan 70 10');
    expect(r.command('auto off')).toBe('ok auto off');
    expect(r.command('cal')).toMatch(/^ok cal baseline=/);
    expect(r.command('bogus')).toMatch(/^err unknown/);
  });
});
