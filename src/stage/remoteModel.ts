/**
 * Pure helpers for the phone remote (#/stage): what is wrong right now, and what the engine
 * predicts. Every number comes from the engine run (Monte Carlo p50 clocks); nothing is invented.
 * Callers pass the FORECAST run (store `forecast`, audit C1): only faults observed or inferable
 * by t, so nothing here counts down to a fault nobody can see yet.
 */
import { facility } from '../domain/fixture';
import type { ID, ImpactClock, Incident, Severity } from '../domain/types';
import type { ScenarioRun } from '../domain/engine';

const assetType = new Map(facility.assets.map((a) => [a.id, a.type]));
const assetLabel = new Map(facility.assets.map((a) => [a.id, a.name]));
export const nameOf = (id: ID) => assetLabel.get(id) ?? id;

export interface Problem {
  assetId: ID;
  title: string;
  severity: Severity;
  /** Minutes until this asset is modeled lost (p50), if it is on a clock and not yet lost */
  inMin: number | null;
  lost: boolean;
  incidentId?: ID;
}

const SEV_RANK: Record<Severity, number> = { critical: 3, warning: 2, advisory: 1, normal: 0 };

/** Down = p50 reached and not recovered (a fix can bring an asset back: recoveredP50). */
export function isDown(c: ImpactClock | undefined, t: number): boolean {
  if (!c || c.p50 === null || c.p50 > t) return false;
  return !(c.recoveredP50 != null && c.recoveredP50 <= t);
}

/**
 * Problems to act on: open incidents first (their root asset), then the non-rack assets with the
 * nearest clocks. One row per asset, at most `max`.
 */
export function problemList(incidents: Incident[], run: ScenarioRun, t: number, max = 6): Problem[] {
  const out: Problem[] = [];
  const seen = new Set<ID>();
  const clockOf = (id: ID) => run.clocks[id];
  const inMinOf = (id: ID) => {
    const c = clockOf(id);
    return c && c.p50 !== null && c.p50 > t ? Math.round((c.p50 - t) * 10) / 10 : null;
  };
  const open = incidents.filter((i) => i.status !== 'resolved' && i.openedAt <= t)
    .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || a.openedAt - b.openedAt);
  for (const i of open) {
    if (seen.has(i.rootAssetId)) continue;
    seen.add(i.rootAssetId);
    out.push({ assetId: i.rootAssetId, title: i.title, severity: i.severity, inMin: inMinOf(i.rootAssetId), lost: isDown(clockOf(i.rootAssetId), t), incidentId: i.id });
  }
  const clocks = Object.values(run.clocks)
    .filter((c) => c.p50 !== null && assetType.get(c.assetId) !== 'rack' && !seen.has(c.assetId))
    .filter((c) => c.p50! > t - 5) // gone for a while → history, not a problem to fix
    .sort((a, b) => a.p50! - b.p50!);
  for (const c of clocks) {
    if (out.length >= max) break;
    const left = c.p50! - t;
    const lost = isDown(c, t);
    const severity: Severity = lost || left <= 10 ? 'critical' : left <= 30 ? 'warning' : 'advisory';
    seen.add(c.assetId);
    out.push({ assetId: c.assetId, title: lost ? `${nameOf(c.assetId)} lost` : `${nameOf(c.assetId)} on a clock`, severity, inMin: lost ? null : Math.round(left * 10) / 10, lost });
  }
  return out.slice(0, max);
}

export interface PredictionSummary {
  /** Racks the engine expects lost by the end of the scenario (p50 within horizon, not recovered by then) */
  racksLostByEnd: number;
  racksTotal: number;
  /** First rack loss still ahead of t (scenario minute), or null */
  nextRackLoss: { assetId: ID; at: number } | null;
  /** Assets newly lost between t and t + lookahead */
  lostInWindow: ID[];
  /** The next asset loss after t, any type */
  nextLoss: { assetId: ID; at: number } | null;
  horizonMin: number;
}

export function predictionSummary(run: ScenarioRun, t: number, lookaheadMin: number, horizonMin: number): PredictionSummary {
  const racks = facility.assets.filter((a) => a.type === 'rack');
  let racksLostByEnd = 0;
  let nextRackLoss: PredictionSummary['nextRackLoss'] = null;
  let nextLoss: PredictionSummary['nextLoss'] = null;
  const lostInWindow: ID[] = [];
  for (const c of Object.values(run.clocks)) {
    if (c.p50 === null) continue;
    const isRack = assetType.get(c.assetId) === 'rack';
    if (isRack && isDown(c, horizonMin)) racksLostByEnd++;
    if (c.p50 > t) {
      if (!nextLoss || c.p50 < nextLoss.at) nextLoss = { assetId: c.assetId, at: c.p50 };
      if (isRack && (!nextRackLoss || c.p50 < nextRackLoss.at)) nextRackLoss = { assetId: c.assetId, at: c.p50 };
      if (lookaheadMin > 0 && c.p50 <= t + lookaheadMin) lostInWindow.push(c.assetId);
    }
  }
  return { racksLostByEnd, racksTotal: racks.length, nextRackLoss, lostInWindow, nextLoss, horizonMin };
}

/** `observed` false: nothing observed yet leads to a loss, so there is nothing to count down to. */
export function summaryLines(p: PredictionSummary, t: number, lookaheadMin: number, observed = true): string[] {
  if (!observed) return ['No observed fault · watching.', `${p.racksLostByEnd} of ${p.racksTotal} racks lost by T+${p.horizonMin} from what is observed so far.`];
  const lines: string[] = [];
  lines.push(p.nextLoss ? `Next loss: ${nameOf(p.nextLoss.assetId)} in ${fmtMin(p.nextLoss.at - t)}` : 'No further losses forecast within the scenario.');
  lines.push(p.nextRackLoss ? `First rack down in ${fmtMin(p.nextRackLoss.at - t)} (${p.nextRackLoss.assetId})` : 'No rack loss forecast within the scenario.');
  lines.push(`${p.racksLostByEnd} of ${p.racksTotal} racks lost by T+${p.horizonMin} if nothing else changes.`);
  if (lookaheadMin > 0) lines.push(p.lostInWindow.length ? `Next ${lookaheadMin} min: ${p.lostInWindow.length} more asset${p.lostInWindow.length === 1 ? '' : 's'} lost.` : `Next ${lookaheadMin} min: no new losses.`);
  return lines;
}

export const fmtMin = (m: number) => (m < 1 ? 'under a minute' : `${Math.round(m)} min`);
