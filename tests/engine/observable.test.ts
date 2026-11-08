/** Audit C1: a forecast at t uses only what is observed or inferable by t. */
import { describe, expect, it } from 'vitest';
import { facility, seedReadings } from '../../src/domain/fixture';
import { forecastScenario, scriptedHypotheses, simulateScenario } from '../../src/domain/engine';
import { getScenario, listScenarios } from '../../src/domain/scenarios';
import { mulberry32 } from '../../src/domain/engine/rng';
import type { Scenario } from '../../src/domain/types';

const forecast = (s: Scenario, t: number, hypotheses: string[] = []) =>
  simulateScenario({ facility, scenario: s, seedReadings: seedReadings(), runs: 80, mode: 'forecast', forecastAt: t, hypotheses });
const clocksOf = (r: ReturnType<typeof simulateScenario>) => JSON.stringify(Object.values(r.clocks).map((c) => [c.assetId, c.p10, c.p50, c.p90]).sort());

describe('no foreknowledge (forecast mode)', () => {
  const leak = getScenario('scn-riser-leak');

  it('riser leak at T+0: no leak clocks, nothing lost (the leak is unobserved)', () => {
    const r = forecast(leak, 0);
    expect(r.water).toBeUndefined();
    expect(Object.keys(r.waterArrival)).toEqual([]);
    expect(Object.values(r.clocks).filter((c) => c.p50 !== null)).toEqual([]);
    // the script run (the world) does lose racks — that is the scenario, not a prediction
    const script = simulateScenario({ facility, scenario: leak, seedReadings: seedReadings(), runs: 80 });
    expect(Object.values(script.clocks).some((c) => c.p50 !== null)).toBe(true);
  });

  it('riser leak at T+4 (leak started, not inferable) still has no leak clocks; at T+11 it does', () => {
    expect(Object.keys(forecast(leak, 4).waterArrival)).toEqual([]);
    const at11 = forecast(leak, 11);
    expect(Object.keys(at11.waterArrival).length).toBeGreaterThan(0);
    expect(at11.assumedFaults.some((f) => f.assetId === 'PIPE-L2' && f.basis === 'observed')).toBe(true);
  });

  it('future scripted faults become hypotheses with priors, and are not in the forecast unless opted in', () => {
    const hs = scriptedHypotheses(facility, leak, 12);
    const crah = hs.find((h) => h.assetId === 'CRAH-2')!;
    expect(crah.prior).toBeCloseTo(0.02, 5); // precursor vibration alarm at T+1 → assumption prior
    expect(crah.basisKind).toBe('assumption');
    const fc = forecastScenario(facility, leak, 12);
    expect(fc.scenario.faults.some((f) => f.assetId === 'CRAH-2')).toBe(false);
    const opted = forecastScenario(facility, leak, 12, [crah.id]);
    expect(opted.scenario.faults).toContainEqual({ assetId: 'CRAH-2', t: 34 });
    expect(opted.assumed.find((a) => a.assetId === 'CRAH-2')?.basis).toBe('hypothesis');
  });

  it('chiller what-if: CH-2 at T+12 is a published-rate hypothesis at T+2', () => {
    const h = scriptedHypotheses(facility, getScenario('scn-chiller-trip'), 2).find((x) => x.assetId === 'CH-2')!;
    expect(h.basisKind).toBe('published');
    expect(h.prior).toBeGreaterThan(1e-5);
    expect(h.prior).toBeLessThan(1e-4); // 3.87e-5/h × 58/60 h
  });

  it('property: a forecast at t is invariant to unobserved future faults', () => {
    const rand = mulberry32(42);
    const ids = facility.assets.filter((a) => a.type !== 'rack').map((a) => a.id);
    const scenarios = [...listScenarios().map((x) => getScenario(x.id)), getScenario('rnd-7a1'), getScenario('rnd-k3x9')];
    for (const s of scenarios) {
      for (const t of [0, 5, 15]) {
        const extra = Array.from({ length: 3 }, () => ({ assetId: ids[Math.floor(rand() * ids.length)], t: t + 1 + Math.round(rand() * (s.horizonMin - t - 2)) }));
        // no observable step for the added faults before t (they are strictly in the future)
        const more: Scenario = { ...s, faults: [...s.faults, ...extra] };
        expect(clocksOf(forecast(more, t))).toBe(clocksOf(forecast(s, t)));
        // and removing the scenario's own future faults does not change it either
        const fewer: Scenario = { ...s, faults: s.faults.filter((f) => f.t <= t) };
        expect(clocksOf(forecast(fewer, t))).toBe(clocksOf(forecast(s, t)));
      }
    }
  });
});
