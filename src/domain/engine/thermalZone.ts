/**
 * Physics thermal model after cooling loss: lumped room-air / IT-mass / chilled-water energy balance
 * (PREDICTION-SCIENCE.md §2.1; Schneider WP179 and patents US9418179B2 / US10817033). Port of the
 * reference implementation `research/scripts/thermal_backtest.mjs`.
 *
 *   C_a dT_a/dt = P_air − Q_coil − G (T_a − T_m)        room air, well mixed (≈ rack inlet)
 *   C_m dT_m/dt = G (T_a − T_m)                          IT + rack steel
 *   C_w dT_w/dt = Q_coil − Q_chiller                     chilled-water loop
 *   C_a = ρ c_p V,  C_m = N m_rack c_m,  G = k_G ε ṁ_IT c_p (ṁ_IT from 125 cfm/kW = 0.059 m³/s per kW)
 *   Q_coil = fans on ? ṁ_crah c_p (T_a − T_s) : 0,  T_s = max(T_set, T_a − ε_coil (T_a − T_w))
 *
 * k_G (fitted multiplier, U(1.5, 3)) stands in for server fans ramping and other thermal mass; with
 * k_G = 2 the model reproduces the WP179 peaks within about 0.5–3.5 °C (tests/engine/thermalZone.test.ts).
 * It is lumped, not CFD: one rack's inlet can be several °C hotter than its zone.
 *
 * Two clocks per zone (dossier §2.1 rec. 4): the 32 °C ASHRAE A1 envelope crossing, and the
 * service-impact crossing at T_trip ~ U(40, 45) °C.
 */
import type { Facility, ID } from '../types';

export const RHO_AIR = 1.19;
export const CP_AIR = 1006;
const RHO_W = 1000, CP_W = 4186;
/** 125 cfm/kW (WP179) */
export const IT_AIRFLOW_M3S_PER_KW = 0.059;
export const IT_SPECIFIC_HEAT = 650;
/** Share of a direct-liquid-cooled rack's power rejected to room air (assumption) */
export const DLC_AIR_SHARE = 0.15;
export const ENVELOPE_C = 32;

// ------------------------------------------------------------------ generic simulator (backtest)

export interface ThermalSimParams {
  airVolM3: number; itMassJperK: number; waterM3: number; crahFlowM3s: number;
  /** IT–air conductance W/K (already including k_G) */
  G: number;
  P: number; TsetAir: number; TsetWater: number; epsCoil: number; Qcap: number;
  Ta0?: number;
  fansOn: (tS: number) => boolean; chillerOn: (tS: number) => boolean;
  chillerOnAtS?: number; chillerRampS?: number;
  horizonS: number; every: number; dt?: number;
}
export interface ThermalSample { t: number; Ta: number; Tm: number; Tw: number }

/** Explicit Euler, as the reference script. Returns samples every `every` seconds. */
export function simulateThermal(p: ThermalSimParams): ThermalSample[] {
  const C_a = RHO_AIR * CP_AIR * p.airVolM3;
  const C_m = p.itMassJperK;
  const C_w = RHO_W * CP_W * p.waterM3;
  const mcp = RHO_AIR * CP_AIR * p.crahFlowM3s;
  let Ta = p.Ta0 ?? p.TsetAir + p.P / mcp, Tm = Ta, Tw = p.TsetWater;
  const dt = p.dt ?? 0.5;
  const out: ThermalSample[] = [];
  for (let t = 0; t <= p.horizonS + 1e-9; t += dt) {
    if (Math.abs(t / p.every - Math.round(t / p.every)) < 1e-9) out.push({ t, Ta, Tm, Tw });
    let Qc = 0;
    if (p.fansOn(t)) {
      const Ts = Math.max(p.TsetAir, Ta - p.epsCoil * (Ta - Tw));
      Qc = Math.max(0, mcp * (Ta - Ts));
    }
    const ramp = p.chillerRampS && p.chillerOnAtS !== undefined ? Math.min(1, Math.max(0, (t - p.chillerOnAtS) / p.chillerRampS)) : 1;
    const Qch = p.chillerOn(t) ? Math.max(0, Math.min(p.Qcap * ramp, Qc + (C_w * (Tw - p.TsetWater)) / 60)) : 0;
    const dTa = (p.P - Qc - p.G * (Ta - Tm)) / C_a;
    const dTm = (p.G * (Ta - Tm)) / C_m;
    const dTw = (Qc - Qch) / C_w;
    Ta += dTa * dt; Tm += dTm * dt; Tw += dTw * dt;
  }
  return out;
}

// ------------------------------------------------------------------ the fixture hall

export interface ZoneSpec { id: string; crahs: ID[]; racks: ID[]; airKw: number; areaM2: number }
export interface HallSpec { zones: ZoneSpec[]; gpuRacks: ID[]; airKwTotal: number; dlcKw: number; areaM2: number; rackCount: number; zoneOf: Map<ID, string> }

/**
 * Zones = CRAH pairs: north (rows A–B, CRAH-1/3) and south (rows C–D air-cooled, CRAH-2/4), from the
 * facility's own `cools` edges. Direct-liquid-cooled racks (fed by a CDU) reject DLC_AIR_SHARE to air.
 */
export function zonesFor(facility: Facility): HallSpec {
  const hall = facility.zones.find((z) => z.kind === 'hall');
  const areaM2 = hall ? hall.rect.w * hall.rect.d : 576;
  const racks = facility.assets.filter((a) => a.type === 'rack');
  const typeOf = new Map(facility.assets.map((a) => [a.id, a.type]));
  const coolers = new Map<ID, ID[]>();
  for (const e of facility.edges) if (e.kind === 'cools' && typeOf.get(e.to) === 'rack') coolers.set(e.to, [...(coolers.get(e.to) ?? []), e.from]);
  const byPair = new Map<string, ZoneSpec>();
  const gpuRacks: ID[] = [];
  let dlcKw = 0;
  const zoneOf = new Map<ID, string>();
  for (const r of racks) {
    const src = (coolers.get(r.id) ?? []).slice().sort();
    if (src.some((s) => typeOf.get(s) === 'cdu')) { gpuRacks.push(r.id); dlcKw += r.loadKw ?? 0; continue; }
    if (!src.length) continue;
    const key = src.join('+');
    let z = byPair.get(key);
    if (!z) { z = { id: key, crahs: src, racks: [], airKw: 0, areaM2: 0 }; byPair.set(key, z); }
    z.racks.push(r.id); z.airKw += r.loadKw ?? 6;
    zoneOf.set(r.id, key);
  }
  const zones = [...byPair.values()];
  const n = zones.reduce((s, z) => s + z.racks.length, 0) || 1;
  for (const z of zones) z.areaM2 = (areaM2 * z.racks.length) / n;
  // the DLC racks' air share heats the zone of the air-cooled racks in the same row
  const rowOf = new Map(racks.map((r) => [r.id, r.location.row]));
  for (const id of gpuRacks) {
    const z = zones.find((x) => x.racks.some((r) => rowOf.get(r) === rowOf.get(id))) ?? zones[0];
    if (z) z.airKw += DLC_AIR_SHARE * (racks.find((r) => r.id === id)?.loadKw ?? 0);
  }
  return { zones, gpuRacks, airKwTotal: zones.reduce((s, z) => s + z.airKw, 0), dlcKw, areaM2, rackCount: racks.length, zoneOf };
}

export interface ThermalTheta {
  kG: number; eps: number; rackMassKg: number; ceilingM: number; plenumM: number; mixFrac: number;
  loopLPerKw: number; coilFrac: number; startC: number; tTripC: number;
}
export const NOMINAL_THETA: ThermalTheta = { kG: 2, eps: 0.8, rackMassKg: 545, ceilingM: 3.5, plenumM: 0.6, mixFrac: 0.25, loopLPerKw: 6, coilFrac: 0.2, startC: 22.5, tTripC: 42.5 };

/**
 * Fans-off zone, closed form of the two-node system with constant P:
 *   T̄ = T0 + P t / C,  D = T_a − T_m = D∞ (1 − e^(−t/τ)),  τ = 1 / (G (1/C_a + 1/C_m)),  D∞ = P τ / C_a
 *   T_a(t) = T̄ + (C_m / C) D
 * Returns minutes to reach `thresholdC` from the loss, or Infinity beyond `horizonMin`.
 */
export function fansOffMinutes(zone: Pick<ZoneSpec, 'airKw' | 'areaM2' | 'racks'>, th: ThermalTheta, thresholdC: number, horizonMin = 120): number {
  if (th.startC >= thresholdC) return 0;
  const h = th.ceilingM + th.plenumM;
  const V = zone.areaM2 * h * (1 + th.mixFrac);
  const Ca = RHO_AIR * CP_AIR * V;
  const Cm = zone.racks.length * th.rackMassKg * IT_SPECIFIC_HEAT;
  const P = zone.airKw * 1000;
  const G = th.kG * th.eps * RHO_AIR * CP_AIR * IT_AIRFLOW_M3S_PER_KW * zone.airKw;
  const C = Ca + Cm;
  const tau = 1 / (G * (1 / Ca + 1 / Cm));
  const Dinf = (P * tau) / Ca;
  const Ta = (tS: number) => th.startC + (P * tS) / C + (Cm / C) * Dinf * (1 - Math.exp(-tS / tau));
  const hi = horizonMin * 60;
  if (Ta(hi) < thresholdC) return Infinity;
  let lo = 0, up = hi;
  for (let i = 0; i < 40; i++) { const m = (lo + up) / 2; if (Ta(m) >= thresholdC) up = m; else lo = m; }
  return up / 60;
}

/**
 * Fans running, chilled water lost (`waterShare` = 1: whole loop warms; < 1: pumps stopped, only the
 * coil water is left). Explicit Euler, dt = 2 s (air-node time constant ≈ 35 s, stable).
 * Returns minutes to each threshold (Infinity beyond the horizon).
 */
export function fansOnMinutes(hall: Pick<HallSpec, 'airKwTotal' | 'dlcKw' | 'areaM2' | 'rackCount'>, th: ThermalTheta, waterShare: number, thresholds: number[], horizonMin = 90): number[] {
  const h = th.ceilingM + th.plenumM;
  const Ca = RHO_AIR * CP_AIR * hall.areaM2 * h;
  const Cm = hall.rackCount * th.rackMassKg * IT_SPECIFIC_HEAT;
  const Cw = RHO_W * CP_W * Math.max(1e-3, (th.loopLPerKw * (hall.airKwTotal + hall.dlcKw * (1 - DLC_AIR_SHARE)) * waterShare) / 1000);
  const P = hall.airKwTotal * 1000;
  const G = th.kG * th.eps * RHO_AIR * CP_AIR * IT_AIRFLOW_M3S_PER_KW * hall.airKwTotal;
  const mcp = RHO_AIR * CP_AIR * IT_AIRFLOW_M3S_PER_KW * 1.2 * hall.airKwTotal; // CRAH airflow 1.2 × IT (assumption)
  const Tset = th.startC - P / mcp;
  let Ta = th.startC, Tm = Ta, Tw = 10;
  const out = thresholds.map(() => Infinity);
  const dt = 2;
  const maxT = horizonMin * 60;
  const top = Math.max(...thresholds);
  for (let t = 0; t <= maxT; t += dt) {
    for (let i = 0; i < thresholds.length; i++) if (out[i] === Infinity && Ta >= thresholds[i]) out[i] = t / 60;
    if (Ta >= top) break;
    const Ts = Math.max(Tset, Ta - 0.75 * (Ta - Tw));
    const Qc = Math.max(0, mcp * (Ta - Ts));
    const dTa = (P - Qc - G * (Ta - Tm)) / Ca;
    const dTm = (G * (Ta - Tm)) / Cm;
    Ta += dTa * dt; Tm += dTm * dt; Tw += (Qc / Cw) * dt;
  }
  return out;
}

export interface ZoneClocks {
  /** minutes from fan loss in each zone to [32 °C, T_trip] */
  off: Map<string, [number, number]>;
  /** minutes from loss of chilled-water production (fans on) to [32 °C, T_trip] */
  chw: [number, number];
  /** minutes from loss of chilled-water flow (pumps stopped, coil water only) to [32 °C, T_trip] */
  flow: [number, number];
}

/** All crossing times for one parameter draw (shared by every inner trial — correlated racks). */
export function zoneClocks(hall: HallSpec, th: ThermalTheta, horizonMin = 90): ZoneClocks {
  const off = new Map<string, [number, number]>();
  for (const z of hall.zones) off.set(z.id, [fansOffMinutes(z, th, ENVELOPE_C, horizonMin), fansOffMinutes(z, th, th.tTripC, horizonMin)]);
  const chw = fansOnMinutes(hall, th, 1, [ENVELOPE_C, th.tTripC], horizonMin) as [number, number];
  const flow = fansOnMinutes(hall, th, th.coilFrac, [ENVELOPE_C, th.tTripC], horizonMin) as [number, number];
  return { off, chw, flow };
}
