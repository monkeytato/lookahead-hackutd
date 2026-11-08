import { describe, expect, it } from 'vitest';
import { simulateScenario } from '../../src/domain/engine';
import { facility, scenarios, seedReadings } from '../../src/domain/fixture';
import { runDirector, runLocalPlanner } from '../../server/director';
import { floorScan, leakInput } from './helpers';

const res = await runLocalPlanner(leakInput(), 'test');

describe('local planner on scn-riser-leak at T+25', () => {

  it('runs the documented tool sequence through the shared dispatcher', () => {
    const tools = res.steps.map((s) => s.tool);
    expect(tools[0]).toBe('get_situation');
    expect(tools.at(-1)).toBe('recommend');
    expect(tools.filter((t) => t === 'scan_value').length).toBeGreaterThanOrEqual(3);
    expect(tools).toContain('compare_runs');
    expect(res.steps.every((s) => s.ok)).toBe(true);
    expect(res.provider).toBe('local_planner');
    expect(res.model).toBeNull();
    expect(res.fallbackReason).toBe('test');
  });

  it('baseline run-1 matches the engine scenario run exactly', () => {
    const scn = scenarios.find((s) => s.id === 'scn-riser-leak')!;
    const sim = simulateScenario({ facility, scenario: scn, seedReadings: seedReadings() });
    const base = res.runs['run-1'];
    expect(base.topClocks.length).toBe(8);
    for (const c of base.topClocks) expect(c.atP50).toBe(sim.clocks[c.assetId].p50);
    expect(base.lostByHorizon).toBe(Object.values(sim.clocks).filter((c) => c.p50 !== null).length);
  });

  it('recommends the BATT-B threshold liquid scan, with reasons tied to run numbers', () => {
    const rec = res.recommendation;
    expect(rec.nextScan?.assetId).toBe('BATT-B');
    expect(rec.nextScan?.holdS).toBe(10);
    expect(rec.nextScan?.point).toMatch(/threshold/i);
    // CRAH-2 vibration is rig-measurable too now, so it is evaluated first (run-2/3); BATT-B is run-4/5
    const wet = res.runs['run-4'];
    const dry = res.runs['run-5'];
    expect(wet.firstRackLoss?.inMin).toBe(19); // UPS-A wet at T+44 with UPS-B already wet → racks lose both feeds
    expect(dry.firstRackLoss).toBeNull();
    expect(rec.nextScan?.reason).toContain('run-4');
    expect(rec.nextScan?.reason).toContain('19 min');
    expect(rec.nextAction).toMatch(/irreversible/);
    expect(rec.nextAction).toMatch(/CRAH-2/); // top-ranked incident is named
    expect(res.warnings).toEqual([]);
  });

  it('A-11 inlet scan is evaluated and found not decision-changing right now', () => {
    const step = res.steps.find((s) => s.tool === 'scan_value' && (s.args as { assetId: string }).assetId === 'A-11');
    expect(step?.summary).toMatch(/decision value 0\b/);
  });

  it('every cited run exists and hypotheses come in competing pairs', () => {
    const h = res.recommendation.hypotheses;
    expect(h.length).toBeGreaterThanOrEqual(2);
    for (const x of h) for (const r of x.runIds) expect(res.runs[r]).toBeDefined();
    expect(Object.keys(res.runs).length).toBeLessThanOrEqual(10);
  });

  it('is deterministic', async () => {
    const again = await runLocalPlanner(leakInput(), 'test');
    expect(again.recommendation).toEqual(res.recommendation);
  });

  it('does not repeat a scan already taken — moves on to the next-best reading', async () => {
    const r = await runLocalPlanner(leakInput({ scans: [floorScan('BATT-B', 1)] }), 'test');
    expect(r.recommendation.nextScan?.assetId).toBe('PIPE-L2');
  });

  it('with no uncertain evidence it recommends no scan', async () => {
    const incidents = leakInput().incidents.map((i) => ({ ...i, evidence: 'corroborated_abnormal' as const }));
    const r = await runLocalPlanner(leakInput({ incidents }), 'test');
    expect(r.recommendation.nextScan).toBeNull();
    expect(r.recommendation.nextAction).toMatch(/top-ranked incident/);
  });
});

describe('runDirector without a key', () => {
  it('falls back to the local planner and says so', async () => {
    const r = await runDirector(leakInput(), { env: {} });
    expect(r.provider).toBe('local_planner');
    expect(r.fallbackReason).toMatch(/NVIDIA_API_KEY/);
    expect(r.recommendation.nextScan?.assetId).toBe('BATT-B');
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects an unknown scenario', async () => {
    await expect(runDirector(leakInput({ scenarioId: 'nope' }), { env: {} })).rejects.toThrow(/unknown scenario/);
  });
});
