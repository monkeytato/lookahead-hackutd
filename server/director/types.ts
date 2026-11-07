/**
 * Simulation director contracts (server-side). The UI mirrors DirectorResult structurally in
 * src/views/DirectorPanel.tsx — keep the two in step.
 *
 * Boundary: the director (Nemotron or the local planner) chooses WHICH engine runs to execute and
 * WHICH scan to take next. Every number it reports comes from a tool result and is cited by run id.
 */
import type { ID, Incident, Metric } from '../../src/domain/types';
import type { Scan } from '../../src/domain/rig/protocol';

export type Evidence = Incident['evidence'];

export interface DirectorInput {
  scenarioId: string;
  /** Scenario minute "now" */
  t: number;
  incidents: Incident[];
  scans: Scan[];
  /** Candidate dependency edges the operator has already opted in (used in every run) */
  confirmedEdgeIds: string[];
  question?: string;
}

/** Normalized parameters of one engine run (what-if). */
export interface RunParams {
  label: string;
  /** Absolute scenario minutes */
  extraFaults: { assetId: ID; t: number }[];
  /** Unconfirmed facility edges opted in for this run only */
  confirmEdges: ID[];
  /** Assets whose modeled faults (scenario faults and water-layer arrivals) are removed */
  suppressFaults: ID[];
  /** Evidence overrides used when ranking incidents in this run */
  assumeEvidence: { incidentId: ID; verdict: Evidence }[];
}

/** One clock row. `p10/p50/p90` are MINUTES FROM NOW (negative = already past); `atP50` is the absolute scenario minute. */
export interface ClockRow {
  assetId: ID;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  atP50: number | null;
  prob: number;
  path: string;
}

export interface CompactRun {
  id: string;
  label: string;
  params: RunParams;
  now: number;
  horizonMin: number;
  /** Up to 8 clocks with p50 at or after now, earliest first */
  topClocks: ClockRow[];
  /** Nodes lost (p50) by the horizon, in total / before now / at or after now */
  lostByHorizon: number;
  alreadyLost: number;
  lostAfterNow: number;
  /** Earliest upcoming p50 loss (any asset) */
  earliest: { assetId: ID; inMin: number; atMin: number } | null;
  /** Earliest upcoming rack (service) loss and how many racks are lost by the horizon */
  firstRackLoss: { assetId: ID; inMin: number; atMin: number } | null;
  racksLostByHorizon: number;
  ranking: { rank: number; incidentId: ID; total: number; evidence: Evidence }[];
  /** Water-layer arrivals still modeled in this run */
  wetArrivals: { assetId: ID; atMin: number; inMin: number }[];
}

export interface ScanValueResult {
  assetId: ID;
  metric: Metric;
  incidentId: ID;
  rigMeasurable: boolean;
  point: string;
  alreadyScanned: { scanId: string; summary: string } | null;
  /** What the water layer / scenario model expects this reading to show right now */
  modelExpectsNow: 'abnormal' | 'normal' | 'n/a';
  runIfAbnormal: string;
  runIfNormal: string;
  hypothesisAbnormal: string;
  hypothesisNormal: string;
  topIfAbnormal: ID | null;
  topIfNormal: ID | null;
  topChanged: boolean;
  orderChanged: boolean;
  earliestIfAbnormalMin: number | null;
  earliestIfNormalMin: number | null;
  earliestShiftMin: number;
  firstRackLossIfAbnormalMin: number | null;
  firstRackLossIfNormalMin: number | null;
  firstRackShiftMin: number;
  lostAfterNowDelta: number;
  decisionValue: number;
  note: string;
}

export interface DirectorStep {
  tool: string;
  args: unknown;
  summary: string;
  /** Primary run id produced or used (scan_value: "run-a/run-b") */
  runId?: string;
  runIds?: string[];
  ok: boolean;
}

export interface Hypothesis { label: string; support: string; runIds: string[] }

export interface Recommendation {
  nextScan: { assetId: ID; point: string; reason: string; holdS: 10 } | null;
  nextAction: string;
  hypotheses: Hypothesis[];
  summary: string;
}

export interface DirectorUsage { promptTokens: number; completionTokens: number; totalTokens: number; requests: number }

export interface DirectorResult {
  provider: 'nemotron' | 'local_planner';
  model: string | null;
  steps: DirectorStep[];
  recommendation: Recommendation;
  runs: Record<string, CompactRun>;
  usage?: DirectorUsage;
  /** Post-validation findings, e.g. "unsupported_number: …", "unknown_run_id: …" */
  warnings: string[];
  fallbackReason?: string;
  /** When Nemotron was tried and the planner took over: what Nemotron did before it failed */
  nemotronSteps?: DirectorStep[];
  elapsedMs: number;
}
