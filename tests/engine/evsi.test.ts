/** EVSI scan choice (PREDICTION-SCIENCE.md §5 Design B, §7.5). */
import { describe, expect, it } from 'vitest';
import { facility } from '../../src/domain/fixture';
import { incidentModel } from '../../src/domain/scenarios';
import { runEnsemble, type Ensemble } from '../../src/domain/engine/ensemble';
import { scanEvsi } from '../../src/domain/engine/evsi';

const ensembleFor = (kind: 'sensor' | 'water', pReal: number, options?: number) => {
  const m = incidentModel(kind, pReal);
  const e = runEnsemble({ facility, scenario: m.scenario, t: m.t, options: m.options.slice(0, options), hypotheses: m.hypotheses, hotspot: m.hotspot, leakStartUnknown: m.leakStartUnknown, outer: 192, inner: 4, seed: 9 });
  return { m, e };
};

describe('EVSI', () => {
  it('A-11 with an installed 34.2 °C reading: the A-11 inlet scan ranks first; neighbours are worth 0', () => {
    const { m, e } = ensembleFor('sensor', 0.5);
    const rows = scanEvsi(e, m.scanCandidates, m.evsi);
    expect(rows[0].assetId).toBe('A-11');
    expect(rows[0].evsi).toBeGreaterThan(0);
    for (const r of rows.slice(1)) { expect(r.evsi).toBe(0); expect(r.forecastShift).toBe(0); }
  });

  it('riser leak at T+12: a floor-wet scan ranks above an inlet scan, which tells nothing', () => {
    // Isolating the riser is the best action whatever one floor point shows (EVSI 0 for every scan,
    // honestly); the tie is broken by how far the reading would move P(service down).
    const { m, e } = ensembleFor('water', 0.5);
    const rows = scanEvsi(e, m.scanCandidates, m.evsi);
    const inlet = rows.find((r) => r.metric === 'inlet_temp_c')!;
    expect(inlet.evsi).toBe(0);
    expect(inlet.forecastShift).toBe(0);
    expect(rows[0].metric).toBe('leak');
    expect(rows[0].forecastShift).toBeGreaterThan(0);
    expect(rows.indexOf(inlet)).toBeGreaterThan(rows.indexOf(rows[0]));
    for (const r of rows) expect(r.evsi).toBeGreaterThanOrEqual(0);
  });

  it('is exactly 0 when only one action exists', () => {
    const { m, e } = ensembleFor('sensor', 0.5, 1);
    for (const r of scanEvsi(e, m.scanCandidates, m.evsi)) expect(r.evsi).toBe(0);
  });

  it('matches a brute-force two-hypothesis computation on a toy ensemble', () => {
    // trials 1–2: the water has reached X (wet); 3–4: dry. a0 U = −10, −10, 0, 0; a1 U = −1 everywhere.
    // prior best a1 (−1). wet: a0 −4.75, a1 −0.485 → a1. dry: a0 −0.25, a1 −0.515 → a0. EVSI = 1 − 0.735 = 0.265
    const toy = {
      t: 0, horizonMin: 60, outer: 4, inner: 1, trials: 4, families: [], x: new Float64Array(), u: new Float64Array(), wOuter: Float64Array.from([1, 1, 1, 1]), component: new Int16Array(4),
      options: [{ id: 'a0', label: 'a0' }, { id: 'a1', label: 'a1' }],
      outcomes: [{ U: Float32Array.from([-10, -10, 0, 0]), F: Uint8Array.from([1, 1, 0, 0]) }, { U: Float32Array.from([-1, -1, -1, -1]), F: new Uint8Array(4) }],
      summaries: [], nodeIds: [], rackIds: [], waterAt: new Map([['X', Float32Array.from([0, 0, Infinity, Infinity])]]), tags: new Map(), elapsedMs: 0, seed: 0,
    } as unknown as Ensemble;
    const [r] = scanEvsi(toy, [{ assetId: 'X', metric: 'leak', point: 'p' }]);
    expect(r.bestActionIfNoScan).toBe('a1');
    expect(r.bestActionByOutcome.map((b) => b.action)).toEqual(['a1', 'a0']);
    expect(r.evsi).toBeCloseTo(0.265, 9);
  });
});
