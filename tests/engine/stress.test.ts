/** Red-team importance sampling, engine side (PREDICTION-SCIENCE.md §5 Design A, §7.4). */
import { describe, expect, it } from 'vitest';
import { facility } from '../../src/domain/fixture';
import { getScenario } from '../../src/domain/scenarios';
import { familiesFor, runEnsemble, weightedMean, type EnsembleInput } from '../../src/domain/engine/ensemble';
import { DEFENSIVE_ALPHA, attributeRegions, buildMixture, crossEntropyProposals, failureDigest, stressTest, validateProposal, validateProposals } from '../../src/domain/engine/stress';
import { mulberry32 } from '../../src/domain/engine/rng';

// Utility lost at T+2 with a healthy generator: a critical service goes down only if the generator
// fails to start (2.22e-3) or the ATS fails to transfer (1.33e-3) — exact P = 1 − (1 − a)(1 − b).
const utilOnly = { ...getScenario('scn-gen-nostart'), faults: [{ assetId: 'UTIL', t: 2 }] };
const TRUE_P = 1 - (1 - 2.22e-3) * (1 - 1.33e-3);
const base: EnsembleInput = { facility, scenario: utilOnly, t: 3, options: [{ id: 'none', label: 'no action' }], inner: 1 };
const fams = familiesFor();

describe('stress regions: grammar', () => {
  it('rejects unknown families, set_p > 0.5, out-of-range windows, too many terms and wrong ops', () => {
    expect(validateProposal({ label: 'x', terms: [{ family: 'nope', op: 'force', value: 1 }] }, fams).errors[0]).toMatch(/unknown family/);
    expect(validateProposal({ label: 'x', terms: [{ family: 'gen_fts', op: 'set_p', p: 0.9 }] }, fams).ok).toBe(false);
    expect(validateProposal({ label: 'x', terms: [{ family: 'k_G', op: 'quantile_window', lo: 0.9, hi: 1.2 }] }, fams).ok).toBe(false);
    expect(validateProposal({ label: 'x', terms: [{ family: 'gen_fts', op: 'quantile_window', lo: 0.1, hi: 0.2 }] }, fams).ok).toBe(false);
    expect(validateProposal({ label: 'x', terms: [{ family: 'k_G', op: 'scale', f: 2 }] }, fams).ok).toBe(false); // uniform, not log-scale
    expect(validateProposal({ label: 'x', terms: Array.from({ length: 7 }, () => ({ family: 'k_G', op: 'quantile_window', lo: 0, hi: 0.5 })) }, fams).ok).toBe(false);
    expect(validateProposal({ label: 'x', terms: [{ family: 'crew_mult', op: 'scale', f: 3 }, { family: 'gen_fts', op: 'force', value: 'fail' }] }, fams).ok).toBe(true);
    const many = validateProposals(Array.from({ length: 8 }, () => ({ label: 'r', terms: [{ family: 'gen_fts', op: 'force', value: 1 }] })), fams);
    expect(many.regions.length).toBe(6);
    expect(many.errors[0]).toMatch(/at most 6/);
  });
});

describe('stress regions: estimator', () => {
  it('weights are bounded by 1/α relative to the base sampler', () => {
    const { result } = stressTest(base, 0, [{ label: 'gen', terms: [{ family: 'gen_fts', op: 'set_p', p: 0.5 }] }, { label: 'slow crew', terms: [{ family: 'crew_mult', op: 'scale', f: 4 }] }], 'cross_entropy', [], { outer: 300, inner: 1 });
    expect(result.maxWeight).toBeLessThanOrEqual(1 / DEFENSIVE_ALPHA + 1e-9);
  });

  it('rare event: generator / ATS failure recovered within 3 SE by IS with N = 8,000', () => {
    const { result } = stressTest(base, 0, [{ label: 'generator fails', terms: [{ family: 'gen_fts', op: 'set_p', p: 0.5 }] }, { label: 'ATS fails', terms: [{ family: 'ats_ftt', op: 'set_p', p: 0.5 }] }], 'cross_entropy', [], { outer: 8000, inner: 1 });
    const se = (result.ci90[1] - result.ci90[0]) / (2 * 1.645);
    expect(Math.abs(result.pFail - TRUE_P)).toBeLessThan(3 * se);
    expect(se / result.pFail).toBeLessThan(0.15); // plain MC at N = 8,000 sees ~28 events: SE/P ≈ 0.19
    const [gen] = result.regions;
    expect(gen.priorOneIn).toBe(Math.round(1 / 2.22e-3));
    expect(gen.pFailGivenRegion).toBeGreaterThan(0.95);
    expect(gen.shareOfFailure).toBeGreaterThan(0.5);
  });

  it('unbiased whatever is proposed: random valid proposals average to the truth', () => {
    const rand = mulberry32(17);
    const fam = ['gen_fts', 'ats_ftt', 'crew_mult', 'k_G', 'battery_soh_B', 'ups_transfer_fail'];
    const ests: number[] = [];
    for (let r = 0; r < 12; r++) {
      const regions = Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, i) => {
        const f = fam[Math.floor(rand() * fam.length)];
        const term = f === 'crew_mult' ? { family: f, op: 'scale', f: 0.5 + 3 * rand() } : f === 'k_G' || f === 'battery_soh_B' ? { family: f, op: 'quantile_window', lo: 0, hi: 0.3 + 0.5 * rand() } : { family: f, op: 'set_p', p: 0.05 + 0.45 * rand() };
        return validateProposal({ label: `r${i}`, terms: [term] }, fams).region!;
      });
      ests.push(stressTest({ ...base, seed: 100 + r }, 0, regions, 'nemotron', [], { outer: 1500, inner: 1 }).result.pFail);
    }
    const mean = ests.reduce((a, b) => a + b, 0) / ests.length;
    const sd = Math.sqrt(ests.reduce((a, b) => a + (b - mean) ** 2, 0) / (ests.length - 1));
    expect(Math.abs(mean - TRUE_P)).toBeLessThan(3 * (sd / Math.sqrt(ests.length)) + 2e-4);
  });

  it('digest and cross-entropy fallback point at the failure-causing families', () => {
    const ens = runEnsemble({ ...base, outer: 2000, mixture: buildMixture([{ label: 'g', terms: [{ family: 'gen_fts', op: 'set_p', p: 0.5 }] }]) });
    const d = failureDigest(ens, 0);
    expect(d.lifts[0].family).toBe('gen_fts');
    const ce = crossEntropyProposals(ens, 0);
    expect(ce[0].terms[0]).toEqual({ family: 'gen_fts', op: 'force', value: 1 });
    // with no failures observed yet, CE raises the rare Bernoulli families
    const quiet = runEnsemble({ ...base, outer: 50 });
    expect(weightedMean(quiet, quiet.outcomes[0].F).mean).toBe(0);
    expect(crossEntropyProposals(quiet, 0).every((r) => r.terms[0].op === 'set_p')).toBe(true);
    expect(attributeRegions(quiet, 0, ce)[0].shareOfFailure).toBe(0);
  });
});
