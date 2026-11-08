/**
 * Simulation director contracts (server-side). The UI mirrors DirectorResult structurally in
 * src/views/DirectorPanel.tsx — keep the two in step.
 *
 * Boundary: the director (Nemotron or the local planner) chooses WHICH engine runs to execute and
 * WHICH scan to take next. Every number it reports comes from a tool result and is cited by run id.
 */
import type { ID, Incident, Metric } from '../../src/domain/types';
import type { Scan, ScanRequest } from '../../src/domain/rig/protocol';

export type Evidence = Incident['evidence'];

export interface DirectorInput {
  scenarioId: string;
  /** Scenario minute "now" */
  t: number;
  incidents: Incident[];
  scans: Scan[];
  /** Candidate dependency edges the operator has already opted in (used in every run) */
  confirmedEdgeIds: string[];
  /** Short operator question (≤ 500 chars). Log context goes in `context`, never appended here (audit C6). */
  question?: string;
  /** Structured log context (capped: 20 events × 200 chars, 10 notes × 200 chars); read with get_context */
  context?: DirectorContext;
  /** Present when evaluating one workflow incident: enables the ensemble, stress and EVSI tools */
  evaluation?: EvaluationRequest;
}

export interface DirectorContext { events: { id: string; at: string; summary: string }[]; notes: string[] }

export interface EvaluationRequest {
  kind: 'sensor' | 'heat' | 'water' | 'vibration';
  /** Evidence posterior P(alarm reflects a real condition), engine output */
  pReal: number;
  pRealBasis?: string;
  installed?: number;
  seed?: number;
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
  /** SIGNED normal − abnormal (positive = a normal reading leaves more time) */
  earliestShiftMin: number;
  earliestDirection: 'earlier' | 'later' | 'unchanged';
  firstRackLossIfAbnormalMin: number | null;
  firstRackLossIfNormalMin: number | null;
  /** SIGNED normal − abnormal (positive = a normal reading leaves more time) */
  firstRackShiftMin: number;
  firstRackDirection: 'earlier' | 'later' | 'unchanged';
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
  /** Set when the tool reached outside the engine: a public API, the physical rig, or the scan queue */
  service?: ExternalService;
}

export type ExternalService = 'api.weather.gov' | 'rack-monitor' | 'scan-queue' | 'approval-queue' | 'github';

/** An action the director may only PROPOSE. A person approves it on the dashboard before it runs. */
export interface PendingAction {
  id: string;
  kind: 'rig_command' | 'ticket';
  createdAt: string;
  proposedBy: string;
  reason: string;
  incidentId?: string;
  payload: { cmd: string } | { title: string; body: string; labels: string[] };
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
  decidedBy?: string;
  decidedAt?: string;
  result?: string;
  /** e.g. the created issue URL */
  url?: string;
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
  /** Scan requests the director queued itself (low-risk: a person still takes the scan) */
  queuedRequests?: ScanRequest[];
  /** Hardware / outward actions the director proposed; they wait for human approval */
  proposedActions?: PendingAction[];
  /** Re-plan chain: 1 = operator-triggered, 2+ = automatic re-plan after a requested scan landed */
  generation?: number;
  trigger?: string;
  /** Engine ensemble / red-team / EVSI results of an evaluation session (all numbers engine output) */
  evaluation?: EvaluationOutput;
}

export interface EvaluationOptionLite {
  id: string; label: string;
  racks: { p10: number; p50: number; p90: number; mean: number };
  pServiceDown: number; ci90: [number, number];
  firstImpactMin: { p10: number | null; p50: number | null; p90: number | null } | null;
  firstEnvelopeMin: { p10: number | null; p50: number | null; p90: number | null } | null;
  expectedUtility: number;
  /** 100 quantile futures for the UI playback (evaluation output only; never sent to the model) */
  futures?: { envelope: (number | null)[]; impact: (number | null)[] };
}

export interface EvaluationOutput {
  kind: EvaluationRequest['kind'];
  scenarioId: string;
  t: number;
  pReal: number;
  pRealBasis: string;
  /** id the text cites for these numbers, e.g. stress-1 */
  citeId: string;
  trials: number;
  ess: number;
  options: EvaluationOptionLite[];
  withOptionId: string | null;
  stress: null | {
    by: 'nemotron' | 'cross_entropy'; option: string; rounds: number; trials: number; ess: number; pFail: number; ci90: [number, number]; converged: boolean; maxWeight: number;
    regions: { label: string; rationale?: string; priorMass: number; priorOneIn: number; pFailGivenRegion: number; shareOfFailure: number; trialsInRegion: number }[];
    rejected: string[];
    citeId: string;
  };
  nextScan: null | { assetId: string; metric: string; point: string; evsi: number; forecastShift: number; informs: string; bestActionIfNoScan: string; bestActionByOutcome: { bin: string; pBin: number; action: string }[] };
  hypotheses: { id: string; label: string; p: number; basis: string; basisKind: string }[];
  elapsedMs: number;
}
