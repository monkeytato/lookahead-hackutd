/**
 * Live views forecast, they do not replay the script (audit C1). The shared store forecast, the
 * stage remote's model, the honest twin visual, fix savings and the phone summary all use
 * liveForecast: only faults observed or inferable at t.
 */
import { describe, expect, it } from 'vitest';
import { facility, seedReadings } from '../../src/domain/fixture';
import { fixOptionsFor, predictFix, simulateScenario, type FixContext } from '../../src/domain/engine';
import { getScenario } from '../../src/domain/scenarios';
import { hasObservedFault, liveForecast, liveForecastComputeCount, observationKey, topHypotheses } from '../../src/state/liveForecast';
import { honestVisual, visibleClocks } from '../../src/state/selectors';
import { predictionSummary, problemList, summaryLines } from '../../src/stage/remoteModel';
import { phoneFixCommand, phoneSummary, type PhoneDeps } from '../../server/phoneSummary';
import { applyStageCommand, initialStage, type StageState } from '../../src/stage/protocol';
import type { Fix } from '../../src/domain/types';

const SEED = seedReadings();
const leak = getScenario('scn-riser-leak');
const H = leak.horizonMin;
const RACKS = new Set(facility.assets.filter((a) => a.type === 'rack').map((a) => a.id));
/** What the store computes for its `forecast` field. */
const storeForecast = (t: number, fixes: Fix[] = []) => liveForecast({ facility, scenario: leak, seedReadings: SEED, t, fixes, extraEdges: [] });
const world = simulateScenario({ facility, scenario: leak, seedReadings: SEED });
const leakClocks = (r: ReturnType<typeof storeForecast>) => Object.values(r.clocks).filter((c) => c.p50 !== null && c.path[0] === 'PIPE-L2');

const T0 = 1_800_000_000_000;
const at = (t: number, s: StageState = initialStage('scn-riser-leak', T0)): StageState => applyStageCommand(s, { type: 'seek', t }, H, T0);
const deps: PhoneDeps = { latestFrame: () => null, deviceMode: () => 'disconnected', director: { configured: false, model: 'local' } };

describe('shared store forecast (riser leak)', () => {
  it('T+0 and T+4: no leak clocks, nothing to forecast; T+11 and later: leak clocks', () => {
    for (const t of [0, 4]) {
      const f = storeForecast(t);
      expect(leakClocks(f)).toEqual([]);
      expect(Object.values(f.clocks).filter((c) => c.p50 !== null)).toEqual([]);
      expect(f.water).toBeUndefined();
      expect(hasObservedFault(f, t)).toBe(false);
    }
    for (const t of [11, 14, 30]) {
      const f = storeForecast(t);
      expect(leakClocks(f).length).toBeGreaterThan(0);
      expect(hasObservedFault(f, t)).toBe(true);
    }
    // the world still has the leak from T+4: that is what happens, not what anyone could predict
    expect(Object.values(world.clocks).some((c) => c.path[0] === 'PIPE-L2' && c.p50 !== null)).toBe(true);
  });

  it('is memoised on the observation state, not on t', () => {
    const before = liveForecastComputeCount();
    const runs = new Set<unknown>();
    for (let t = 0; t <= H; t = Math.round((t + 0.2) * 10) / 10) runs.add(storeForecast(t));
    // nothing observed → leak inferable (T+11) → CRAH-2 trip observed (T+34)
    expect(runs.size).toBe(3);
    expect(liveForecastComputeCount() - before).toBeLessThanOrEqual(3);
    expect(storeForecast(5)).toBe(storeForecast(10.9));
    expect(observationKey(facility, leak, 11)).toBe(observationKey(facility, leak, 33.9));
    expect(observationKey(facility, leak, 33.9)).not.toBe(observationKey(facility, leak, 34));
  });

  it('honest visual: no clock, lost or wet state from the unobserved leak before T+11', () => {
    for (const t of [0, 4, 8]) {
      const v = honestVisual(world, leak, t, t, storeForecast(t));
      expect(Object.values(v).filter((x) => x.clockMin !== undefined)).toEqual([]);
      expect(v['PIPE-L2'].lost).toBe(false);
      expect(Object.values(v).some((x) => x.wet)).toBe(false);
    }
    const v = honestVisual(world, leak, 14, 14, storeForecast(14));
    expect(Object.values(v).some((x) => x.clockMin !== undefined)).toBe(true);
    expect(Object.values(v).some((x) => x.wet)).toBe(true);
  });
});

describe('stage remote model on the forecast', () => {
  it('T+0 and T+4: no next loss, watching; T+12: a next loss and racks at risk', () => {
    for (const t of [0, 4]) {
      const f = storeForecast(t);
      const p = predictionSummary(f, t, 20, H);
      expect(p.nextLoss).toBeNull();
      expect(p.nextRackLoss).toBeNull();
      expect(p.racksLostByEnd).toBe(0);
      expect(summaryLines(p, t, 20, hasObservedFault(f, t))[0]).toBe('No observed fault · watching.');
      expect(problemList([], f, t)).toEqual([]);
    }
    const f = storeForecast(12);
    const p = predictionSummary(f, 12, 20, H);
    expect(p.nextLoss).not.toBeNull();
    expect(p.racksLostByEnd).toBeGreaterThan(0);
    expect(problemList([], f, 12).length).toBeGreaterThan(0);
    // the script replay would have counted down to the unobserved riser at T+0 (the old behaviour)
    expect(predictionSummary(world, 0, 0, H).nextLoss).not.toBeNull();
  });

  it('lists the scripted faults the forecast leaves out, with priors', () => {
    const hs = topHypotheses(facility, leak, 0);
    expect(hs.map((h) => h.assetId)).toEqual(expect.arrayContaining(['PIPE-L2', 'CRAH-2']));
    for (const h of hs) expect(h.prior).toBeGreaterThan(0);
    expect(topHypotheses(facility, leak, 40).map((h) => h.assetId)).toEqual([]);
  });
});

describe('fix savings in forecast mode', () => {
  const ctx = (t: number, fixes: Fix[] = []): FixContext => ({ facility, scenario: leak, seedReadings: SEED, fixes, t, run: storeForecast(t, fixes), mode: 'forecast' });

  it('no riser fix is offered before the leak is inferable; once it is, isolating saves racks', () => {
    expect(fixOptionsFor(ctx(4), 'PIPE-L2')).toEqual([]);
    const opt = fixOptionsFor(ctx(12), 'PIPE-L2').find((o) => o.action === 'isolate_valve');
    expect(opt).toBeTruthy();
    const p = predictFix(ctx(12), opt!);
    expect(p.racksWithout).toBe(Object.values(storeForecast(12).clocks).filter((c) => RACKS.has(c.assetId) && c.p50 !== null).length);
    expect(p.racksWithout - p.racksWith).toBeGreaterThan(0);
  });
});

describe('phone summary agrees with the store forecast', () => {
  it('forecast block and clocks match liveForecast at T+0, T+4, T+12, T+20, T+40', () => {
    for (const t of [0, 4, 12, 20, 40]) {
      const p = phoneSummary(at(t), T0, deps);
      const f = storeForecast(t);
      const racks = Object.values(f.clocks).filter((c) => RACKS.has(c.assetId) && c.p50 !== null);
      const s = predictionSummary(f, t, 0, H);
      expect(p.forecast.racksAtRisk).toBe(racks.filter((c) => c.p50! > t).length);
      expect(p.forecast.racksLost).toBe(racks.filter((c) => c.p50! <= t).length);
      expect(p.forecast.firstRackLossIn).toBe(s.nextRackLoss ? Math.round((s.nextRackLoss.at - t) * 10) / 10 : null);
      const top = visibleClocks(f.clocks, leak, t).filter((c) => c.p50 !== null && c.p50 > t).slice(0, 3).map((c) => c.assetId);
      expect(p.clocks.map((c) => c.assetId)).toEqual(top);
    }
    const early = phoneSummary(at(4), T0, deps);
    expect(early.clocks).toEqual([]);
    expect(early.forecast.firstRackLossIn).toBeNull();
    expect(early.forecast.racksAtRisk).toBe(0);
  });

  it('fix savings on the phone equal predictFix in forecast mode, and the fix intent is accepted', () => {
    const s = at(14);
    const offered = phoneSummary(s, T0, deps).problems.find((x) => x.id === 'INC-1044')!.fixes.find((x) => x.action === 'isolate_valve')!;
    const c: FixContext = { facility, scenario: leak, seedReadings: SEED, fixes: [], t: 14, run: storeForecast(14), mode: 'forecast' };
    const p = predictFix(c, fixOptionsFor(c, 'PIPE-L2').find((o) => o.action === 'isolate_valve')!);
    expect(offered.savesRacks).toBe(Math.max(0, p.racksWithout - p.racksWith));
    expect(offered.savesRacks).toBeGreaterThan(0);
    expect(phoneFixCommand(at(4), T0, { assetId: 'PIPE-L2', action: 'isolate_valve' }).ok).toBe(false);
    expect(phoneFixCommand(s, T0, { assetId: 'PIPE-L2', action: 'isolate_valve' }).ok).toBe(true);
  });
});
