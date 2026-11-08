/**
 * Shared domain contracts. Every view (dashboard, 3D twin, technician, handoff)
 * reads these same records — never fork a second copy of an entity.
 *
 * Units: meters for geometry (x = east, z = south, y = up), minutes for scenario time.
 */

export type ID = string;

// ---------------------------------------------------------------- facility

export type ZoneKind = 'hall' | 'ups' | 'battery' | 'mechanical' | 'corridor' | 'electrical';

export interface Rect { x: number; z: number; w: number; d: number }

export interface Zone {
  id: ID;
  name: string;
  floor: number;
  kind: ZoneKind;
  rect: Rect;
  /** Floor elevation offset in meters (raised floor voids, thresholds). Used by the water layer. */
  elevation: number;
}

export type AssetType =
  | 'utility' | 'ats' | 'generator' | 'ups' | 'battery' | 'pdu'
  | 'chiller' | 'pump' | 'crah' | 'cdu' | 'rack' | 'pipe' | 'drain';

export interface Asset {
  id: ID;
  name: string;
  type: AssetType;
  zoneId: ID;
  /** Footprint center */
  pos: { x: number; z: number };
  size: { w: number; d: number; h: number };
  /** Rotation about Y in radians */
  rot?: number;
  /** Row / rack / service side — "correct room" is not enough */
  location: { row?: string; slot?: string; serviceSide?: 'front' | 'rear' | 'left' | 'right' };
  /** Waypoint where a technician stands to service this asset */
  accessWaypoint: ID;
  installedYear?: number;
  serviceLifeYears?: number;
  ratedKw?: number;
  loadKw?: number;
  /** Logical services hosted (racks only) */
  services?: ID[];
  /** Operator-defined criticality for services, 1 (low) – 5 (critical) */
  criticality?: number;
}

export interface Service { id: ID; name: string; criticality: 1 | 2 | 3 | 4 | 5; replicas: ID[] /* rack ids */ }

// ------------------------------------------------------------ dependencies

export type EdgeKind = 'powers' | 'cools' | 'shares_space';

/** Triangular delay distribution in minutes: how long downstream survives once upstream is lost. */
export interface DelayRange { min: number; mode: number; max: number }

export interface DependencyEdge {
  id: ID;
  from: ID;
  to: ID;
  kind: EdgeKind;
  delay: DelayRange;
  /** Where the delay number comes from — a rating, an incident report, or an explicit assumption */
  basis: string;
  basisKind: 'rating' | 'incident_report' | 'assumption' | 'model';
  /** Edges sharing a group are redundant: downstream is lost only when ALL group members are lost */
  redundancyGroup?: string;
  confirmed: boolean;
  revision: number;
}

// --------------------------------------------------------------- telemetry

export type Metric =
  | 'inlet_temp_c' | 'humidity_rh' | 'dew_point_c' | 'vibration_mm_s' | 'leak'
  | 'ups_autonomy_min' | 'load_kw' | 'flow_lpm' | 'pressure_kpa' | 'battery_temp_c' | 'supply_temp_c';

export type ReadingSource = 'installed' | 'reference_probe' | 'simulated' | 'replay' | 'manual';

export interface Reading {
  id: ID;
  assetId: ID;
  metric: Metric;
  value: number;
  unit: string;
  /** Scenario minute the reading was observed */
  t: number;
  source: ReadingSource;
  /** Expected sampling interval; older than this ⇒ stale */
  expectedIntervalMin: number;
  /** For reference probes: the probe's own id and measurement point */
  probeId?: ID;
  point?: string;
}

export type Freshness = 'fresh' | 'stale' | 'missing';

/** ISA-101 style priority. Color is reserved for these; normal is grayscale. */
export type Severity = 'normal' | 'advisory' | 'warning' | 'critical';

export interface Threshold {
  metric: Metric;
  warn: number;
  alarm: number;
  /** 'above' = high is bad */
  dir: 'above' | 'below';
  basis: string;
}

// ------------------------------------------------------------ verification

export type Verdict =
  | 'corroborated_abnormal'
  | 'measurement_disagreement'
  | 'inconclusive'
  | 'not_corroborated_in_session';

export interface VerificationSession {
  id: ID;
  assetId: ID;
  incidentId?: ID;
  operatorId: ID;
  probeId: ID;
  point: string;
  metric: Metric;
  installedReadingId: ID;
  referenceReadingIds: ID[];
  t: number;
  qualityFlags: string[];
  verdict: Verdict;
  rationale: string;
}

// --------------------------------------------------------------- incidents

export type IncidentStatus = 'open' | 'monitoring' | 'resolved';

export interface Incident {
  id: ID;
  title: string;
  rootAssetId: ID;
  /** Alerts folded into this incident by the dependency graph */
  alertAssetIds: ID[];
  severity: Severity;
  status: IncidentStatus;
  evidence: Verdict | 'unverified';
  ownerId?: ID;
  shiftLeadId: ID;
  openedAt: number;
  summary: string;
  /** Recent changes / maintenance near this asset — change awareness */
  recentChanges: string[];
  runbookId?: ID;
}

export interface PriorityFactor { key: string; label: string; score: number; weight: number; note: string }

export interface PriorityResult {
  incidentId: ID;
  total: number;
  factors: PriorityFactor[];
  policyVersion: string;
  /** If ranking depends on unknown evidence, the specific check that would resolve it */
  resolvingCheck?: string;
}

// ------------------------------------------------------------ people/tasks

export type Role = 'supervisor' | 'engineer' | 'technician' | 'shift_lead';
export type Skill = 'electrical' | 'mechanical' | 'cooling' | 'battery' | 'network' | 'vibration' | 'leak_response';

export interface EmployeeLocation {
  zoneId: ID;
  waypointId: ID;
  /** Scenario minute of the check-in */
  t: number;
  source: 'manual' | 'qr' | 'seed';
}

export interface Employee {
  id: ID;
  name: string;
  initials: string;
  role: Role;
  team: string;
  skills: Skill[];
  zones: ID[];
  shift: 'day' | 'night';
  availability: 'available' | 'busy' | 'off_shift';
  location?: EmployeeLocation;
}

export type TaskType = 'verify' | 'inspect' | 'repair' | 'monitor';

export type TaskStatus =
  | 'unassigned' | 'assigned' | 'accepted' | 'en_route' | 'at_asset'
  | 'in_progress' | 'submitted_for_review' | 'completed'
  | 'blocked' | 'cancelled' | 'reopened';

export interface ChecklistStep {
  id: ID;
  text: string;
  required: boolean;
  result?: 'pass' | 'fail' | 'not_assessed';
  evidenceIds: ID[];
  note?: string;
}

export interface Task {
  id: ID;
  type: TaskType;
  title: string;
  incidentId?: ID;
  assetId: ID;
  requiredSkills: Skill[];
  status: TaskStatus;
  ownerId?: ID;
  estimateMin: number;
  checklist: ChecklistStep[];
  reviewRequired: boolean;
  assetConfirmed: boolean;
  prerequisites: ID[];
  blocker?: string;
  /** Status the task was in before `block` — restored on `unblock` (engine-managed) */
  blockedFrom?: TaskStatus;
  priorityReason: string;
  version: number;
}

// ----------------------------------------------------------------- routing

export interface Waypoint { id: ID; x: number; z: number; zoneId: ID; label?: string }
export interface WalkEdge { id: ID; a: ID; b: ID; closed?: boolean; restrictedTo?: Skill; note?: string }

export interface Route {
  ok: boolean;
  path: ID[];
  distanceM: number;
  etaMin: number;
  assumptions: string[];
  blockedReason?: string;
}

// ------------------------------------------------------------------ events

export type EventKind =
  | 'telemetry' | 'alert' | 'incident' | 'verification' | 'analysis'
  | 'dependency' | 'scenario' | 'task' | 'checkin' | 'handoff' | 'note';

export interface OpEvent {
  id: ID;
  /** Scenario minute the event happened */
  t: number;
  /** Wall-clock ingestion time (ISO) */
  ingestedAt: string;
  kind: EventKind;
  actor: string;
  summary: string;
  links: { assetId?: ID; incidentId?: ID; taskId?: ID; employeeId?: ID };
  /** Superseding corrections reference the original — never erase history */
  supersedes?: ID;
  source: 'live' | 'simulated' | 'replay' | 'operator' | 'local_rules' | 'nemotron';
}

// --------------------------------------------------------- engine outputs

/** Per-node time-to-impact from the cascade engine (Monte Carlo over delay ranges). */
export interface ImpactClock {
  assetId: ID;
  /** Minutes from fault start; null when not impacted within horizon in that percentile */
  p10: number | null;
  p50: number | null;
  p90: number | null;
  /** Share of Monte Carlo runs where this node is lost within the horizon */
  probWithinHorizon: number;
  /** Most frequent propagation path (asset ids, fault → this node) */
  path: ID[];
  /** The delay assumption most likely to be wrong (largest spread on the path) */
  weakestAssumption?: string;
  /** Only when fixes were applied: median minute this node comes back in the runs where it was lost (null = stays down) */
  recoveredP50?: number | null;
}

/** Visual state the 3D twin + 2D map paint per asset. */
export interface AssetVisualState {
  severity: Severity;
  freshness: Freshness;
  /** 0..1 normalized heat for color ramps (inlet temp against ASHRAE band) */
  heat: number;
  /** Minutes until impact at the current scrub time, if on a clock */
  clockMin?: number;
  wet?: boolean;
  /** Paint state but no floating label (e.g. a rack that is only downstream of a clock) — avoids label soup */
  quiet?: boolean;
  /** Modeled as lost at this scrub time (p50 loss time reached and not restored) */
  lost?: boolean;
  /** A fix took effect on this asset at or before this time: show it recovering / protected */
  restored?: boolean;
  /** Inside an active fire/smoke hazard front at this time */
  burning?: boolean;
}

/** Operator remediation. The engine treats `assetId` as repaired from `effectiveAt` on:
 *  it stops failing, stops propagating loss, and a leak at it stops adding water. */
export type FixAction =
  | 'isolate_valve' | 'restart_chiller' | 'swap_crah' | 'reset_fan' | 'manual_gen_start'
  | 'transfer_ups' | 'suppress_fire' | 'reset_breaker' | 'shed_load' | 'deploy_portable_cooling';

export interface Fix {
  id: ID;
  assetId: ID;
  action: FixAction;
  label: string;
  /** Scenario minute the fix was ordered */
  orderedAt: number;
  /** Scenario minute it takes effect (orderedAt + travel/work time) */
  effectiveAt: number;
}

/** A spreading physical hazard other than water (water keeps its own height-field layer). */
export interface Hazard {
  kind: 'fire' | 'smoke';
  /** Where it starts: an asset id, and its floor position */
  originAssetId: ID;
  x: number;
  z: number;
  startT: number;
  /** Front speed, metres per minute (assumption, shown in the basis) */
  spreadMPerMin: number;
  maxRadiusM: number;
  /** Zones it can reach (fire stays in rated rooms; smoke can travel further) */
  zoneIds: ID[];
}

/** One hazard's footprint at a scrub time, for the 3D twin. */
export interface HazardFrame { kind: Hazard['kind']; x: number; z: number; radiusM: number; originAssetId: ID; contained: boolean }

export interface WaterFrame {
  /** Minutes since leak start */
  t: number;
  /** Row-major depth grid in millimeters, size cols*rows */
  depthMm: Float32Array;
}

export interface WaterGrid {
  cols: number;
  rows: number;
  cellM: number;
  origin: { x: number; z: number };
  frames: WaterFrame[];
}

// ---------------------------------------------------------------- scenario

export interface ScenarioStep {
  t: number;
  kind: 'fault' | 'reading' | 'alert' | 'note';
  assetId: ID;
  summary: string;
  metric?: Metric;
  value?: number;
  source?: ReadingSource;
}

export interface Scenario {
  id: ID;
  name: string;
  description: string;
  /** Provenance — e.g. adapted from the Google Paris April 2023 incident report */
  basis: string;
  horizonMin: number;
  faults: { assetId: ID; t: number }[];
  /** stopT: the leak stops adding water from this minute (set by the engine when the source is isolated) */
  leak?: { x: number; z: number; ratePerMin: number; startT: number; stopT?: number };
  steps: ScenarioStep[];
  /** 'real' = adapted from a public incident report; 'random' = generated; 'what-if' = engineering case */
  kind?: 'real' | 'random' | 'what-if';
  hazards?: Hazard[];
  /** Incidents the engine raises during this scenario (opened when the clock passes openedAt) */
  incidents?: Incident[];
  /** One-line headline for the presenter screen, e.g. "Chilled-water riser leak reaches the battery room" */
  headline?: string;
}

export interface Facility {
  id: ID;
  name: string;
  site: string;
  zones: Zone[];
  assets: Asset[];
  services: Service[];
  edges: DependencyEdge[];
  waypoints: Waypoint[];
  walkEdges: WalkEdge[];
  thresholds: Threshold[];
}
