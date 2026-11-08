/**
 * Plain-language readouts of engine output for the workspace, presenter and phone views.
 * Pure functions: every number comes from a ScenarioRun / ImpactClock / FixPrediction.
 */
import type { Facility, ID, ImpactClock, Scenario } from '../domain/types';
import type { ScenarioRun } from '../domain/engine';
import type { FixPrediction } from '../domain/engine/fixes';

/** "T−15 min" + optional "(12–18)" range + a likelihood phrase instead of "100% of runs…". */
export function clockText(c: ImpactClock, now: number, horizon: number): { main: string; range: string; likelihood: string; lost: boolean } {
  const lost = c.p50 != null && c.p50 <= now;
  const rem = (v: number | null) => (v == null ? null : Math.max(0, Math.round(v - now)));
  const lo = rem(c.p10), mid = rem(c.p50), hi = rem(c.p90);
  const main = lost ? 'LOST' : mid == null ? `>${horizon} min` : `T−${mid} min`;
  const range = lost || mid == null || lo == null ? '' : lo === hi ? '' : `(${lo}–${hi ?? `>${horizon}`})`;
  return { main, range, likelihood: likelihood(c.probWithinHorizon, horizon), lost };
}

export function likelihood(p: number, horizon: number): string {
  const pct = Math.round(p * 100);
  const within = horizon === 60 ? 'within the hour' : `within ${horizon} min`;
  if (pct >= 99) return `Certain ${within}`;
  if (pct >= 70) return `Likely ${within} (${pct} %)`;
  if (pct >= 30) return `Possible ${within} (${pct} %)`;
  if (pct > 0) return `Unlikely ${within} (${pct} %)`;
  return `Not expected ${within}`;
}

export interface Forecast {
  /** First rack expected lost (p50), absolute scenario minute */
  firstRack: { assetId: ID; at: number } | null;
  /** Earliest loss of anything still ahead of `t` */
  next: { assetId: ID; at: number } | null;
  racksLost: number;
  racksLostNow: number;
  assetsLost: number;
  /** Services hosted on racks lost by the horizon, most critical first */
  servicesAtRisk: { id: ID; name: string; criticality: number }[];
}

/** "If nothing changes": what the run predicts by the end of the horizon (p50). */
export function forecast(run: ScenarioRun, scenario: Scenario, facility: Facility, t: number): Forecast {
  const H = scenario.horizonMin;
  const byId = new Map(facility.assets.map((a) => [a.id, a]));
  const lost = Object.values(run.clocks).filter((c) => c.p50 != null && c.p50 <= H && byId.has(c.assetId));
  const racks = lost.filter((c) => byId.get(c.assetId)!.type === 'rack').sort((a, b) => a.p50! - b.p50!);
  const ahead = lost.filter((c) => c.p50! > t).sort((a, b) => a.p50! - b.p50!);
  const svc = new Map<ID, { id: ID; name: string; criticality: number }>();
  for (const c of racks) {
    for (const sid of byId.get(c.assetId)!.services ?? []) {
      const s = facility.services.find((x) => x.id === sid);
      if (s) svc.set(s.id, { id: s.id, name: s.name, criticality: s.criticality });
    }
  }
  return {
    firstRack: racks[0] ? { assetId: racks[0].assetId, at: racks[0].p50! } : null,
    next: ahead[0] ? { assetId: ahead[0].assetId, at: ahead[0].p50! } : null,
    racksLost: racks.length,
    racksLostNow: racks.filter((c) => c.p50! <= t).length,
    assetsLost: lost.length,
    servicesAtRisk: [...svc.values()].sort((a, b) => b.criticality - a.criticality),
  };
}

const atText = (v: number | null) => (v == null ? 'none within the horizon' : `T+${Math.round(v)}`);

/** "Saves 12 racks · first rack loss moves from T+44 to none" */
export function describeFix(p: FixPrediction): { headline: string; detail: string; helps: boolean } {
  const racks = p.racksWithout - p.racksWith;
  const assets = p.lostWithout - p.lostWith;
  const moved = p.firstRackLossWithout !== p.firstRackLossWith;
  const helps = racks > 0 || assets > 0 || (moved && (p.firstRackLossWith == null || (p.firstRackLossWithout != null && p.firstRackLossWith > p.firstRackLossWithout)));
  const headline = racks > 0 ? `Saves ${racks} rack${racks === 1 ? '' : 's'}`
    : assets > 0 ? `Saves ${assets} asset${assets === 1 ? '' : 's'}`
    : helps ? 'Buys time' : 'No predicted change';
  const detail = moved
    ? `First rack loss moves from ${atText(p.firstRackLossWithout)} to ${p.firstRackLossWith == null ? 'none' : atText(p.firstRackLossWith)}`
    : p.firstRackLossWithout == null ? 'No rack loss predicted either way' : `First rack loss stays at ${atText(p.firstRackLossWithout)}`;
  return { headline, detail, helps };
}

/** Shareable URL of a hash route on this host (for the "open on your phone" hint). */
export function routeUrl(hash: string): { url: string; local: boolean } {
  const { protocol, host, pathname, hostname } = window.location;
  const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  return { url: `${protocol}//${host}${pathname}${hash}`, local };
}

/**
 * Show the water layer once the leak is observable: the first non-fault step at or after the leak
 * starts (a flow mismatch, an alarm), else the leak start itself. Works for generated scenarios too.
 */
export function leakVisible(scenario: Scenario, t: number): boolean {
  const leak = scenario.leak;
  if (!leak) return false;
  const signs = scenario.steps.filter((s) => s.kind !== 'fault' && s.t >= leak.startT).map((s) => s.t);
  const at = signs.length ? Math.min(...signs) : leak.startT;
  return t >= at;
}
