/**
 * Rack inlet temperature after loss of cooling — lumped first-order model.
 *
 * INDICATIVE ONLY, not CFD: it ignores airflow paths, recirculation, neighbouring racks and
 * room volume beyond the per-kW constants below. It exists so the UI can show a plausible
 * temperature trend on a clock that the dependency graph already predicts.
 *
 *   T(t) = base                                         for t < lost (or lost = null)
 *   T(t) = base + ΔTmax · (1 − e^(−(t − lost)/τ))       after loss
 *   ΔTmax = min(30, 3 · rackKw)  °C,   τ = 2 + 24 / rackKw  min
 *
 * Calibrated to agree with the cascade's thermal ride-through edges (fixture: 3–10 min, mode 6,
 * after Opengate 2007 — shutdown in ~3 min at 5 kW/cabinet): a 6 kW rack crosses the ASHRAE
 * allowable limit (32 °C) at about the 6-minute mode, a 10 kW rack within ~3 min, and a 31 kW
 * liquid-cooled rack within ~2 min. Before the audit (ΔTmax = 1.6·kW, τ = 4 + 60/kW) a 6 kW rack
 * was still at ~25 °C when the cascade had already declared it lost.
 */
export const THERMAL_MAX_RISE_C = 30;
export const THERMAL_RISE_C_PER_KW = 3;

export function inletTempAt(baseC: number, rackKw: number, coolingLostAt: number | null, t: number): number {
  if (coolingLostAt === null || t <= coolingLostAt) return baseC;
  const kw = Math.max(rackKw, 0.1);
  const dTmax = Math.min(THERMAL_MAX_RISE_C, THERMAL_RISE_C_PER_KW * kw);
  const tau = 2 + 24 / kw;
  return baseC + dTmax * (1 - Math.exp(-(t - coolingLostAt) / tau));
}
