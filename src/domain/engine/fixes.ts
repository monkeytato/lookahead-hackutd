/**
 * Remediation: what an operator can do about a problem, and what the engine predicts it saves.
 *
 * UI code calls:
 *   fixOptionsFor(ctx, assetId)  → actions available for an asset at time ctx.t
 *   makeFix(option, t)           → a Fix to send through the stage
 *   predictFix(ctx, option)      → counterfactual: the run with and without the fix
 *   predictionSummary(run, scenario, t, lookaheadMin) → "if nothing changes" numbers
 *
 * Delays are ASSUMPTIONS (walk + work time for a small night crew) and are shown in the UI.
 * A fix repairs its asset from effectiveAt; see the recovery rules in cascade.ts.
 */
import { facility as fixtureFacility, services as fixtureServices } from '../fixture';
import type { Facility, Fix, FixAction, ID, Reading, Scenario } from '../types';
import { leakSource, simulateScenario, type ScenarioRun } from './simulate';

export interface FixOption {
  action: FixAction;
  assetId: ID;
  /** Imperative, operator wording: "Close the riser isolation valve" */
  label: string;
  /** Why this helps, one sentence */
  description: string;
  /** Minutes from ordering to effect (walk + work), an assumption shown in the UI */
  delayMin: number;
}

export interface FixPrediction {
  /** Assets lost within the horizon without / with the fix */
  lostWithout: number;
  lostWith: number;
  /** Racks lost within the horizon without / with the fix */
  racksWithout: number;
  racksWith: number;
  /** Asset ids that the fix saves */
  savedAssetIds: ID[];
  /** First rack loss (scenario minute, p50) without / with; null = none within the horizon */
  firstRackLossWithout: number | null;
  firstRackLossWith: number | null;
}

export interface FixContext {
  facility: Facility; scenario: Scenario; seedReadings: Reading[]; fixes: Fix[]; t: number;
  /** The current run (with ctx.fixes), if the caller already has it — saves a simulation */
  run?: ScenarioRun;
}

export interface PredictionSummary {
  horizonMin: number;
  /** Earliest rack loss (p50, scenario minute), past or future; null = none within the horizon */
  firstRackLoss: number | null;
  racksLostByHorizon: number;
  assetsLostByHorizon: number;
  /** Assets whose loss (p50) falls in (t, t + lookaheadMin] */
  lostIn: ID[];
  /** Services with at least one replica lost by the horizon */
  servicesAtRisk: ID[];
  /** Services with every replica lost by the horizon */
  servicesDown: ID[];
}

const COUNTERFACTUAL_RUNS = 150;

// ---- run cache (the UI asks for options and predictions on every render)
const runCache = new Map<string, ScenarioRun>();
function cachedRun(ctx: FixContext, fixes: Fix[], runs: number): ScenarioRun {
  const key = `${ctx.scenario.id}|${runs}|${fixes.map((f) => `${f.assetId}@${f.effectiveAt}`).sort().join(',')}`;
  let r = runCache.get(key);
  if (!r) {
    r = simulateScenario({ facility: ctx.facility, scenario: ctx.scenario, seedReadings: ctx.seedReadings, fixes, runs });
    runCache.set(key, r);
    if (runCache.size > 32) runCache.delete(runCache.keys().next().value!);
  }
  return r;
}

const OPTION: Record<FixAction, { label: (id: ID) => string; description: string; delayMin: number }> = {
  isolate_valve: { label: (id) => (id.startsWith('CDU') ? `Isolate ${id} and its secondary loop` : `Close the isolation valves on ${id}`), description: 'Stops the water at the source; what is already on the floor still spreads and drains.', delayMin: 4 },
  restart_chiller: { label: (id) => `Restart ${id} manually`, description: 'A technician resets the trip and runs the restart sequence at the unit.', delayMin: 7 },
  reset_fan: { label: (id) => `Reset the ${id} fan`, description: 'Clears the trip and restarts the fan; buys time until the bearing is replaced.', delayMin: 5 },
  swap_crah: { label: (id) => `Cover ${id} with the standby unit`, description: 'Brings standby cooling online for the rows this unit serves.', delayMin: 10 },
  manual_gen_start: { label: () => 'Start GEN-1 manually', description: 'Starts the generator at its local panel so the transfer switch has a source again.', delayMin: 5 },
  transfer_ups: { label: (id) => `Transfer ${id} load to the healthy path`, description: 'Moves the load to the other UPS path before this one drops it.', delayMin: 3 },
  suppress_fire: { label: (id) => `Release fire suppression at ${id}`, description: 'Discharges the clean-agent system in the room; stops the fire front where it is.', delayMin: 2 },
  reset_breaker: { label: (id) => `Reset the ${id} main breaker`, description: 'Re-closes the breaker after checking for a fault; restores the second feed.', delayMin: 4 },
  shed_load: { label: (id) => `Shed non-critical load on ${id}`, description: 'Powers down non-critical workloads so the rack rides through longer.', delayMin: 3 },
  deploy_portable_cooling: { label: (id) => `Deploy portable cooling at ${id}`, description: 'Spot cooling in the cold aisle; slow to set up but keeps the rack in range.', delayMin: 12 },
};

const opt = (action: FixAction, assetId: ID): FixOption => ({ action, assetId, label: OPTION[action].label(assetId), description: OPTION[action].description, delayMin: OPTION[action].delayMin });

/** First minute anyone could know about trouble at this asset (alert/reading steps, else its fault). */
function detectedAt(scenario: Scenario, assetId: ID): number {
  const obs = scenario.steps.filter((s) => s.assetId === assetId && s.kind !== 'fault').map((s) => s.t);
  if (obs.length) return Math.min(...obs);
  const f = scenario.faults.find((x) => x.assetId === assetId);
  return f ? f.t : Infinity;
}

/** Fix options for one asset at time t (empty when nothing applies or it is already being fixed). */
export function fixOptionsFor(ctx: FixContext, assetId: ID): FixOption[] {
  const { scenario, t } = ctx;
  const asset = ctx.facility.assets.find((a) => a.id === assetId);
  if (!asset) return [];
  const run = ctx.run ?? cachedRun(ctx, ctx.fixes, COUNTERFACTUAL_RUNS);
  const vis = run.visualAt(t)[assetId];
  const clock = run.clocks[assetId];

  const faulted = scenario.faults.some((f) => f.assetId === assetId && f.t <= t) && detectedAt(scenario, assetId) <= t;
  const leakSrc = scenario.leak && leakSource(ctx.facility, scenario.leak) === assetId && detectedAt(scenario, assetId) <= t && scenario.leak.startT <= t;
  const fireOrigin = (scenario.hazards ?? []).some((h) => h.kind === 'fire' && h.originAssetId === assetId && h.startT <= t);
  // a clock counts once its root fault is observable (no prophetic fixes) and the loss is still ahead
  const onClock = !!clock && clock.p50 !== null && clock.p50 > t && detectedAt(scenario, clock.path[0]) <= t;
  const troubled = faulted || !!leakSrc || fireOrigin || !!vis?.wet || !!vis?.burning || onClock || !!vis?.lost;
  if (!troubled) return [];

  // what the clock runs through just before this asset (cooling fixes don't help a power loss)
  const via = clock ? ctx.facility.assets.find((a) => a.id === clock.path[clock.path.length - 2]) : undefined;
  const powerCause = !!via && ['utility', 'ats', 'generator', 'ups', 'battery', 'pdu'].includes(via.type);
  const out: FixOption[] = [];
  switch (asset.type) {
    case 'pipe': case 'cdu': if (leakSrc) out.push(opt('isolate_valve', assetId)); else if (asset.type === 'cdu' && (faulted || onClock)) out.push(opt('swap_crah', assetId)); break;
    case 'chiller': if (faulted || vis?.lost) out.push(opt('restart_chiller', assetId)); break;
    case 'crah': if (faulted || vis?.lost) out.push(opt('reset_fan', assetId)); if (faulted || !powerCause) out.push(opt('swap_crah', assetId)); break;
    case 'generator': case 'ats': case 'utility': out.push(opt('manual_gen_start', 'GEN-1')); break;
    case 'ups': if (fireOrigin) out.push(opt('suppress_fire', assetId)); else out.push(opt('transfer_ups', assetId)); break;
    case 'battery': if (vis?.burning || fireOrigin) out.push(opt('suppress_fire', assetId)); break;
    case 'pdu': if (faulted || vis?.lost) out.push(opt('reset_breaker', assetId)); break;
    case 'rack': {
      if (vis?.lost) break;
      out.push(opt('shed_load', assetId));
      if (!via || via.type === 'crah' || via.type === 'cdu' || via.type === 'pump' || via.type === 'chiller') out.push(opt('deploy_portable_cooling', assetId));
      break;
    }
    default: break;
  }
  if (fireOrigin && asset.type !== 'ups' && asset.type !== 'battery') out.unshift(opt('suppress_fire', assetId));
  // drop actions already ordered for this asset
  return out.filter((o) => !ctx.fixes.some((f) => f.assetId === o.assetId && f.action === o.action));
}

/** Build a Fix from an option ordered at time t. */
export function makeFix(o: FixOption, t: number): Fix {
  return { id: `FIX-${o.action}-${o.assetId}-${Math.round(t * 10)}`, assetId: o.assetId, action: o.action, label: o.label, orderedAt: t, effectiveAt: t + o.delayMin };
}

const lostIds = (run: ScenarioRun) => Object.values(run.clocks).filter((c) => c.p50 !== null).map((c) => c.assetId);
const rackSet = (f: Facility) => new Set(f.assets.filter((a) => a.type === 'rack').map((a) => a.id));
function firstRack(run: ScenarioRun, racks: Set<ID>): number | null {
  let m: number | null = null;
  for (const c of Object.values(run.clocks)) if (racks.has(c.assetId) && c.p50 !== null && (m === null || c.p50 < m)) m = c.p50;
  return m;
}

/** Counterfactual run: the scenario with the existing fixes vs. with this extra one ordered at ctx.t. */
export function predictFix(ctx: FixContext, option: FixOption): FixPrediction {
  const without = cachedRun(ctx, ctx.fixes, COUNTERFACTUAL_RUNS);
  const withFix = cachedRun(ctx, [...ctx.fixes, makeFix(option, ctx.t)], COUNTERFACTUAL_RUNS);
  const racks = rackSet(ctx.facility);
  const a = lostIds(without), b = new Set(lostIds(withFix));
  return {
    lostWithout: a.length,
    lostWith: b.size,
    racksWithout: a.filter((id) => racks.has(id)).length,
    racksWith: [...b].filter((id) => racks.has(id)).length,
    savedAssetIds: a.filter((id) => !b.has(id) && ctx.facility.assets.some((x) => x.id === id)),
    firstRackLossWithout: firstRack(without, racks),
    firstRackLossWith: firstRack(withFix, racks),
  };
}

/** "If nothing changes" numbers for the prediction panel and the phone remote. */
export function predictionSummary(run: ScenarioRun, scenario: Scenario, t: number, lookaheadMin: number, facility: Facility = fixtureFacility): PredictionSummary {
  const racks = rackSet(facility);
  const known = new Set(facility.assets.map((a) => a.id));
  const lost = lostIds(run).filter((id) => known.has(id));
  const lostSet = new Set(lost);
  const lostIn = Object.values(run.clocks)
    .filter((c) => known.has(c.assetId) && c.p50 !== null && c.p50 > t && c.p50 <= t + lookaheadMin && !(run.restoredAt[c.assetId] <= c.p50))
    .sort((x, y) => x.p50! - y.p50!)
    .map((c) => c.assetId);
  const svc = facility === fixtureFacility ? fixtureServices : facility.services;
  return {
    horizonMin: scenario.horizonMin,
    firstRackLoss: firstRack(run, racks),
    racksLostByHorizon: lost.filter((id) => racks.has(id)).length,
    assetsLostByHorizon: lost.length,
    lostIn,
    servicesAtRisk: svc.filter((s) => s.replicas.some((r) => lostSet.has(r))).map((s) => s.id),
    servicesDown: svc.filter((s) => s.replicas.length > 0 && s.replicas.every((r) => lostSet.has(r))).map((s) => s.id),
  };
}
