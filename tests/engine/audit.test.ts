/** Regression tests for the units / balancing audit (2026-11-07). */
import { describe, expect, it } from 'vitest';
import { facility, seedReadings } from '../../src/domain/fixture';
import { fixOptionsFor, makeFix, predictFix, simulateScenario } from '../../src/domain/engine';
import { getScenario, generateRandomScenario } from '../../src/domain/scenarios';

const racks = new Set(facility.assets.filter((a) => a.type === 'rack').map((a) => a.id));
const lostRacks = (run: ReturnType<typeof simulateScenario>) => Object.values(run.clocks).filter((c) => c.p50 !== null && racks.has(c.assetId)).length;
const ctxAt = (id: string, t: number) => ({ facility, scenario: getScenario(id), seedReadings: seedReadings(), fixes: [], t });

describe('audit: clocks are absolute scenario minutes', () => {
  it('a fault at T+2 yields clocks at or after T+2 (time left = p50 − t)', () => {
    const run = simulateScenario({ facility, scenario: getScenario('scn-gen-nostart'), seedReadings: seedReadings() });
    expect(run.clocks['UTIL'].p50).toBe(2);
    for (const c of Object.values(run.clocks)) if (c.p50 !== null) expect(c.p50).toBeGreaterThanOrEqual(2);
  });
});

describe('audit: "saves N" equals what the live run shows after ordering', () => {
  it('predictFix uses the live run sample count (UPS transfer in the riser leak)', () => {
    const ctx = ctxAt('scn-riser-leak', 20);
    const opts = facility.assets.flatMap((a) => fixOptionsFor(ctx, a.id)).filter((o) => o.action === 'transfer_ups' || o.action === 'isolate_valve');
    expect(opts.length).toBeGreaterThan(0);
    const base = simulateScenario({ facility, scenario: ctx.scenario, seedReadings: seedReadings() });
    for (const o of opts) {
      const p = predictFix(ctx, o);
      const live = simulateScenario({ facility, scenario: ctx.scenario, seedReadings: seedReadings(), fixes: [makeFix(o, ctx.t)] });
      expect(p.racksWithout - p.racksWith).toBe(lostRacks(base) - lostRacks(live));
    }
  });
});

describe('audit: rack-level fixes only stretch a thermal ride-through', () => {
  it('a rack on a power clock (water at the UPS) is offered no shed-load or spot cooling', () => {
    const ctx = ctxAt('scn-riser-leak', 30);
    const run = simulateScenario({ facility, scenario: ctx.scenario, seedReadings: seedReadings() });
    const powerRack = [...racks].find((id) => {
      const c = run.clocks[id];
      if (!c || c.p50 === null || c.p50 <= 30) return false;
      const via = facility.assets.find((a) => a.id === c.path[c.path.length - 2]);
      return via?.type === 'pdu';
    });
    expect(powerRack).toBeDefined();
    expect(fixOptionsFor(ctx, powerRack!)).toEqual([]);
  });

  it('a rack on a cooling clock still gets shed load and portable cooling', () => {
    const ctx = ctxAt('real-azure-syd-2023', 25);
    const coolRack = [...racks].find((id) => fixOptionsFor(ctx, id).length > 0);
    expect(coolRack).toBeDefined();
    expect(fixOptionsFor(ctx, coolRack!).map((o) => o.action).sort()).toEqual(['deploy_portable_cooling', 'shed_load']);
  });
});

describe('audit: balance', () => {
  it('liquid-cooled racks ride through a utility loss on UPS-backed CDU pumps (≥ 6 min)', () => {
    const run = simulateScenario({ facility, scenario: getScenario('scn-gen-nostart'), seedReadings: seedReadings() });
    const gpu = [...racks].filter((id) => run.clocks[id]?.path.includes('CDU-1'));
    const first = Math.min(...[...racks].map((id) => run.clocks[id]?.p50 ?? Infinity));
    expect(first - 2).toBeGreaterThanOrEqual(6); // utility lost at T+2
    for (const id of gpu) expect((run.clocks[id].p50 ?? Infinity) - 2).toBeGreaterThanOrEqual(6);
  });

  it('a prompt manual generator start saves every rack in the NaviSite replay', () => {
    const ctx = ctxAt('scn-gen-nostart', 3);
    const gen = fixOptionsFor(ctx, 'ATS-1').find((o) => o.action === 'manual_gen_start')!;
    const p = predictFix(ctx, gen);
    expect(p.racksWith).toBe(0);
    expect(p.racksWithout).toBe(48);
  });

  it('random draws: about a third compound, CDU leaks are small, the second PDU trip comes ≥ 7 min later', () => {
    let compound = 0, n = 0;
    for (let i = 0; i < 300; i++) {
      const s = generateRandomScenario(`rnd-${(i * 104729 + 7).toString(36)}`);
      n++;
      if (s.name.includes(' + ')) compound++;
      if (s.leak && s.steps.some((x) => x.assetId === 'CDU-1' && x.kind === 'fault')) expect(s.leak.ratePerMin).toBeLessThanOrEqual(5);
      const pdu = s.steps.filter((x) => x.kind === 'fault' && x.assetId.startsWith('PDU'));
      if (pdu.length === 2) expect(pdu[1].t - pdu[0].t).toBeGreaterThanOrEqual(7);
    }
    // ≈ 35 % compounding draws (+ any extra events added to guarantee a clock)
    expect(compound / n).toBeGreaterThan(0.2);
    expect(compound / n).toBeLessThan(0.5);
  });
});

describe('audit: the wall clock and T+ show the same minute', () => {
  it('floors like the T+ label (02:10 start)', async () => {
    const { wallClock } = await import('../../src/domain/clock');
    expect(wallClock(0)).toBe('02:10');
    expect(wallClock(41.6)).toBe('02:51'); // was 02:52 next to "T+41"
    expect(wallClock(59.99)).toBe('03:09');
  });
});

describe('audit: a CDU coolant leak is winnable', () => {
  it('the CDU keeps cooling until its loop drains, and isolating the branch promptly saves its racks', () => {
    const s = getScenario('rnd-10o7'); // primary: coolant leak at CDU-1
    expect(s.leak?.sourceFailsAfterMin).toBeGreaterThanOrEqual(8);
    const seen = Math.min(...s.steps.filter((x) => x.assetId === 'CDU-1' && x.kind !== 'fault').map((x) => x.t));
    const run = simulateScenario({ facility, scenario: s, seedReadings: seedReadings() });
    const gpuLoss = Math.min(...[...racks].filter((id) => run.clocks[id]?.path.includes('CDU-1')).map((id) => run.clocks[id].p50 ?? Infinity));
    expect(gpuLoss - seen).toBeGreaterThanOrEqual(6);
    const ctx = { facility, scenario: s, seedReadings: seedReadings(), fixes: [], t: seen + 1 };
    const iso = fixOptionsFor(ctx, 'CDU-1').find((o) => o.action === 'isolate_valve')!;
    expect(iso.label).toMatch(/top up CDU-1/);
    const p = predictFix(ctx, iso);
    expect(p.racksWithout).toBeGreaterThan(0);
    expect(p.racksWith).toBe(0);
  });
});
