/** Hierarchical ensemble (PREDICTION-SCIENCE.md §6 Step 3, §7.2). */
import { describe, expect, it } from 'vitest';
import { facility } from '../../src/domain/fixture';
import { getScenario } from '../../src/domain/scenarios';
import { assetClocks, runEnsemble, runEnsembleAsync, trialWeights, weightedQuantile, type EnsembleInput } from '../../src/domain/engine/ensemble';
import { forecastScenario } from '../../src/domain/engine/observable';

const bothLost = getScenario('scn-chiller-trip'); // CH-1 at 1, CH-2 at 12 (script)
const none = [{ id: 'none', label: 'no action' }];

describe('ensemble', () => {
  it('is deterministic for a seed and changes with it', () => {
    const inp: EnsembleInput = { facility, scenario: bothLost, t: 13, options: none, outer: 64, inner: 4, seed: 3 };
    expect(JSON.stringify(runEnsemble(inp).summaries)).toBe(JSON.stringify(runEnsemble(inp).summaries));
    expect(JSON.stringify(runEnsemble({ ...inp, seed: 4 }).summaries)).not.toBe(JSON.stringify(runEnsemble(inp).summaries));
  });

  it('weights are all 1 when q = p (no mixture, no stratified hypotheses)', () => {
    const e = runEnsemble({ facility, scenario: bothLost, t: 13, options: none, outer: 32, inner: 2, hypotheses: [{ id: 'x', label: 'x', p: 0.5, basis: 'x', basisKind: 'assumption', effect: {} }] });
    expect([...trialWeights(e)].every((w) => w === 1)).toBe(true);
    expect(e.summaries[0].ess).toBe(e.trials);
  });

  it('weighted quantiles equal the unweighted ones when w ≡ 1', () => {
    const v = [5, 1, 9, 3, 7, Infinity, 2, 8, 4, 6];
    const sorted = [...v].sort((a, b) => a - b);
    for (const q of [0.1, 0.5, 0.9]) expect(weightedQuantile(v, v.map(() => 1), q)).toBe(sorted[Math.ceil(q * v.length) - 1]);
  });

  it('async and sync runs agree', async () => {
    const inp: EnsembleInput = { facility, scenario: bothLost, t: 13, options: none, outer: 48, inner: 2 };
    expect(JSON.stringify((await runEnsembleAsync(inp)).summaries)).toBe(JSON.stringify(runEnsemble(inp).summaries));
  });

  it('the evidence moves the result: a hypothesis at P(real) scales the risk', () => {
    const ch = { ...bothLost, faults: [{ assetId: 'CH-1', t: 1 }] };
    const at = (p: number) => runEnsemble({ facility, scenario: ch, t: 2, options: none, outer: 128, inner: 4, hypotheses: [{ id: 'ch2', label: 'CH-2 trips', p, basis: 'x', basisKind: 'assumption', effect: { faults: [{ assetId: 'CH-2', t: 12 }] } }] }).summaries[0].pServiceDown;
    expect(at(0.9)).toBeGreaterThan(at(0.1) * 5);
    expect(at(0.1)).toBeGreaterThan(0.05);
    expect(at(1e-4)).toBeLessThan(1e-3);
  });

  it('two clocks: the 32 °C envelope crossing comes before service impact', () => {
    const s = runEnsemble({ facility, scenario: bothLost, t: 13, options: none, outer: 96, inner: 4 }).summaries[0];
    expect(s.firstEnvelopeMin!.p50!).toBeLessThan(s.firstImpactMin!.p50!);
  });

  it('no foreknowledge: the riser leak at T+0 forecasts no impact, at T+12 it does', () => {
    const at = (t: number) => runEnsemble({ facility, scenario: forecastScenario(facility, getScenario('scn-riser-leak'), t).scenario, t, leakStartUnknown: true, options: none, outer: 48, inner: 2 }).summaries[0];
    expect(at(0).racks.mean).toBe(0);
    expect(at(12).racks.mean).toBeGreaterThan(10);
  });

  it('prior-predictive check: p10–p90 covers single draws from the same priors at ≈ 80 %', () => {
    const base: EnsembleInput = { facility, scenario: bothLost, t: 13, options: none, keepAssetTimes: true, noStratify: true };
    const model = assetClocks(runEnsemble({ ...base, outer: 256, inner: 4, seed: 1 }));
    let scored = 0, inside = 0;
    for (let i = 0; i < 60; i++) {
      const real = assetClocks(runEnsemble({ ...base, outer: 1, inner: 1, seed: 1000 + i }));
      for (const [id, c] of Object.entries(real)) {
        const m = model[id];
        if (!m || m.p50 === null || c.p50 === null || c.p50 <= 13) continue;
        if (m.p10 === m.p90) continue; // atoms (zero-delay power paths) say nothing about interval width
        scored++;
        if (c.p50 >= (m.p10 ?? m.p50) && c.p50 <= (m.p90 ?? Infinity)) inside++;
      }
    }
    expect(scored).toBeGreaterThan(500);
    expect(inside / scored).toBeGreaterThan(0.72);
    expect(inside / scored).toBeLessThan(0.88);
  });

  it.skipIf(process.env.CI_SLOW)('runs 4 options × 2,048 trials in under 1.5 s', () => {
    const leak = forecastScenario(facility, getScenario('scn-riser-leak'), 12).scenario;
    runEnsemble({ facility, scenario: leak, t: 12, leakStartUnknown: true, options: none, outer: 8, inner: 1 }); // warm the water cache
    const opts = [...none, { id: 'iso', label: 'i', action: 'isolate_valve' as const, assetId: 'PIPE-L2', delayMin: 4 }, { id: 'ua', label: 'u', action: 'transfer_ups' as const, assetId: 'UPS-A', delayMin: 3 }, { id: 'ub', label: 'u', action: 'transfer_ups' as const, assetId: 'UPS-B', delayMin: 3 }];
    const t0 = Date.now();
    const e = runEnsemble({ facility, scenario: leak, t: 12, leakStartUnknown: true, options: opts, outer: 256, inner: 8 });
    expect(e.trials).toBe(2048);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
