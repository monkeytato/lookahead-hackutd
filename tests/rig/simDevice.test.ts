import { describe, expect, it } from 'vitest';
import type { RigFrame } from '../../src/domain/rig/protocol';
import { BEAM_PATH_M, SimRig, echoUs, tempFromEcho } from '../../src/domain/rig/simDevice';

const BEAMS = ['inlet_top', 'inlet_bottom', 'outlet'] as const;

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
  it('emits protocol-shaped frames with plausible baseline values', () => {
    const frames = run(new SimRig(1), 60);
    const f = frames[59];
    expect(Object.keys(f)).toEqual([
      'v', 'dev', 'fw', 'seq', 'up_ms', 'inlet_top_c', 'inlet_bottom_c', 'outlet_c', 'echo_us', 'beam_age_s',
      'ref_c', 'reservoir_raw', 'floor_raw', 'pack_v', 'flap', 'valve', 'fan_pct', 'auto', 'flags', 'event',
    ]);
    expect(f).toMatchObject({ v: 1, seq: 59, up_ms: 60000, flap: 'closed', valve: 'closed', fan_pct: [70, 70], auto: true, flags: [], event: null });
    expect('source' in f).toBe(false);
    expect(f.outlet_c!).toBeGreaterThan(30);
    expect(f.outlet_c!).toBeLessThan(32);
    expect(Math.abs(f.inlet_top_c! - 22.5)).toBeLessThan(0.6);
    expect(Math.abs(f.inlet_bottom_c! - 22.5)).toBeLessThan(0.6);
    expect(Math.abs(f.ref_c! - 22.5)).toBeLessThan(0.3);
    expect((f.ref_c! / 0.0625) % 1).toBeCloseTo(0, 6); // DS18B20 resolution
    expect(f.pack_v!).toBeGreaterThan(8.7);
    expect(f.pack_v!).toBeLessThan(9.0);
    expect(f.echo_us.inlet_bottom!).toBeGreaterThan(1025);
    expect(f.echo_us.inlet_bottom!).toBeLessThan(1045);
  });

  it('reports temperatures consistent with the echo over 0.178 m', () => {
    expect(echoUs(22.5)).toBeCloseTo((2 * BEAM_PATH_M) / (331.3 * Math.sqrt(1 + 22.5 / 273.15)) * 1e6, 6);
    expect(tempFromEcho(echoUs(27.3))).toBeCloseTo(27.3, 9);
    for (const f of run(new SimRig(2), 30)) {
      for (const b of BEAMS) expect(tempFromEcho(f.echo_us[b]!)).toBeCloseTo(f[`${b}_c`]!, 1);
    }
  });

  it('refreshes beams round-robin: each beam every ~5 s, held in between', () => {
    const frames = run(new SimRig(3), 61);
    const resets: Record<string, number[]> = { inlet_top: [], inlet_bottom: [], outlet: [] };
    for (let i = 1; i < frames.length; i++) {
      for (const b of BEAMS) {
        const age = frames[i].beam_age_s[b];
        expect(age).toBeLessThanOrEqual(5.05);
        if (age < frames[i - 1].beam_age_s[b]) resets[b].push(i);
        else expect(frames[i][`${b}_c`]).toBe(frames[i - 1][`${b}_c`]); // held value repeats
      }
    }
    for (const b of BEAMS) {
      expect(resets[b].length).toBeGreaterThanOrEqual(11);
      expect(resets[b].length).toBeLessThanOrEqual(13);
    }
    // the beams take turns: they never all refresh in the same frame
    const same = resets.inlet_top.filter((i) => resets.inlet_bottom.includes(i) && resets.outlet.includes(i));
    expect(same).toEqual([]);
  });

  it('flap open with auto off: inlet_top climbs toward the outlet over ~60–90 s, inlet_bottom barely moves', () => {
    const r = new SimRig(4);
    const before = run(r, 30)[29];
    r.command('auto off');
    expect(r.command('flap open')).toBe('ok flap open');
    const after = run(r, 90);
    const at60 = after[59];
    const at90 = after[89];
    expect(at60.inlet_top_c! - before.inlet_top_c!).toBeGreaterThan(4);
    expect(at90.inlet_top_c!).toBeLessThan(at90.outlet_c!);
    expect(Math.abs(at90.inlet_bottom_c! - before.inlet_bottom_c!)).toBeLessThan(0.6);
    expect(after.every((f) => f.flap === 'open' && f.event === null)).toBe(true);
  });

  it('auto mode closes the flap itself when top − bottom ≥ 1.5 °C', () => {
    const r = new SimRig(4);
    run(r, 30);
    r.command('flap open');
    const after = run(r, 30);
    const i = after.findIndex((f) => f.event === 'flap_closed');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(after[i].flap).toBe('closed');
    expect(after[i].inlet_top_c! - after[i].inlet_bottom_c!).toBeGreaterThanOrEqual(1.5);
  });

  it('valve open drains ~8 raw/s; the floor responds after ~6 s; auto closes the valve', () => {
    const r = new SimRig(8);
    r.command('auto off');
    const base = run(r, 10)[9];
    r.command('valve open');
    const after = run(r, 10);
    const rate = (base.reservoir_raw - after[9].reservoir_raw) / 10;
    expect(rate).toBeGreaterThan(7);
    expect(rate).toBeLessThan(9);
    const firstWet = after.findIndex((f) => f.floor_raw > 10);
    expect(firstWet).toBeGreaterThanOrEqual(5);
    expect(firstWet).toBeLessThanOrEqual(8);

    const a = new SimRig(8);
    run(a, 10);
    a.command('valve open');
    const leak = run(a, 30);
    const i = leak.findIndex((f) => f.event === 'valve_closed');
    expect(i).toBeGreaterThan(5);
    expect(leak[i].floor_raw).toBeGreaterThanOrEqual(120);
    const tail = leak.slice(i + 1);
    expect(Math.abs(tail[0].reservoir_raw - tail[tail.length - 1].reservoir_raw)).toBeLessThan(8);
  });

  it('power off: pack ~0.4 V, fans 0, servos cannot move, outlet climbs', () => {
    const r = new SimRig(9);
    const before = run(r, 30)[29];
    expect(r.command('sim power off')).toBe('ok sim power off');
    expect(r.command('flap open')).toMatch(/^err/);
    const after = run(r, 60);
    const f = after[59];
    expect(f.pack_v!).toBeLessThan(0.6);
    expect(f.fan_pct).toEqual([0, 0]);
    expect(f.flap).toBe('closed');
    expect(f.outlet_c! - before.outlet_c!).toBeGreaterThan(10);
    r.command('sim power on');
    expect(r.tick(1).pack_v!).toBeGreaterThan(8.5);
  });

  it('staged faults: inlet_top bias → ref_disagree; blocked outlet → short echo + obstructed', () => {
    const r = new SimRig(10);
    run(r, 10);
    r.command('sim fault inlet_top');
    const f = run(r, 10)[9];
    expect(f.flags).toEqual(expect.arrayContaining(['ref_disagree', 'inlet_top_ref_disagree']));
    expect(f.inlet_top_c! - f.ref_c!).toBeGreaterThan(3);
    expect(Math.abs(f.inlet_bottom_c! - f.ref_c!)).toBeLessThan(1);

    const b = new SimRig(10);
    run(b, 10);
    b.command('sim block outlet');
    const g = run(b, 6)[5];
    expect(g.flags).toContain('outlet_obstructed');
    expect(g.outlet_c).toBeNull();
    expect(g.echo_us.outlet!).toBeLessThan(400);
  });

  it('sim heat high adds ~6 °C to the outlet; fan_a fail raises it with commands unchanged', () => {
    const h = new SimRig(12);
    const base = run(h, 30)[29].outlet_c!;
    h.command('sim heat high');
    expect(run(h, 120)[119].outlet_c! - base).toBeGreaterThan(5);

    const f = new SimRig(12);
    run(f, 30);
    f.command('sim fan_a fail');
    const after = run(f, 120)[119];
    expect(after.fan_pct).toEqual([70, 70]); // no tachometer: the firmware only knows the command
    expect(after.outlet_c! - base).toBeGreaterThan(3);
  });

  it('answers commands like the firmware', () => {
    const r = new SimRig();
    expect(r.command('ping')).toBe('pong');
    expect(r.command('  FLAP   Open ')).toBe('ok flap open');
    expect(r.command('flap close')).toBe('ok flap close');
    expect(r.command('valve open')).toBe('ok valve open');
    expect(r.command('fan 90 10')).toBe('ok fan 70 10'); // firmware PWM cap
    expect(r.tick(1).fan_pct).toEqual([70, 10]);
    expect(r.command('auto off')).toBe('ok auto off');
    expect(r.tick(1).auto).toBe(false);
    expect(r.command('cal')).toMatch(/^ok cal/);
    expect(r.command('make coffee')).toMatch(/^err unknown command/);
  });
});
