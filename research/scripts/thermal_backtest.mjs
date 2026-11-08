// Lumped room-air / IT-mass / chilled-water energy balance (the model PREDICTION-SCIENCE.md recommends),
// back-tested against published cooling-outage transients, then run as a Monte Carlo over parameter
// uncertainty for the DAL-1 fixture hall. Pure arithmetic; no downloaded content is executed.
//
//   C_a dT_a/dt = P_air − Q_coil − G (T_a − T_m)          room air (well mixed; = rack inlet)
//   C_m dT_m/dt = G (T_a − T_m)                            IT + rack steel thermal mass
//   C_w dT_w/dt = Q_coil − Q_chiller                       chilled-water loop (pipes, coils, tank)
//   Q_coil = fansOn ? ṁ_crah c_p (T_a − T_s) : 0,  T_s = max(T_set, T_a − ε_c (T_a − T_w))
//   Q_chiller = chillerOn ? min(Q_cap, Q_coil + C_w (T_w − T_wset)/60 s) : 0
//
// Usage: node research/scripts/thermal_backtest.mjs  (writes research/derived/thermal_backtest.json if OUT is set)
import { writeFileSync } from 'node:fs';

const RHO_AIR = 1.19, CP_AIR = 1006, CP_W = 4186, RHO_W = 1000;

/** Simulate; returns samples [{t (s), Ta, Tm, Tw}] every `every` s. */
export function simulate(p) {
  const C_a = RHO_AIR * CP_AIR * p.airVolM3;
  const C_m = p.itMassJperK;
  const C_w = RHO_W * CP_W * p.waterM3;
  const mcp = RHO_AIR * CP_AIR * p.crahFlowM3s;
  const G = p.G * (p.gMult ?? (Number(process.env.GMULT) || 1));
  // initial steady state: Q_coil = P, T_s = T_set (valve modulating), T_a = T_set + P/mcp
  let Ta = p.Ta0 ?? (p.TsetAir + p.P / mcp), Tm = Ta, Tw = p.TsetWater;
  const dt = 0.5, out = [];
  for (let t = 0; t <= p.horizonS; t += dt) {
    if (Math.abs(t / p.every - Math.round(t / p.every)) < 1e-9) out.push({ t, Ta, Tm, Tw });
    const fansOn = p.fansOn(t), chillerOn = p.chillerOn(t);
    let Qc = 0;
    if (fansOn) {
      const Ts = Math.max(p.TsetAir, Ta - p.epsCoil * (Ta - Tw));
      Qc = Math.max(0, mcp * (Ta - Ts));
    }
    const ramp = p.chillerRampS && p.chillerOnAtS !== undefined ? Math.min(1, Math.max(0, (t - p.chillerOnAtS) / p.chillerRampS)) : 1;
    const Qch = chillerOn ? Math.max(0, Math.min(p.Qcap * ramp, Qc + (C_w * (Tw - p.TsetWater)) / 60)) : 0;
    const dTa = (p.P - Qc - G * (Ta - Tm)) / C_a;
    const dTm = (G * (Ta - Tm)) / C_m;
    const dTw = (Qc - Qch) / C_w;
    Ta += dTa * dt; Tm += dTm * dt; Tw += dTw * dt;
  }
  return out;
}
const peak = (s) => s.reduce((m, x) => (x.Ta > m.Ta ? x : m), s[0]);
const firstAbove = (s, th) => { const x = s.find((q) => q.Ta >= th); return x ? x.t : null; };
const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

const results = {};

// ------------------------------------------------------------ 1. WP179 Example 1 (Lin, Zhang, VanGilder 2013)
// 30×24×4 m room + 0.6 m plenum, 400 kW, 100 racks × 545 kg, CRAH 45 m³/s, supply set 20 °C, CHW 7.2 °C,
// IT on UPS, fans/pumps/chiller on generator (starts 60 s), chiller restarts at 12 min. Walls ignored.
// Published: peak ≈ 106 °F (41 °C) baseline; 5-min restart → 98 °F (36.7 °C); 4-min → "marginally above" 90 °F (32.2 °C).
let rampS = 0;
const wp179 = (waterM3, restartMin, eps = 0.8) => simulate({
  airVolM3: 30 * 24 * 4.6, itMassJperK: 100 * 545 * 650, waterM3, crahFlowM3s: 45, G: eps * RHO_AIR * CP_AIR * (400 * 0.059), // 125 cfm/kW = 0.059 m³/s per kW
  P: 400e3, TsetAir: 20, TsetWater: 7.2, epsCoil: 0.75, Qcap: 400e3 * 1.25,
  fansOn: (t) => t >= 60, chillerOn: (t) => t >= restartMin * 60, chillerOnAtS: restartMin * 60, chillerRampS: rampS, horizonS: 40 * 60, every: 5,
});
// Fit the one unknown (loop water volume) to the 12-min baseline peak of 41 °C, then PREDICT the 5- and 4-min restarts.
// Done twice: chiller at full capacity the instant it restarts, and with a 4-min linear capacity ramp (Trane: 80 % at ~160 s, full ~250 s).
results.wp179 = [0, 240].map((ramp) => {
  rampS = ramp;
  let best = null;
  for (let w = 0.25; w <= 40; w += 0.25) {
    const pk = peak(wp179(w, 12)).Ta;
    const err = Math.abs(pk - 41.1);
    if (!best || err < best.err) best = { w, err, pk };
  }
  const fitW = best.w;
  const base = wp179(fitW, 12);
  return {
    chillerRampS: ramp,
    fittedLoopWaterM3: fitW, fittedLoopLitresPerKw: r1((fitW * 1000) / 400),
    baselinePeakC: r1(best.pk), publishedBaselinePeakC: 41.1,
    predicted5minRestartPeakC: r1(peak(wp179(fitW, 5)).Ta), published5minRestartPeakC: 36.7,
    predicted4minRestartPeakC: r1(peak(wp179(fitW, 4)).Ta), published4minRestartPeakC: 32.2,
    first60sRiseC: r1(base.find((x) => x.t === 60).Ta - base[0].Ta),
    lastMinuteAbove32_12minRestart: r1(Math.max(...base.filter((x) => x.Ta >= 32).map((x) => x.t)) / 60), publishedUnacceptableUntilMin: 17,
    sensitivityEps: [0.6, 0.9].map((e) => ({ itEffectiveness: e, peak12: r1(peak(wp179(fitW, 12, e)).Ta), peak5: r1(peak(wp179(fitW, 5, e)).Ta) })),
  };
});
rampS = 0;

// ------------------------------------------------------------ 2. WP179 CFD room (no recovery) — consistency check
// 10 × 10.7 × 2.6 m room (+0.61 m plenum), racks at 1/2.5/6 kW, 545 kg each; published well-mixed temps:
// 28.4 °C at 0 s, 32.5 at 30 s, 34.7 at 60 s, 37.3 at 300 s. IT load is not legible in the source; we solve for
// P from the 0–30 s slope and assume racks average 4 kW to get the rack count — so this is a CHECK, not a validation.
{
  const vol = 10 * 10.7 * (2.6 + 0.61);
  const C_a = RHO_AIR * CP_AIR * vol;
  const P = ((32.5 - 28.4) / 30) * C_a * 1.05; // small correction: mass already absorbs a little in 30 s
  const nRacks = Math.round(P / 4000);
  const run = (eps) => simulate({ airVolM3: vol, itMassJperK: nRacks * 545 * 650, waterM3: 1, crahFlowM3s: 1e-9, G: eps * RHO_AIR * CP_AIR * (P / 1000) * 0.059, P, Ta0: 28.4, TsetAir: 28.4, TsetWater: 7, epsCoil: 0, Qcap: 0, fansOn: () => false, chillerOn: () => false, horizonS: 300, every: 30 });
  results.wp179Cfd = { inferredItKw: r1(P / 1000), assumedRacks: nRacks, published: { 30: 32.5, 60: 34.7, 300: 37.3 },
    model: [0.7, 0.8, 0.9].map((e) => { const s = run(e); return { itEffectiveness: e, t30: r1(s[1].Ta), t60: r1(s[2].Ta), t300: r1(s[10].Ta) }; }) };
}

// ------------------------------------------------------------ 3. Opengate 2007 / Khankari — fans-off, per-density
// Generic room: 3.5 m ceiling, 0.6 m plenum, 2.0 m² of floor per rack (hot/cold aisle pitch, incl. aisles), 545 kg racks.
const generic = (kwPerRack, eps = 0.8, startC = 22) => simulate({
  airVolM3: 2.0 * 4.1 * 100, itMassJperK: 100 * 545 * 650, waterM3: 1, crahFlowM3s: 1e-9, G: eps * RHO_AIR * CP_AIR * (100 * kwPerRack) * 0.059,
  P: 100 * kwPerRack * 1000, Ta0: startC, TsetAir: startC, TsetWater: 7, epsCoil: 0, Qcap: 0, fansOn: () => false, chillerOn: () => false, horizonS: 30 * 60, every: 5,
});
results.densitySweepFansOff = [1.5, 2.5, 5, 8, 10, 15, 20].map((kw) => {
  const s = generic(kw);
  return { kwPerRack: kw, rateFirst30sCperMin: r1(((s[6].Ta - s[0].Ta) / 30) * 60), s_to32: firstAbove(s, 32), s_to35: firstAbove(s, 35), s_to40: firstAbove(s, 40), s_to45: firstAbove(s, 45) };
});

// ------------------------------------------------------------ 4. DAL-1 fixture hall Monte Carlo
// Loads from src/domain/fixture.ts: loadKw = 6 + ((i*7 + charCode(row)) % 5), 12 racks per row, D-09..D-12 are 31 kW liquid.
const rowKw = (row) => Array.from({ length: 12 }, (_, i) => 6 + ((i * 7 + row.charCodeAt(0)) % 5));
const north = [...rowKw('A'), ...rowKw('B')].reduce((a, b) => a + b, 0);
const southAir = [...rowKw('C'), ...rowKw('D').slice(0, 8)].reduce((a, b) => a + b, 0);
results.fixtureLoads = { northAirKw: north, southAirKw: southAir, gpuKw: 4 * 31, hallAirKw: north + southAir };

function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = mulberry32(2026);
const U = (a, b) => a + (b - a) * rand();
const pctl = (xs, q) => { const s = xs.map((x) => (x === null ? Infinity : x)).sort((a, b) => a - b); const v = s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; return v === Infinity ? null : r1(v / 60); };

function hallTrial(kind) {
  const ceiling = U(3.0, 4.5), plenum = rand() < 0.5 ? 0 : 0.6;
  const zoneArea = 24 * 12; // one half of the hall per CRAH pair
  const zoneKw = kind === 'crah_pair_fans_off' ? north : north + southAir + 0.15 * 124; // GPU racks reject ~15 % to air (assumption)
  const area = kind === 'crah_pair_fans_off' ? zoneArea : 24 * 24;
  const racks = kind === 'crah_pair_fans_off' ? 24 : 48;
  const eps = U(0.6, 0.9);
  const rackKg = U(350, 700);
  const startC = U(20, 25);
  const litresPerKw = Math.exp(U(Math.log(3), Math.log(11))); // 3–10 gal/ton practice ≈ 3.2–10.8 L/kW (assumption range)
  const restartMin = kind === 'chillers_lost_fans_on' ? Infinity : Infinity;
  // a fans-off zone still exchanges air with the running half through open aisles; mixing factor 0..0.5 of the other half's air
  const mixVol = kind === 'crah_pair_fans_off' ? U(0, 0.5) * zoneArea * (ceiling + plenum) : 0;
  const s = simulate({
    airVolM3: area * (ceiling + plenum) + mixVol, itMassJperK: racks * rackKg * 650, waterM3: (litresPerKw * (north + southAir + 124)) / 1000,
    crahFlowM3s: kind === 'crah_pair_fans_off' ? 1e-9 : (north + southAir) * 0.059 * 1.2, G: eps * RHO_AIR * CP_AIR * zoneKw * 0.059,
    P: zoneKw * 1000, Ta0: kind === 'crah_pair_fans_off' ? startC : undefined, TsetAir: startC - (kind === 'chillers_lost_fans_on' ? zoneKw / (RHO_AIR * CP_AIR * (north + southAir) * 0.059 * 1.2 / 1000) : 0), TsetWater: 10,
    epsCoil: 0.75, Qcap: 0, fansOn: () => kind === 'chillers_lost_fans_on', chillerOn: () => false, horizonS: 90 * 60, every: 10,
  });
  return { to27: firstAbove(s, 27), to32: firstAbove(s, 32), to35: firstAbove(s, 35), to40: firstAbove(s, 40), to45: firstAbove(s, 45) };
}
for (const kind of ['crah_pair_fans_off', 'chillers_lost_fans_on']) {
  const trials = Array.from({ length: 2000 }, () => hallTrial(kind));
  results[`fixture_${kind}`] = Object.fromEntries(['to27', 'to32', 'to35', 'to40', 'to45'].map((k) => [k, { p10: pctl(trials.map((x) => x[k]), 0.1), p50: pctl(trials.map((x) => x[k]), 0.5), p90: pctl(trials.map((x) => x[k]), 0.9), unit: 'min' }]));
}

// ------------------------------------------------------------ 5. current thermal.ts for comparison
const current = (kw, t) => { const dT = Math.min(30, 3 * kw), tau = 2 + 24 / kw; return 22 + dT * (1 - Math.exp(-t / tau)); };
const currentTo = (kw, th) => { for (let t = 0; t <= 120; t += 0.1) if (current(kw, t) >= th) return r1(t); return null; };
results.currentThermalTs = [6, 8, 10, 31].map((kw) => ({ kw, asymptoteC: 22 + Math.min(30, 3 * kw), min_to32: currentTo(kw, 32), min_to35: currentTo(kw, 35), min_to40: currentTo(kw, 40) }));

if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, null, 1));
