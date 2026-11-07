/**
 * Rack inlet temperature after loss of cooling — lumped first-order model.
 *
 * INDICATIVE ONLY, not CFD: it ignores airflow paths, recirculation, neighbouring racks and
 * room volume beyond the per-kW constants below. It exists so the UI can show a plausible
 * temperature trend on a clock that the dependency graph already predicts.
 *
 *   T(t) = base                                         for t < lost (or lost = null)
 *   T(t) = base + ΔTmax · (1 − e^(−(t − lost)/τ))       after loss
 *   ΔTmax = 1.6 · rackKw  °C,   τ = 4 + 60 / rackKw  min
 * Higher-density racks heat further and faster.
 */
export function inletTempAt(baseC: number, rackKw: number, coolingLostAt: number | null, t: number): number {
  if (coolingLostAt === null || t <= coolingLostAt) return baseC;
  const kw = Math.max(rackKw, 0.1);
  const dTmax = 1.6 * kw;
  const tau = 4 + 60 / kw;
  return baseC + dTmax * (1 - Math.exp(-(t - coolingLostAt) / tau));
}
