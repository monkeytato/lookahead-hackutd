/**
 * The live forecast every screen shows (audit C1: no foreknowledge). Pure TS, shared by the browser
 * store and the bridge's phone summary (server/phoneSummary.ts), so desktop, stage and phone agree.
 *
 * The scenario script is the WORLD (the store's script-mode `run`). A PREDICTION at minute t may only
 * use what is observed or inferable by t: `simulateScenario({ mode: 'forecast', forecastAt: t })`.
 * That run only changes when something new becomes observable (a fault seen, the leak inferable,
 * a fire started), so it is memoised on that observation state plus the fixes and extra edges,
 * not on t. Playback at 1 scenario minute per second then reruns the engine a handful of times
 * per scenario instead of 5 times a second.
 */
import { forecastScenario, scriptedHypotheses, simulateScenario, type FaultHypothesis, type ScenarioRun } from '../domain/engine';
import type { DependencyEdge, Facility, Fix, Reading, Scenario } from '../domain/types';

export interface LiveForecastInput {
  facility: Facility;
  scenario: Scenario;
  seedReadings: Reading[];
  t: number;
  fixes?: Fix[];
  extraEdges?: DependencyEdge[];
}

/** What a forecast at t rests on: observed faults, the leak once inferable, fires once started. */
export function observationKey(facility: Facility, scenario: Scenario, t: number): string {
  const fc = forecastScenario(facility, scenario, t).scenario;
  return JSON.stringify([scenario.id, scenario.horizonMin, facility.id, fc.faults, fc.leak ?? null, fc.hazards ?? null]);
}

const fixKey = (fixes: Fix[]) => fixes.map((f) => `${f.assetId}@${f.effectiveAt}`).sort().join(',');
const edgeKey = (edges: DependencyEdge[]) => edges.map((e) => `${e.id}#${e.revision}`).sort().join(',');

const cache = new Map<string, ScenarioRun>();
let computeCount = 0;

/** The forecast run at t (cached on the observation state, fixes and extra edges). */
export function liveForecast(input: LiveForecastInput): ScenarioRun {
  const fixes = input.fixes ?? [];
  const extraEdges = input.extraEdges ?? [];
  const key = `${observationKey(input.facility, input.scenario, input.t)}|${fixKey(fixes)}|${edgeKey(extraEdges)}`;
  let run = cache.get(key);
  if (run) {
    // keep recently used entries at the end (simple LRU)
    cache.delete(key);
    cache.set(key, run);
    return run;
  }
  computeCount++;
  run = simulateScenario({
    facility: input.facility, scenario: input.scenario, seedReadings: input.seedReadings,
    extraEdges, fixes, mode: 'forecast', forecastAt: input.t,
  });
  cache.set(key, run);
  if (cache.size > 16) cache.delete(cache.keys().next().value!);
  return run;
}

/** Engine runs liveForecast has made so far (for tests and the playback measurement). */
export const liveForecastComputeCount = () => computeCount;

/**
 * True when the forecast at t rests on something observed: a fault, an inferred leak or a started
 * fire. False means there is nothing to forecast from yet ("No observed fault · watching").
 */
export const hasObservedFault = (forecast: ScenarioRun, t: number) =>
  forecast.assumedFaults.some((a) => a.basis === 'observed') || forecast.hazardAt(t).length > 0;

/**
 * Scripted faults the forecast does NOT use at t, most likely first, with their published (or
 * assumed) priors. For the presenter's remote only: on the operator screens they would give the
 * script away.
 */
export function topHypotheses(facility: Facility, scenario: Scenario, t: number, max = 3): FaultHypothesis[] {
  return scriptedHypotheses(facility, scenario, t).sort((a, b) => b.prior - a.prior).slice(0, max);
}
