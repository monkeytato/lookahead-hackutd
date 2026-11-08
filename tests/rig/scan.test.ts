import { describe, expect, it } from 'vitest';
import type { StampedFrame } from '../../src/domain/rig/protocol';
import { summarizeScan, type ScanMeta } from '../../src/domain/rig/scan';
import { Harness, T0, iso } from './helpers';

/** A synthetic live frame at T0 + i seconds; every beam refreshed in the same frame unless overridden. */
function mk(i: number, o: Partial<StampedFrame> = {}): StampedFrame {
  return {
    v: 1, dev: 'RACKMON-01', fw: '1.0.0', seq: i, up_ms: i * 1000,
    inlet_top_c: 22.5, inlet_bottom_c: 22.5, outlet_c: 31,
    echo_us: { inlet_top: 1033, inlet_bottom: 1033, outlet: 1018 },
    beam_age_s: { inlet_top: 0.1, inlet_bottom: 0.1, outlet: 0.1 },
    ref_c: 22.5, reservoir_raw: 540, floor_raw: 0, pack_v: 8.9,
    flap: 'closed', valve: 'closed', fan_pct: [70, 70], auto: true, flags: [], event: null,
    source: 'live', at: iso(T0 + i * 1000),
    ...o,
  };
}

/** Ages for a beam that refreshes every 5 frames, starting fresh at frame 0. */
const age5 = (i: number) => (i % 5) + 0.2;

function meta(durS: number, extra: Partial<ScanMeta> = {}): ScanMeta {
  return {
    id: 'scan-1', point: { assetId: 'A-11', point: 'Front inlet, both beams' }, operator: 'jayden',
    deviceId: 'RACKMON-01', firmware: '1.0.0', startedAt: iso(T0), endedAt: iso(T0 + durS * 1000), ...extra,
  };
}

/** n frames where all three beams refresh every 5 frames with the given value per cycle. */
function cycled(n: number, value: (cycle: number) => number, o: (i: number) => Partial<StampedFrame> = () => ({})): StampedFrame[] {
  return Array.from({ length: n }, (_, i) => {
    const v = value(Math.floor(i / 5));
    return mk(i, {
      inlet_top_c: v, inlet_bottom_c: v, outlet_c: v + 8.5,
      beam_age_s: { inlet_top: age5(i), inlet_bottom: age5(i), outlet: age5(i) },
      ...o(i),
    });
  });
}

describe('summarizeScan — duration and status', () => {
  it('no frames → no_data', () => {
    const s = summarizeScan([], meta(8));
    expect(s.status).toBe('no_data');
    expect(s.frames).toBe(0);
    expect(s.channels).toEqual({});
  });

  it('released before MIN_HOLD_S → too_short', () => {
    const s = summarizeScan([mk(0), mk(1), mk(2), mk(3)], meta(3.5));
    expect(s.durationS).toBe(3.5);
    expect(s.status).toBe('too_short');
    expect(s.quality).not.toContain('fewer_than_two_cycles');
  });

  it('copies meta and point, carries requestId', () => {
    const s = summarizeScan(cycled(10, () => 22.5), meta(10, { requestId: 'req-9' }));
    expect(s).toMatchObject({
      id: 'scan-1', assetId: 'A-11', point: 'Front inlet, both beams', operator: 'jayden',
      deviceId: 'RACKMON-01', firmware: '1.0.0', durationS: 10, frames: 10, status: 'complete',
      source: 'live', requestId: 'req-9',
    });
    expect(summarizeScan(cycled(10, () => 22.5), meta(10))).not.toHaveProperty('requestId');
  });
});

describe('summarizeScan — channel statistics', () => {
  it('de-duplicates held acoustic values by beam_age_s', () => {
    // 10 frames, two real averages per beam (30 then 31 for the outlet); the rest are repeats
    const frames = cycled(10, (c) => (c === 0 ? 21.5 : 22.5));
    const s = summarizeScan(frames, meta(10));
    const out = s.channels.outlet_c!;
    expect(out.n).toBe(2);
    expect(out.mean).toBe(30.5);
    expect(out.min).toBe(30);
    expect(out.max).toBe(31);
    expect(out.sd).toBeCloseTo(Math.SQRT1_2, 3);
    expect(out.unit).toBe('°C');
    // non-acoustic channels use every frame
    expect(s.channels.ref_c!.n).toBe(10);
    expect(s.channels.pack_v!.n).toBe(10);
  });

  it('treats a gap longer than a beam cycle as a new average even without a visible reset', () => {
    const frames = [
      mk(0, { outlet_c: 30, beam_age_s: { inlet_top: 1, inlet_bottom: 1, outlet: 1 } }),
      mk(1, { outlet_c: 30, beam_age_s: { inlet_top: 2, inlet_bottom: 2, outlet: 2 } }),
      // 7 s later, age 3 → refreshed 4 s after the previous one; same value by coincidence
      mk(8, { outlet_c: 30, beam_age_s: { inlet_top: 3, inlet_bottom: 3, outlet: 3 } }),
    ];
    expect(summarizeScan(frames, meta(8)).channels.outlet_c!.n).toBe(2);
  });

  it('fits sample sd and least-squares slope per minute', () => {
    const frames = Array.from({ length: 11 }, (_, i) => mk(i, { ref_c: 22 + 0.01 * i }));
    const ref = summarizeScan(frames, meta(10)).channels.ref_c!;
    expect(ref.slopePerMin).toBeCloseTo(0.6, 6);
    expect(ref.mean).toBeCloseTo(22.05, 6);
    expect(ref.sd).toBeCloseTo(0.0332, 3);
  });

  it('ignores nulls and omits channels with no data', () => {
    const frames = Array.from({ length: 6 }, (_, i) => mk(i, { pack_v: null, ref_c: i < 3 ? null : 22.4 }));
    const s = summarizeScan(frames, meta(6));
    expect(s.channels.pack_v).toBeUndefined();
    expect(s.channels.ref_c!.n).toBe(3);
  });

  it('derives delta_t, reservoir % (clamped) and floor_wet fraction', () => {
    const frames = Array.from({ length: 10 }, (_, i) =>
      mk(i, {
        inlet_top_c: 24, inlet_bottom_c: 22, outlet_c: i === 0 ? null : 31,
        reservoir_raw: i < 5 ? 300 : 660, floor_raw: i < 6 ? 5 : 200,
      }),
    );
    const s = summarizeScan(frames, meta(10));
    expect(s.channels.delta_t_c).toMatchObject({ n: 9, mean: 8, unit: '°C' });
    expect(s.channels.reservoir_pct).toMatchObject({ min: 50, max: 100, mean: 75, unit: '%' });
    expect(s.channels.floor_wet).toMatchObject({ n: 10, mean: 0.4, min: 0, max: 1, unit: 'fraction' });
    // custom calibration
    const c = summarizeScan(frames, meta(10), { reservoirFullRaw: 1000, floorWetRaw: 250 });
    expect(c.channels.reservoir_pct!.max).toBe(66);
    expect(c.channels.floor_wet!.mean).toBe(0);
  });
});

describe('summarizeScan — quality flags', () => {
  it('a clean live scan has no flags', () => {
    expect(summarizeScan(cycled(10, () => 22.5), meta(10)).quality).toEqual([]);
  });

  it('flags acoustic_ref_disagree when inlet_bottom and the DS18B20 differ by > 2 °C', () => {
    const frames = cycled(10, () => 22.5, () => ({ inlet_bottom_c: 25.1, ref_c: 22.6 }));
    const q = summarizeScan(frames, meta(10)).quality;
    expect(q).toContain('acoustic_ref_disagree');
    const ok = cycled(10, () => 22.5, () => ({ inlet_bottom_c: 24.0, ref_c: 22.6 }));
    expect(summarizeScan(ok, meta(10)).quality).not.toContain('acoustic_ref_disagree');
  });

  it('flags unsettled channels, firmware beam flags, pack_low and simulated_device', () => {
    const frames = cycled(15, (c) => 22.5 + c * 1.0, (i) => ({
      flags: i === 3 ? ['inlet_top_timeout'] : i === 7 ? ['outlet_obstructed'] : [],
      pack_v: 5.2,
      source: i === 0 ? 'simulated' : 'live',
    }));
    const s = summarizeScan(frames, meta(15));
    expect(s.source).toBe('simulated');
    expect(s.quality).toEqual(expect.arrayContaining([
      'simulated_device', 'unsettled_inlet_top', 'unsettled_inlet_bottom', 'unsettled_outlet',
      'beam_timeout_inlet_top', 'outlet_obstructed', 'pack_low',
    ]));
    expect(s.quality).not.toContain('unsettled_ref');
    expect(s.quality).not.toContain('fewer_than_two_cycles');
  });

  it('flags fewer_than_two_cycles when a complete scan has a beam with n < 2', () => {
    const frames = cycled(6, () => 22.5).slice(0, 5); // ages 0.2..4.2: one average per beam
    const s = summarizeScan(frames, meta(5.5));
    expect(s.status).toBe('complete');
    expect(s.channels.outlet_c!.n).toBe(1);
    expect(s.quality).toContain('fewer_than_two_cycles');
  });

  it('summarizes a real 10 s hold from the simulated rig', () => {
    const h = new Harness(3).run(20);
    const frames = h.last(10);
    const s = summarizeScan(frames, { ...meta(10), startedAt: frames[0].at, endedAt: h.now });
    expect(s.status).toBe('complete');
    expect(s.quality).toContain('simulated_device');
    expect(s.quality).not.toContain('acoustic_ref_disagree');
    for (const ch of ['inlet_top_c', 'inlet_bottom_c', 'outlet_c'] as const) {
      expect(s.channels[ch]!.n).toBeGreaterThanOrEqual(2);
      expect(s.channels[ch]!.n).toBeLessThanOrEqual(3);
    }
    expect(s.channels.outlet_c!.mean).toBeGreaterThan(30);
    expect(s.channels.outlet_c!.mean).toBeLessThan(32);
    expect(s.channels.ref_c!.n).toBe(10);
  });
});

describe('optional qualitative vibration detector', () => {
  it('reports detection fraction only when firmware actually supplies the channel', () => {
    const frames = cycled(10, () => 22.5);
    const absent = summarizeScan(frames, meta(10));
    expect(absent.channels.vibration_detected).toBeUndefined();
    const present = summarizeScan(frames.map((f, i) => ({ ...f, vibrating: i % 2 === 0 })), meta(10));
    expect(present.channels.vibration_detected?.n).toBe(frames.length);
    expect(present.channels.vibration_detected?.mean).toBeCloseTo(Math.ceil(frames.length / 2) / frames.length, 2);
    expect(present.channels.vibration_detected?.unit).toBe('fraction');
  });
});
