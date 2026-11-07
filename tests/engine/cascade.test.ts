import { describe, expect, it } from 'vitest';
import { runCascade } from '../../src/domain/engine';
import { facility } from '../../src/domain/fixture';
import type { DependencyEdge } from '../../src/domain/types';

const racks = facility.assets.filter((a) => a.type === 'rack').map((a) => a.id);

describe('runCascade redundancy', () => {
  it('losing CH-1 alone does not lose racks', () => {
    const c = runCascade(facility, [{ assetId: 'CH-1', t: 0 }], { horizonMin: 60 });
    expect(c['CH-1'].p50).toBe(0);
    expect(c['P-1']).toBeUndefined();
    for (const r of racks) expect(c[r]).toBeUndefined();
  });

  it('losing CH-1 and CH-2 loses racks within the horizon', () => {
    const c = runCascade(facility, [{ assetId: 'CH-1', t: 0 }, { assetId: 'CH-2', t: 0 }], { horizonMin: 60 });
    expect(c['P-1'].probWithinHorizon).toBe(1);
    const a01 = c['A-01'];
    expect(a01.probWithinHorizon).toBeGreaterThan(0.9);
    expect(a01.p50).not.toBeNull();
    expect(a01.p10!).toBeLessThanOrEqual(a01.p50!);
    expect(a01.p50!).toBeLessThanOrEqual(a01.p90 ?? Infinity);
    expect(a01.path[0]).toMatch(/^CH-/);
    expect(a01.path.at(-1)).toBe('A-01');
    expect(a01.weakestAssumption).toBeTruthy();
  });

  it('UTIL + GEN-1 fault drains batteries and loses PDUs after ~autonomy', () => {
    const c = runCascade(facility, [{ assetId: 'UTIL', t: 2 }, { assetId: 'GEN-1', t: 2 }], { horizonMin: 60 });
    expect(c['ATS-1'].p50!).toBeGreaterThanOrEqual(2);
    expect(c['ATS-1'].p50!).toBeLessThanOrEqual(2.5);
    // BATT-A autonomy 8–18 min, BATT-B 6–15 min after the ATS loses its sources
    expect(c['BATT-A'].p10!).toBeGreaterThanOrEqual(2 + 8);
    expect(c['BATT-A'].p90!).toBeLessThanOrEqual(2.5 + 18);
    expect(c['PDU-A1'].p50).toBeCloseTo(c['BATT-A'].p50!, 5);
    expect(c['PDU-B1'].p50).toBeCloseTo(c['BATT-B'].p50!, 5);
    expect(c['PDU-A1'].p50!).toBeGreaterThan(10);
    expect(c['PDU-A1'].path).toEqual(expect.arrayContaining(['ATS-1', 'BATT-A', 'UPS-A', 'PDU-A1']));
  });

  it('B-07 (single-corded) is lost with PDU-A1 but dual-corded A-01 is not', () => {
    const c = runCascade(facility, [{ assetId: 'PDU-A1', t: 5 }], { horizonMin: 60 });
    expect(c['B-07'].p50).toBe(5);
    expect(c['B-07'].path).toEqual(['PDU-A1', 'B-07']);
    expect(c['A-01']).toBeUndefined();
  });
});

describe('runCascade determinism and options', () => {
  const faults = [{ assetId: 'UTIL', t: 2 }, { assetId: 'GEN-1', t: 2 }];
  it('same seed gives identical clocks; different seed differs', () => {
    const a = runCascade(facility, faults, { horizonMin: 60, seed: 11 });
    const b = runCascade(facility, faults, { horizonMin: 60, seed: 11 });
    const d = runCascade(facility, faults, { horizonMin: 60, seed: 12 });
    expect(a).toEqual(b);
    expect(a['BATT-A'].p50).not.toBe(d['BATT-A'].p50);
  });

  it('A05: unconfirmed PIPE-L2 → BATT-B edge is ignored unless passed in extraEdges', () => {
    const without = runCascade(facility, [{ assetId: 'PIPE-L2', t: 4 }], { horizonMin: 60 });
    expect(without['BATT-B']).toBeUndefined();
    const candidate = facility.edges.find((e) => e.from === 'PIPE-L2' && e.to === 'BATT-B')!;
    expect(candidate.confirmed).toBe(false);
    const opted: DependencyEdge = { ...candidate };
    const withEdge = runCascade(facility, [{ assetId: 'PIPE-L2', t: 4 }], { horizonMin: 60, extraEdges: [opted] });
    const bb = withEdge['BATT-B'];
    expect(bb).toBeDefined();
    expect(bb.probWithinHorizon).toBeGreaterThan(0.3);
    expect(bb.probWithinHorizon).toBeLessThan(1);
    expect(bb.p10!).toBeGreaterThanOrEqual(24);
    expect(bb.path).toEqual(['PIPE-L2', 'BATT-B']);
    expect(bb.weakestAssumption).toContain('candidate');
  });

  it('p90 is null when the node is lost in fewer than 90 % of runs', () => {
    const candidate = facility.edges.find((e) => e.from === 'PIPE-L2' && e.to === 'BATT-B')!;
    const c = runCascade(facility, [{ assetId: 'PIPE-L2', t: 4 }], { horizonMin: 40, extraEdges: [candidate] });
    expect(c['BATT-B'].probWithinHorizon).toBeLessThan(0.9);
    expect(c['BATT-B'].p90).toBeNull();
  });
});
