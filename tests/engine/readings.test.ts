import { describe, expect, it } from 'vitest';
import { compareReadings, freshness, inletTempAt, latestReadings, severityFor } from '../../src/domain/engine';
import { referenceFixtures, seedReadings, thresholds } from '../../src/domain/fixture';
import type { Reading } from '../../src/domain/types';

const mk = (p: Partial<Reading>): Reading => ({ id: 'R-x', assetId: 'A-10', metric: 'inlet_temp_c', value: 22, unit: '°C', t: 0, source: 'installed', expectedIntervalMin: 5, ...p });
const ref = (key: string, t: number): Reading => ({ ...referenceFixtures[key], id: `REF-${key}-${t}`, t });

describe('freshness (A03)', () => {
  it('missing / stale / fresh', () => {
    expect(freshness(undefined, 10)).toBe('missing');
    expect(freshness(mk({ t: 0 }), 10)).toBe('fresh'); // exactly 2× interval is still fresh
    expect(freshness(mk({ t: 0 }), 10.5)).toBe('stale');
  });
  it('row C seed sensors are stale at t=0, row A fresh', () => {
    const rs = seedReadings();
    const c08 = rs.find((r) => r.assetId === 'C-08' && r.metric === 'inlet_temp_c')!;
    const a01 = rs.find((r) => r.assetId === 'A-01' && r.metric === 'inlet_temp_c')!;
    expect(freshness(c08, 0)).toBe('stale');
    expect(freshness(a01, 0)).toBe('fresh');
  });
});

describe('severityFor / latestReadings', () => {
  it('is direction aware', () => {
    expect(severityFor('inlet_temp_c', 34.2, thresholds)).toBe('critical');
    expect(severityFor('inlet_temp_c', 28, thresholds)).toBe('warning');
    expect(severityFor('inlet_temp_c', 22, thresholds)).toBe('normal');
    expect(severityFor('ups_autonomy_min', 4, thresholds)).toBe('critical');
    expect(severityFor('ups_autonomy_min', 8, thresholds)).toBe('warning');
    expect(severityFor('ups_autonomy_min', 13, thresholds)).toBe('normal');
    expect(severityFor('leak', 1, thresholds)).toBe('critical');
    expect(severityFor('leak', 0, thresholds)).toBe('normal');
    expect(severityFor('flow_lpm', 999, thresholds)).toBe('normal');
  });
  it('latest per key at or before now', () => {
    const rs = seedReadings();
    const a11 = latestReadings(rs, 0).filter((r) => r.assetId === 'A-11' && r.metric === 'inlet_temp_c');
    expect(a11).toHaveLength(1);
    expect(a11[0].value).toBe(34.2);
    expect(latestReadings(rs, -1).find((r) => r.assetId === 'A-11')!.value).not.toBe(34.2);
    expect(latestReadings(rs, 0, ['reference_probe'])).toHaveLength(0);
  });
});

describe('compareReadings (A04)', () => {
  const ctx = { now: 12, thresholds };
  const banned = /broken|faulty|fail|safe/i;

  it('corroborated_abnormal: CRAH-2 vibration 6.4 vs probe 6.6', () => {
    const r = compareReadings(mk({ assetId: 'CRAH-2', metric: 'vibration_mm_s', value: 6.4, unit: 'mm/s', t: 1, expectedIntervalMin: 15 }), [ref('CRAH-2', 11)], ctx);
    expect(r.verdict).toBe('corroborated_abnormal');
    expect(r.rationale).not.toMatch(banned);
  });

  it('measurement_disagreement: A-11 34.2 vs probe 24.1 does not claim sensor failure', () => {
    const r = compareReadings(mk({ assetId: 'A-11', value: 34.2, t: 10 }), [ref('A-11', 11)], ctx);
    expect(r.verdict).toBe('measurement_disagreement');
    expect(r.rationale).not.toMatch(banned);
    expect(r.rationale).toMatch(/does not show which measurement is wrong/);
  });

  it('inconclusive: stale reference, asset/metric mismatch, or no reference', () => {
    const inst = mk({ assetId: 'A-11', value: 34.2 });
    const stale = compareReadings(inst, [ref('A-11', 0)], { now: 30, thresholds });
    expect(stale.verdict).toBe('inconclusive');
    expect(stale.qualityFlags).toContain('reference_stale');
    expect(compareReadings(inst, [ref('CRAH-2', 11)], ctx).verdict).toBe('inconclusive');
    expect(compareReadings(inst, [], ctx).verdict).toBe('inconclusive');
    const mm = compareReadings(inst, [{ ...ref('A-11', 11), metric: 'humidity_rh' }], ctx);
    expect(mm.verdict).toBe('inconclusive');
    expect(mm.qualityFlags).toContain('metric_mismatch');
  });

  it('not_corroborated_in_session: both normal, without clearing the equipment', () => {
    const r = compareReadings(mk({ assetId: 'A-11', value: 23.5, t: 10 }), [ref('A-11', 11)], ctx);
    expect(r.verdict).toBe('not_corroborated_in_session');
    expect(r.rationale).not.toMatch(banned);
  });
});

describe('inletTempAt', () => {
  it('flat before loss, first-order rise after', () => {
    expect(inletTempAt(22, 10, null, 50)).toBe(22);
    expect(inletTempAt(22, 10, 20, 10)).toBe(22);
    const tau = 2 + 24 / 10; // audit: retuned so the thermal trend agrees with the cascade ride-through
    expect(inletTempAt(22, 10, 20, 20 + tau)).toBeCloseTo(22 + 30 * (1 - Math.exp(-1)), 5);
    expect(inletTempAt(22, 10, 0, 1000)).toBeCloseTo(52, 3); // ΔTmax capped at 30 °C
    expect(inletTempAt(22, 6, 0, 1000)).toBeCloseTo(40, 3);  // 3 °C per kW below the cap
    expect(inletTempAt(22, 31, 0, 5)).toBeGreaterThan(inletTempAt(22, 8, 0, 5));
  });

  it('agrees with the cascade: a 6 kW rack passes the 32 °C allowable limit near the 6-min ride-through mode', () => {
    expect(inletTempAt(22, 6, 0, 3)).toBeLessThan(32);       // 3 min: warning band
    expect(inletTempAt(22, 6, 0, 3)).toBeGreaterThan(27);
    expect(inletTempAt(22, 6, 0, 6)).toBeGreaterThan(32);    // 6 min: past allowable
    expect(inletTempAt(22, 31, 0, 2)).toBeGreaterThan(32);   // liquid-cooled GPU rack: ~2 min
  });
});
