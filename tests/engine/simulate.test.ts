import { describe, expect, it } from 'vitest';
import { depthAt, simulateScenario, simulateWater, waterArrival } from '../../src/domain/engine';
import { facility, scenarios, seedReadings } from '../../src/domain/fixture';

const leakScn = scenarios.find((s) => s.id === 'scn-riser-leak')!;

describe('water layer', () => {
  const grid = simulateWater(facility, leakScn.leak!, leakScn.horizonMin);
  const arr = waterArrival(grid, facility);

  it('grid covers all zones at 0.5 m with a frame per minute', () => {
    expect(grid.cellM).toBe(0.5);
    expect(grid.cols).toBe(88);
    expect(grid.rows).toBe(62);
    expect(grid.frames).toHaveLength(61);
    expect(grid.frames[0].depthMm.length).toBe(grid.cols * grid.rows);
  });

  it('is dry before the leak and wet at the source after it', () => {
    expect(depthAt(grid, 33.2, 9.6, 3)).toBe(0);
    expect(depthAt(grid, 33.2, 9.6, 10)).toBeGreaterThan(1);
  });

  it('water travels UPS-B → BATT-B with plausible timing; hall stays dry', () => {
    expect(arr['UPS-B']).toBeGreaterThan(leakScn.leak!.startT);
    expect(arr['UPS-B']).toBeLessThan(arr['BATT-B']);
    expect(arr['BATT-B']).toBeGreaterThanOrEqual(20);
    expect(arr['BATT-B']).toBeLessThanOrEqual(40);
    expect(arr['BATT-A']).toBeLessThan(arr['BATT-B']);
    for (const a of facility.assets.filter((x) => x.zoneId === 'Z-HALL')) expect(arr[a.id]).toBeUndefined();
    expect(arr['PIPE-L2']).toBeUndefined();
    expect(arr['DRAIN-1']).toBeUndefined();
  });

  it('wet area grows over time (not an instant flood)', () => {
    const wet = (t: number) => grid.frames[t].depthMm.reduce((n, d) => n + (d >= 1 ? 1 : 0), 0);
    expect(wet(8)).toBeGreaterThan(0);
    expect(wet(8)).toBeLessThan(wet(30));
    expect(wet(30)).toBeLessThan(wet(60));
    expect(wet(60)).toBeLessThan(grid.cols * grid.rows * 0.5);
  });
});

describe('simulateScenario', () => {
  it('riser leak: < 1.5 s, wet assets become faults with derived model edges', () => {
    const t0 = performance.now();
    const run = simulateScenario({ facility, scenario: leakScn, seedReadings: seedReadings() });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1500);

    expect(run.water).toBeDefined();
    expect(run.waterArrival['BATT-B']).toBeDefined();
    const e = run.derivedEdges.find((x) => x.to === 'BATT-B')!;
    expect(e.kind).toBe('shares_space');
    expect(e.basisKind).toBe('model');
    expect(e.basis).toMatch(/water-layer arrival/i);
    expect(run.clocks['UPS-B'].p50).toBe(run.waterArrival['UPS-B']);
    expect(run.clocks['UPS-B'].path[0]).toBe('PIPE-L2');
    // scripted trip at 34, or earlier if the water takes out its upstream power first
    expect(run.clocks['CRAH-2'].p50!).toBeLessThanOrEqual(34);

    const v = run.visualAt(run.waterArrival['UPS-B']);
    expect(v['UPS-B'].wet).toBe(true);
    expect(v['UPS-B'].severity).toBe('critical');
    expect(run.visualAt(2)['UPS-B'].wet).toBeUndefined();
    expect(run.visualAt(10)).toBe(run.visualAt(10)); // memoized
    expect(run.visualAt(0)['C-08'].freshness).toBe('stale');
    expect(run.visualAt(0)['A-11'].severity).toBe('critical');
    expect(run.visualAt(6)['A-01'].freshness).toBe('fresh');

    expect(run.stepsUntil(4).map((s) => s.t)).toEqual([0, 1, 4]);
    expect(run.readingsAt(12).some((r) => r.assetId === 'PIPE-L2' && r.metric === 'flow_lpm')).toBe(true);
    expect(run.readingsAt(10).every((r) => r.t <= 10)).toBe(true);
  });

  it('chiller trip: racks heat up via synthesized readings after cooling is lost', () => {
    const scn = scenarios.find((s) => s.id === 'scn-chiller-trip')!;
    const run = simulateScenario({ facility, scenario: scn, seedReadings: seedReadings() });
    expect(run.water).toBeUndefined();
    const crahLost = run.clocks['CRAH-1'].p50!;
    expect(crahLost).toBeGreaterThan(12);
    const before = run.readingsAt(crahLost - 1).filter((r) => r.source === 'simulated' && r.assetId === 'A-01');
    expect(before).toHaveLength(0);
    const later = run.readingsAt(crahLost + 8).filter((r) => r.source === 'simulated' && r.assetId === 'A-01');
    expect(later.length).toBeGreaterThan(0);
    expect(later.at(-1)!.value).toBeGreaterThan(later[0].value);
    expect(run.visualAt(crahLost + 8)['A-01'].heat).toBeGreaterThan(run.visualAt(0)['A-01'].heat);
  });

  it('is deterministic for the same input', () => {
    const scn = scenarios.find((s) => s.id === 'scn-gen-nostart')!;
    const a = simulateScenario({ facility, scenario: scn, seedReadings: seedReadings() });
    const b = simulateScenario({ facility, scenario: scn, seedReadings: seedReadings() });
    expect(a.clocks).toEqual(b.clocks);
  });
});
