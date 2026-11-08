import { describe, expect, it } from 'vitest';
import { coverage, firstSignal, perturb, PERTURB, runValidation } from '../../scripts/validate/harness';
import { facility } from '../../src/domain/fixture';
import { getScenario } from '../../src/domain/scenarios';
import { mulberry32 } from '../../src/domain/engine/rng';

describe('validation harness (smoke)', () => {
  it('perturbation fixes every delay to one point and stays non-negative', () => {
    const w = perturb(facility, getScenario('scn-riser-leak'), PERTURB.harsh, mulberry32(3));
    expect(w.facility.edges.every((e) => e.delay.min === e.delay.max && e.delay.min >= 0)).toBe(true);
    expect(w.scenario.leak!.ratePerMin).toBeGreaterThan(0);
    expect(firstSignal(w.scenario)).toBeGreaterThanOrEqual(0);
  });

  it('runs one scenario and returns sane metrics', () => {
    const r = runValidation({ iterations: 5, randomSeeds: 0, perturb: 'default', seed: 1, scenarioIds: ['scn-riser-leak'], modelRuns: 100 });
    expect(r.scenarios).toHaveLength(1);
    const t = r.overall;
    expect(t.realLosses).toBeGreaterThan(0);
    const c = coverage(t);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
    expect(t.inside).toBeLessThanOrEqual(t.scored);
    expect(t.misses).toBeLessThanOrEqual(t.realLosses);
    expect(t.falseAlarms).toBeLessThanOrEqual(t.predictedLosses);
    const f = r.scenarios[0].fix;
    expect(f).not.toBeNull();
    expect(f!.withinTwo).toBeGreaterThanOrEqual(0);
    expect(f!.withinTwo).toBeLessThanOrEqual(1);
  }, 15000);
});
