import { describe, expect, it } from 'vitest';
import {
  fixOptionsFor, makeFix, predictFix, predictionSummary, runCascade, simulateScenario, simulateWater,
} from '../../src/domain/engine';
import { facility, scenarios, seedReadings } from '../../src/domain/fixture';
import { getScenario } from '../../src/domain/scenarios';
import type { Fix, Scenario } from '../../src/domain/types';

const scn = (id: string) => scenarios.find((s) => s.id === id)!;
const run = (scenario: Scenario, fixes: Fix[] = [], runs = 200) => simulateScenario({ facility, scenario, seedReadings: seedReadings(), fixes, runs });
const fix = (assetId: string, effectiveAt: number, action: Fix['action'] = 'manual_gen_start'): Fix => ({ id: `F-${assetId}-${effectiveAt}`, assetId, action, label: 'test', orderedAt: effectiveAt - 1, effectiveAt });
const racksLost = (r: ReturnType<typeof run>) => Object.values(r.clocks).filter((c) => c.assetId.match(/^[A-D]-\d\d$/) && c.p50 !== null).length;

describe('cascade with fixes', () => {
  const gen = scn('scn-gen-nostart');
  const faults = gen.faults;

  it('no fixes (or an empty list) gives exactly the old clocks', () => {
    const a = runCascade(facility, faults, { horizonMin: 60, runs: 150 });
    const b = runCascade(facility, faults, { horizonMin: 60, runs: 150, fixes: [] });
    expect(b).toEqual(a);
  });

  it('starting the generator before the batteries drain saves the racks', () => {
    const base = runCascade(facility, faults, { horizonMin: 60, runs: 200 });
    const fixed = runCascade(facility, faults, { horizonMin: 60, runs: 200, fixes: [{ assetId: 'GEN-1', t: 6 }] });
    expect(base['A-01'].p50).not.toBeNull();
    expect(fixed['A-01']?.p50 ?? null).toBeNull();
    // the transfer switch did go down before the fix: history is kept, and it comes back at the fix
    expect(fixed['ATS-1'].p50).toBeCloseTo(base['ATS-1'].p50!, 1);
    expect(fixed['ATS-1'].recoveredP50).toBe(6);
  });

  it('a late fix does not resurrect losses that already happened', () => {
    const base = runCascade(facility, faults, { horizonMin: 60, runs: 200 });
    const late = runCascade(facility, faults, { horizonMin: 60, runs: 200, fixes: [{ assetId: 'GEN-1', t: 55 }] });
    expect(late['A-01'].p50).toBe(base['A-01'].p50);
  });

  it('fixing an asset before its own fault prevents the fault', () => {
    const c = runCascade(facility, scn('scn-chiller-trip').faults, { horizonMin: 60, runs: 200, fixes: [{ assetId: 'CH-2', t: 10 }] });
    expect(c['CH-2']).toBeUndefined();
    expect(c['P-1']).toBeUndefined();
  });
});

describe('water stop and fire hazards', () => {
  it('a stopped leak puts less water on the floor', () => {
    const leak = scn('scn-riser-leak').leak!;
    const vol = (g: ReturnType<typeof simulateWater>) => g.frames[60].depthMm.reduce((s, d) => s + d, 0);
    const full = simulateWater(facility, leak, 60);
    const stopped = simulateWater(facility, { ...leak, stopT: 10 }, 60);
    expect(vol(stopped)).toBeLessThan(vol(full) * 0.5);
    expect(stopped.frames[8].depthMm).toEqual(full.frames[8].depthMm); // identical until the stop
  });

  it('fire grows from its origin, burns what it reaches, and suppression contains it', () => {
    const ovh = getScenario('real-ovh-sbg2-2021');
    const free = run(ovh);
    expect(free.hazardAt(2)).toEqual([]);
    const fire = (r: ReturnType<typeof run>, t: number) => r.hazardAt(t).find((h) => h.kind === 'fire')!;
    expect(fire(free, 3).radiusM).toBe(0);
    expect(fire(free, 13).radiusM).toBeCloseTo(4.5, 5);
    expect(fire(free, 59).radiusM).toBeLessThanOrEqual(14);
    expect(free.visualAt(3)['UPS-B'].burning).toBe(true);
    expect(free.visualAt(40)['UPS-A'].burning).toBe(true);
    expect(free.clocks['UPS-A'].p50).not.toBeNull();

    const suppressed = run(ovh, [fix('UPS-B', 6, 'suppress_fire')]);
    expect(fire(suppressed, 30)).toMatchObject({ contained: true });
    expect(fire(suppressed, 30).radiusM).toBeCloseTo(1.35, 5);
    expect(suppressed.visualAt(40)['UPS-A'].burning).toBeUndefined();
    expect(suppressed.visualAt(40)['UPS-B'].restored).toBe(true);
    expect(racksLost(suppressed)).toBeLessThan(racksLost(free));
  });
});

describe('visual flags', () => {
  it('lost, then restored after a fix', () => {
    const gen = scn('scn-gen-nostart');
    const r = run(gen, [fix('GEN-1', 6)]);
    expect(r.visualAt(4)['ATS-1'].lost).toBe(true);
    expect(r.visualAt(7)['ATS-1'].lost).toBeUndefined();
    expect(r.visualAt(7)['ATS-1'].restored).toBe(true);
    expect(r.visualAt(7)['GEN-1'].restored).toBe(true);
    expect(r.restoredAt['GEN-1']).toBe(6);
  });
});

describe('fix options and predictions', () => {
  const leak = scn('scn-riser-leak');
  const ctx = (t: number, fixes: Fix[] = []) => ({ facility, scenario: leak, seedReadings: seedReadings(), fixes, t });

  it('no prophetic fixes: the riser is only offered once the leak is observable', () => {
    expect(fixOptionsFor(ctx(6), 'PIPE-L2')).toEqual([]);
    const opts = fixOptionsFor(ctx(12), 'PIPE-L2');
    expect(opts.map((o) => o.action)).toEqual(['isolate_valve']);
    expect(opts[0].delayMin).toBeGreaterThan(0);
  });

  it('isolating the riser at T+12 saves racks', () => {
    const o = fixOptionsFor(ctx(12), 'PIPE-L2')[0];
    const p = predictFix(ctx(12), o);
    expect(p.racksWithout).toBeGreaterThan(0);
    expect(p.racksWith).toBeLessThan(p.racksWithout);
    expect(p.savedAssetIds.length).toBeGreaterThan(0);
    expect(p.lostWith).toBeLessThan(p.lostWithout);
  });

  it('an ordered fix is not offered again, and makeFix sets the effect time', () => {
    const o = fixOptionsFor(ctx(12), 'PIPE-L2')[0];
    const f = makeFix(o, 12);
    expect(f.effectiveAt).toBe(12 + o.delayMin);
    expect(fixOptionsFor(ctx(13, [f]), 'PIPE-L2')).toEqual([]);
  });

  it('healthy assets get no options; a generator no-start offers a manual start', () => {
    expect(fixOptionsFor(ctx(12), 'CRAH-1')).toEqual([]);
    const gen = { facility, scenario: scn('scn-gen-nostart'), seedReadings: seedReadings(), fixes: [], t: 3 };
    expect(fixOptionsFor(gen, 'ATS-1').map((o) => [o.action, o.assetId])).toEqual([['manual_gen_start', 'GEN-1']]);
  });

  it('prediction summary', () => {
    const r = run(leak);
    const s = predictionSummary(r, leak, 12, 60);
    expect(s.horizonMin).toBe(60);
    expect(s.racksLostByHorizon).toBeGreaterThan(0);
    expect(s.firstRackLoss).not.toBeNull();
    expect(s.lostIn.length).toBeGreaterThan(0);
    expect(s.servicesAtRisk.length).toBeGreaterThan(0);
    expect(predictionSummary(r, leak, 12, 0).lostIn).toEqual([]);
  });
});
