import { describe, expect, it } from 'vitest';
import type { StampedFrame, VibChannel } from '../../src/domain/rig/protocol';
import { summarizeScan, type ScanMeta } from '../../src/domain/rig/scan';
import { Harness, T0, iso } from './helpers';

const vib = (vel: number | null, disp = vel == null ? null : vel / (2 * Math.PI * 25)): VibChannel => ({
  dist_mm: 42, disp_mm: disp, p2p_mm: disp == null ? null : disp * 2.8, freq_hz: vel == null ? null : 25, vel_mm_s: vel, n: 60,
});

/** A synthetic live frame at T0 + i seconds. */
function mk(i: number, o: Partial<StampedFrame> = {}): StampedFrame {
  return {
    v: 2, dev: 'RACKMON-01', fw: '2.0.0', seq: i, up_ms: i * 1000,
    temp_c: 22.5, vib: { fan_a: vib(1.2), fan_b: vib(1.3) }, drip_raw: 0, pack_v: 8.9,
    flap: 'closed', valve: 'closed', fan_pct: [70, 70], auto: true, flags: [], event: null,
    source: 'live', at: iso(T0 + i * 1000),
    ...o,
  };
}

function meta(durS: number, extra: Partial<ScanMeta> = {}): ScanMeta {
  return {
    id: 'scan-1', point: { assetId: 'A-11', point: 'Front inlet · temperature probe' }, operator: 'jayden',
    deviceId: 'RACKMON-01', firmware: '2.0.0', startedAt: iso(T0), endedAt: iso(T0 + durS * 1000), ...extra,
  };
}

const many = (n: number, o: (i: number) => Partial<StampedFrame> = () => ({})) => Array.from({ length: n }, (_, i) => mk(i, o(i)));

describe('summarizeScan — duration and status', () => {
  it('no frames → no_data', () => {
    const s = summarizeScan([], meta(8));
    expect(s.status).toBe('no_data');
    expect(s.frames).toBe(0);
    expect(s.channels).toEqual({});
  });

  it('released before MIN_HOLD_S → too_short', () => {
    const s = summarizeScan(many(4), meta(3.5));
    expect(s.durationS).toBe(3.5);
    expect(s.status).toBe('too_short');
  });

  it('copies meta and point, carries requestId', () => {
    const s = summarizeScan(many(10), meta(10, { requestId: 'req-9' }));
    expect(s).toMatchObject({
      id: 'scan-1', assetId: 'A-11', point: 'Front inlet · temperature probe', operator: 'jayden',
      deviceId: 'RACKMON-01', firmware: '2.0.0', source: 'live', status: 'complete', frames: 10, requestId: 'req-9',
    });
  });
});

describe('summarizeScan — channel statistics', () => {
  it('one sample per frame for every channel', () => {
    const s = summarizeScan(many(10), meta(10));
    expect(s.channels.temp_c).toMatchObject({ n: 10, mean: 22.5, sd: 0, unit: '°C' });
    expect(s.channels.vib_a_mm_s).toMatchObject({ n: 10, mean: 1.2, unit: 'mm/s' });
    expect(s.channels.vib_b_mm_s).toMatchObject({ n: 10, mean: 1.3 });
    expect(s.channels.disp_a_mm?.unit).toBe('mm');
    expect(s.channels.drip_wet).toMatchObject({ n: 10, mean: 0, unit: 'fraction' });
    expect(s.channels.pack_v).toMatchObject({ n: 10, mean: 8.9, unit: 'V' });
  });

  it('fits sample sd and least-squares slope per minute', () => {
    // temp climbs 0.1 °C per frame → 6 °C/min
    const s = summarizeScan(many(10, (i) => ({ temp_c: 22 + i * 0.1 })), meta(10));
    expect(s.channels.temp_c!.slopePerMin).toBeCloseTo(6, 3);
    expect(s.channels.temp_c!.sd).toBeCloseTo(0.303, 2);
  });

  it('ignores nulls and omits channels with no data', () => {
    const s = summarizeScan(many(10, (i) => ({ temp_c: i % 2 ? null : 22.5, vib: { fan_a: vib(null), fan_b: vib(1.3) }, pack_v: null })), meta(10));
    expect(s.channels.temp_c!.n).toBe(5);
    expect(s.channels.vib_a_mm_s).toBeUndefined();
    expect(s.channels.disp_a_mm).toBeUndefined();
    expect(s.channels.vib_b_mm_s!.n).toBe(10);
    expect(s.channels.pack_v).toBeUndefined();
  });

  it('derives the wet fraction from the drip threshold', () => {
    const s = summarizeScan(many(10, (i) => ({ drip_raw: i < 4 ? 300 : 0 })), meta(10));
    expect(s.channels.drip_wet!.mean).toBeCloseTo(0.4, 6);
    const t = summarizeScan(many(10, () => ({ drip_raw: 150 })), meta(10), { dripWetRaw: 200 });
    expect(t.channels.drip_wet!.mean).toBe(0);
  });
});

describe('summarizeScan — quality flags', () => {
  it('a clean live scan has no flags', () => {
    expect(summarizeScan(many(10), meta(10)).quality).toEqual([]);
  });

  it('flags an unsettled probe, a missing probe, firmware sensor flags, pack_low and simulated_device', () => {
    const s = summarizeScan(
      many(10, (i) => ({
        temp_c: 22 + (i % 2) * 1.5,
        flags: i === 3 ? ['fan_a_timeout'] : i === 5 ? ['fan_b_obstructed', 'uncalibrated'] : [],
        pack_v: 5.5,
        source: 'simulated',
      })),
      meta(10),
    );
    expect(s.quality).toEqual(expect.arrayContaining(['simulated_device', 'unsettled_temp', 'vib_timeout_fan_a', 'fan_b_obstructed', 'uncalibrated', 'pack_low']));
    const m = summarizeScan(many(10, () => ({ temp_c: null, flags: ['temp_missing'] })), meta(10));
    expect(m.quality).toContain('temp_missing');
    expect(m.channels.temp_c).toBeUndefined();
  });

  it('summarizes a real 10 s hold from the simulated rig', () => {
    const h = new Harness(7).run(30);
    const frames = h.last(10);
    const s = summarizeScan(frames, meta(10, { startedAt: frames[0].at, endedAt: frames[9].at }));
    expect(s.status).toBe('complete');
    expect(s.source).toBe('simulated');
    expect(s.quality).toContain('simulated_device');
    expect(s.channels.temp_c!.mean).toBeGreaterThan(21);
    expect(s.channels.temp_c!.mean).toBeLessThan(25);
    expect(s.channels.vib_a_mm_s!.mean).toBeGreaterThan(0.8);
    expect(s.channels.vib_a_mm_s!.mean).toBeLessThan(2.8);
    expect(s.channels.drip_wet!.mean).toBe(0);
  });
});
