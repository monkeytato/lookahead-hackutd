/**
 * Remediation: what an operator can do about a problem, and what the engine predicts it saves.
 *
 * CONTRACT (owned by the engine/scenarios agent). UI code calls only:
 *   fixOptionsFor(...)  → actions available for an asset at time t
 *   predictFix(...)     → counterfactual: run the scenario with and without the fix
 */
import type { Facility, Fix, FixAction, ID, Reading, Scenario } from '../types';

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

export interface FixContext { facility: Facility; scenario: Scenario; seedReadings: Reading[]; fixes: Fix[]; t: number }

/** Fix options for one asset at time t (empty when nothing applies). */
export function fixOptionsFor(_ctx: FixContext, _assetId: ID): FixOption[] {
  return [];
}

/** Build a Fix from an option ordered at time t. */
export function makeFix(o: FixOption, t: number): Fix {
  return { id: `FIX-${o.action}-${o.assetId}-${Math.round(t * 10)}`, assetId: o.assetId, action: o.action, label: o.label, orderedAt: t, effectiveAt: t + o.delayMin };
}

/** Counterfactual run: the scenario with the existing fixes vs. with this extra one. */
export function predictFix(_ctx: FixContext, _option: FixOption): FixPrediction {
  return { lostWithout: 0, lostWith: 0, racksWithout: 0, racksWith: 0, savedAssetIds: [], firstRackLossWithout: null, firstRackLossWith: null };
}
