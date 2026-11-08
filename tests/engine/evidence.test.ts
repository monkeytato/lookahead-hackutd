/** Evidence posterior (PREDICTION-SCIENCE.md §2.6, §7.3). */
import { describe, expect, it } from 'vitest';
import { DEFAULT_ERROR_MODEL, compareWithPosterior, evidencePosterior } from '../../src/domain/engine';
import { logStudentT } from '../../src/domain/engine/evidence';
import { mulberry32 } from '../../src/domain/engine/rng';

// the dossier's worked example: σ_inst 1, σ_ref 0.3, σ_sp 1.5, μ_model 23.5, σ_model 1.5
const worked = { sigmaInstalled: { value: 1, basis: 'x' }, sigmaRef: { value: 0.3, basis: 'x' }, sigmaSpatial: { value: 1.5, basis: 'x' }, sigmaModel: { value: 1.5, basis: 'x' } };
const temp = (ref: number, prior?: number) =>
  evidencePosterior({ metric: 'inlet_temp_c', installed: { value: 34.2 }, reference: { mean: ref, n: 10 }, modelBaseline: { mean: 23.5 }, errorModel: worked, priorReal: prior });

describe('evidence posterior', () => {
  it('worked example: portable 24.0 °C against installed 34.2 °C favours a measurement problem', () => {
    const p = temp(24.0);
    expect(p.pReal).toBeLessThan(0.01);
    expect(p.verdict).toBe('measurement_disagreement');
    expect(p.rationale).toMatch(/does not prove the sensor is faulty/);
  });

  it('worked example: portable 31.0 °C favours a real condition (Student-t ν = 4)', () => {
    // The dossier quotes LR ≈ 110 with a Gaussian "for brevity"; the specified ν = 4 likelihood is more
    // cautious (LR ≈ 9), so P(real) is ≈ 0.90 rather than > 0.95.
    const p = temp(31.0);
    expect(p.pReal).toBeGreaterThan(0.88);
    expect(p.logLR).toBeGreaterThan(Math.log(5));
  });

  it('is monotonic in the reference value between baseline and installed', () => {
    let last = -1;
    for (let y = 22; y <= 34; y += 0.5) { const p = temp(y).pReal; expect(p).toBeGreaterThanOrEqual(last); last = p; }
  });

  it('prior sensitivity is reported at 0.2 and 0.8', () => {
    const p = temp(28);
    expect(p.sensitivity.map((s) => s.prior)).toEqual([0.2, 0.5, 0.8]);
    expect(p.sensitivity[0].pReal).toBeLessThan(p.sensitivity[2].pReal);
  });

  it('refuses quantities the portable rig cannot measure', () => {
    const chw = evidencePosterior({ metric: 'supply_temp_c', installed: { value: 30.8 }, reference: { mean: 31, n: 10 }, modelBaseline: { mean: 7 } });
    expect(chw.measurable).toBe(false);
    expect(chw.verdict).toBe('inconclusive');
    expect(chw.rationale).toMatch(/not measurable by the portable rig/);
    expect(chw.pReal).toBe(DEFAULT_ERROR_MODEL.priorReal.value);
    const vib = evidencePosterior({ metric: 'vibration_mm_s', installed: { value: 6.8 }, reference: { mean: 1, n: 10 }, modelBaseline: { mean: 2.1 } });
    expect(vib.measurable).toBe(false);
  });

  it('water probe: wet favours real, dry favours a meter problem', () => {
    const wet = evidencePosterior({ metric: 'leak', installed: { value: 1 }, reference: { mean: 1, n: 10 }, modelBaseline: { mean: 0 } });
    const dry = evidencePosterior({ metric: 'leak', installed: { value: 1 }, reference: { mean: 0, n: 10 }, modelBaseline: { mean: 0 } });
    expect(wet.pReal).toBeCloseTo(0.95 / (0.95 + 0.02), 3);
    expect(dry.pReal).toBeLessThan(0.1);
  });

  it('rationale never says broken or safe; compareWithPosterior keeps the CompareResult shape', () => {
    for (const y of [22, 27, 31, 34]) expect(temp(y).rationale).not.toMatch(/broken|safe/i);
    const r = compareWithPosterior({ id: 'r', assetId: 'A-11', metric: 'inlet_temp_c', value: 34.2, unit: '°C', t: 0, source: 'installed', expectedIntervalMin: 5 }, { mean: 22.4, n: 10 }, { mean: 22.6 });
    expect(r.verdict).toBe('measurement_disagreement');
    expect(r.pReal).toBeLessThan(0.1);
    expect(r.rationale).not.toMatch(/broken|safe/i);
  });

  it('flags an unsettled probe and widens its error', () => {
    const settled = temp(28);
    const lag = evidencePosterior({ metric: 'inlet_temp_c', installed: { value: 34.2 }, reference: { mean: 28, n: 10, slopePerMin: 0.8 }, modelBaseline: { mean: 23.5 }, errorModel: worked });
    expect(lag.qualityFlags).toContain('unsettled_lag');
    expect(Math.abs(lag.logLR)).toBeLessThan(Math.abs(settled.logLR) + 1e-9);
  });

  // synthetic truth drawn from the error model (calibration by construction, §7.3)
  const draw = (rand: () => number) => {
    const n = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    return () => n() / Math.sqrt((n() ** 2 + n() ** 2 + n() ** 2 + n() ** 2) / 4);
  };
  const em = DEFAULT_ERROR_MODEL;
  const sReal = Math.hypot(em.sigmaInstalled.value, em.sigmaRef.value, em.sigmaSpatial.value);
  const sMeas = Math.hypot(em.sigmaModel.value, em.sigmaRef.value, em.sigmaSpatial.value);

  it('is calibrated on synthetic truth: each P(real) bin within ±0.05 of the observed frequency', () => {
    const rand = mulberry32(11);
    const t4 = draw(rand);
    const bins = Array.from({ length: 10 }, () => ({ n: 0, real: 0, p: 0 }));
    let brier = 0;
    for (let i = 0; i < 10000; i++) {
      const x = 26 + 12 * rand(), mu = 21 + 4 * rand();
      const real = rand() < 0.5;
      const y = real ? x + sReal * t4() : mu + sMeas * t4();
      const p = evidencePosterior({ metric: 'inlet_temp_c', installed: { value: x }, reference: { mean: y, n: 10 }, modelBaseline: { mean: mu } }).pReal;
      const b = bins[Math.min(9, Math.floor(p * 10))];
      b.n++; b.p += p; if (real) b.real++;
      brier += (p - (real ? 1 : 0)) ** 2;
    }
    for (const b of bins) if (b.n >= 200) expect(Math.abs(b.real / b.n - b.p / b.n)).toBeLessThan(0.05);
    expect(brier / 10000).toBeLessThan(0.1);
  });

  it('robust to counterfeit probes: +3 °C offsets in 10 % of false alarms give P(real) ≥ 0.99 in ≤ 1 %', () => {
    const rand = mulberry32(5);
    const t4 = draw(rand);
    let overconfident = 0;
    for (let i = 0; i < 10000; i++) {
      const x = 26 + 12 * rand(), mu = 21 + 4 * rand();
      const y = mu + sMeas * t4() + (rand() < 0.1 ? 3 : 0);
      if (evidencePosterior({ metric: 'inlet_temp_c', installed: { value: x }, reference: { mean: y, n: 10 }, modelBaseline: { mean: mu } }).pReal >= 0.99) overconfident++;
    }
    expect(overconfident / 10000).toBeLessThanOrEqual(0.01);
  });

  it('Student-t log pdf integrates to 1', () => {
    let s = 0;
    for (let y = -60; y <= 60; y += 0.01) s += Math.exp(logStudentT(y, 0, 1.3, 4)) * 0.01;
    expect(s).toBeCloseTo(1, 2);
  });
});
