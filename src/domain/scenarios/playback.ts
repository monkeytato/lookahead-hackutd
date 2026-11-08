/**
 * Incident playback for the 3D twin: one deterministic run of the incident's own scenario
 * (scenarios/incident.ts), with and without the chosen response, so the map can show what happens
 * over the horizon — water spreading, equipment failing, the fix taking effect.
 *
 * It is the representative run, not the ensemble: the alarm's own effect (a tripped chiller, the
 * leak) is included only when the evidence posterior says it is more likely real than not, and
 * low-prior hypotheses (a second chiller trip, a fan trip) are left out. The ensemble numbers stay
 * the authority for probabilities; this shows the mechanism.
 */
import { simulateScenario, type ScenarioRun } from '../engine/simulate';
import { facility, seedReadings } from '../fixture';
import type { Fix, FixAction, Scenario } from '../types';
import { incidentModel, type IncidentKind } from './incident';

export interface IncidentPlayback {
  run: ScenarioRun;
  /** scenario minute the evaluation was made ("now") and the end of the horizon */
  from: number;
  to: number;
  /** the response, when one is applied: its label and the minute it takes effect */
  fix?: { label: string; assetId: string; at: number };
}

const cache = new Map<string, IncidentPlayback>();

/** Run the incident with no response (`optionLabel` null) or with the response whose label matches. */
export function incidentPlayback(kind: IncidentKind, pReal: number, optionLabel: string | null): IncidentPlayback {
  const real = pReal >= 0.5;
  const key = `${kind}|${real}|${optionLabel ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const model = incidentModel(kind, pReal);
  const realFaults = real ? model.hypotheses.filter((h) => h.id === 'real').flatMap((h) => h.effect.faults ?? []) : [];
  const scenario: Scenario = {
    ...model.scenario,
    faults: [...model.scenario.faults, ...realFaults],
    leak: real ? model.scenario.leak : undefined,
  };
  const option = optionLabel ? model.options.find((o) => o.label === optionLabel && o.action && o.assetId) : undefined;
  const fixes: Fix[] = option ? [{
    id: `play-${option.id}`, assetId: option.assetId!, action: option.action as FixAction, label: option.label,
    orderedAt: model.t, effectiveAt: model.t + (option.delayMin ?? 0),
  }] : [];
  const run = simulateScenario({ facility, scenario, seedReadings: seedReadings(), fixes, runs: 200, seed: 7 });
  const out: IncidentPlayback = { run, from: model.t, to: scenario.horizonMin, fix: option ? { label: option.label, assetId: option.assetId!, at: fixes[0].effectiveAt } : undefined };
  cache.set(key, out);
  return out;
}

/** Racks whose median loss time has passed by minute t (lost and not restored). */
export function racksDownAt(p: IncidentPlayback, t: number): number {
  let n = 0;
  for (const a of facility.assets) {
    if (a.type !== 'rack') continue;
    const c = p.run.clocks[a.id];
    const restored = p.run.restoredAt[a.id] !== undefined && p.run.restoredAt[a.id] <= t;
    if (c?.p50 != null && c.p50 <= t && !restored) n++;
  }
  return n;
}
