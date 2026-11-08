/**
 * Single shared operational record for every view (desktop, technician, handoff, 3D).
 * Prototype persistence: localStorage + BroadcastChannel so a second tab sees the same records.
 * This is NOT production auth or storage — the role switch is a demo persona, not a permission.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import {
  employees as seedEmployees, facility, seedIncidents, seedReadings, seedTasks,
  SCENARIO_WALL_START,
} from '../domain/fixture';
import type { Fix, Scenario } from '../domain/types';
import { useStage } from '../stage/StageProvider';
import { incidentsFor } from '../domain/scenarios';
import type {
  DependencyEdge, Employee, Incident, OpEvent, Reading, Task, VerificationSession, ID,
} from '../domain/types';
import { simulateScenario, type ScenarioRun } from '../domain/engine';

export type Selection =
  | { kind: 'asset'; id: ID }
  | { kind: 'incident'; id: ID }
  | { kind: 'task'; id: ID }
  | { kind: 'employee'; id: ID }
  | null;

export interface Layers { heat: boolean; water: boolean; deps: boolean; people: boolean }
export type Persona = 'supervisor' | 'technician' | 'shift_lead';

export interface OpsState {
  schema: 5;
  /** Stage run these operator records belong to (a scenario switch or reset starts a new one) */
  stageEpoch: number;
  /** Stage fixes already written to the log as ordered / in effect */
  fixesLogged: ID[];
  fixesInEffect: ID[];
  /** Scans from the bridge already turned into evidence */
  ingestedScanIds: ID[];
  /** Only bridge scans finished after this ISO time belong to this demo session */
  sessionStartedAt: string;
  /** Mirrored from the stage (src/stage): the stage is the source of truth for these three */
  scenarioId: ID;
  t: number;
  playing: boolean;
  incidents: Incident[];
  tasks: Task[];
  employees: Employee[];
  /** Operator-side append-only events. Scenario events are derived and merged at read time. */
  events: OpEvent[];
  verifications: VerificationSession[];
  /** Reference/manual readings captured by operators (fixture-backed in this prototype) */
  capturedReadings: Reading[];
  /** Candidate dependencies an engineer confirmed (feed the engine) */
  confirmedEdgeIds: ID[];
  rejectedEdgeIds: ID[];
  closedWalkEdgeIds: ID[];
  handoffAcks: { by: ID; t: number; note?: string }[];
  graphRevision: number;
  persona: Persona;
}

const STORAGE_KEY = 'lookahead.ops.v5';

export function initialState(scenarioId = 'scn-riser-leak', stageEpoch = 0): OpsState {
  return {
    schema: 5,
    stageEpoch,
    fixesLogged: [],
    fixesInEffect: [],
    ingestedScanIds: [],
    sessionStartedAt: new Date().toISOString(),
    scenarioId,
    t: 0,
    playing: false,
    incidents: scenarioId === 'scn-riser-leak' ? seedIncidents() : [],
    tasks: scenarioId === 'scn-riser-leak' ? seedTasks() : [],
    employees: structuredClone(seedEmployees),
    events: [],
    verifications: [],
    capturedReadings: [],
    confirmedEdgeIds: [],
    rejectedEdgeIds: [],
    closedWalkEdgeIds: [],
    handoffAcks: [],
    graphRevision: 1,
    persona: 'supervisor',
  };
}

type Action =
  | { type: 'reset'; scenarioId?: ID }
  | { type: 'reset_records'; scenarioId: ID; epoch: number }
  | { type: 'fix_logged'; fixId: ID; event: OpEvent; epoch: number }
  | { type: 'fix_in_effect'; fix: Fix; event: OpEvent; epoch: number }
  | { type: 'engine_incident'; incident: Incident; event: OpEvent; epoch: number }
  | { type: 'hydrate'; state: OpsState }
  | { type: 'set_t'; t: number }
  | { type: 'play'; playing: boolean }
  | { type: 'persona'; persona: Persona }
  | { type: 'append_event'; event: OpEvent }
  | { type: 'upsert_incident'; incident: Incident; event?: OpEvent }
  | { type: 'upsert_task'; task: Task; event?: OpEvent }
  | { type: 'add_verification'; session: VerificationSession; readings: Reading[]; event: OpEvent }
  | { type: 'checkin'; employeeId: ID; location: NonNullable<Employee['location']>; event: OpEvent }
  | { type: 'set_availability'; employeeId: ID; availability: Employee['availability'] }
  | { type: 'review_edge'; edgeId: ID; decision: 'confirm' | 'reject'; event: OpEvent }
  | { type: 'toggle_walk_edge'; edgeId: ID; event: OpEvent }
  | { type: 'ack_handoff'; by: ID; note?: string; event: OpEvent }
  | { type: 'ingest_scan'; scanId: ID; reading: Reading | null; session: VerificationSession | null; incident: Incident | null; event: OpEvent };

function reducer(s: OpsState, a: Action): OpsState {
  // Stage-driven actions belong to one run: drop them if the records have moved to another run.
  if ((a.type === 'fix_logged' || a.type === 'fix_in_effect' || a.type === 'engine_incident') && a.epoch !== s.stageEpoch) return s;
  switch (a.type) {
    case 'engine_incident':
      return s.incidents.some((i) => i.id === a.incident.id) ? s : { ...s, incidents: [...s.incidents, a.incident], events: [...s.events, a.event] };
    case 'reset': return { ...initialState(a.scenarioId ?? s.scenarioId, s.stageEpoch), persona: s.persona };
    case 'reset_records': return { ...initialState(a.scenarioId, a.epoch), persona: s.persona };
    case 'fix_logged':
      return s.fixesLogged.includes(a.fixId) ? s : { ...s, fixesLogged: [...s.fixesLogged, a.fixId], events: [...s.events, a.event] };
    case 'fix_in_effect': {
      if (s.fixesInEffect.includes(a.fix.id)) return s;
      const incidents = s.incidents.map((i) => (i.rootAssetId === a.fix.assetId && i.status === 'open' ? { ...i, status: 'monitoring' as const } : i));
      return { ...s, incidents, fixesInEffect: [...s.fixesInEffect, a.fix.id], events: [...s.events, a.event] };
    }
    case 'hydrate': return a.state;
    case 'set_t': return { ...s, t: a.t };
    case 'play': return { ...s, playing: a.playing };
    case 'persona': return { ...s, persona: a.persona };
    case 'append_event': return { ...s, events: [...s.events, a.event] };
    case 'upsert_incident': {
      const exists = s.incidents.some((i) => i.id === a.incident.id);
      return {
        ...s,
        incidents: exists ? s.incidents.map((i) => (i.id === a.incident.id ? a.incident : i)) : [...s.incidents, a.incident],
        events: a.event ? [...s.events, a.event] : s.events,
      };
    }
    case 'upsert_task': {
      const exists = s.tasks.some((x) => x.id === a.task.id);
      const employees = s.employees.map((e) => {
        // one active physical task per technician: busy while owning an active task
        const owns = (exists ? s.tasks.map((x) => (x.id === a.task.id ? a.task : x)) : [...s.tasks, a.task])
          .some((x) => x.ownerId === e.id && ['accepted', 'en_route', 'at_asset', 'in_progress'].includes(x.status) && x.type !== 'monitor');
        if (e.availability === 'off_shift') return e;
        return { ...e, availability: owns ? 'busy' as const : e.id === 'emp-jordan' ? e.availability : 'available' as const };
      });
      return {
        ...s,
        employees,
        tasks: exists ? s.tasks.map((x) => (x.id === a.task.id ? a.task : x)) : [...s.tasks, a.task],
        events: a.event ? [...s.events, a.event] : s.events,
      };
    }
    case 'add_verification':
      return { ...s, verifications: [...s.verifications, a.session], capturedReadings: [...s.capturedReadings, ...a.readings], events: [...s.events, a.event] };
    case 'checkin':
      return { ...s, employees: s.employees.map((e) => (e.id === a.employeeId ? { ...e, location: a.location } : e)), events: [...s.events, a.event] };
    case 'set_availability':
      return { ...s, employees: s.employees.map((e) => (e.id === a.employeeId ? { ...e, availability: a.availability } : e)) };
    case 'review_edge':
      return {
        ...s,
        confirmedEdgeIds: a.decision === 'confirm' ? [...new Set([...s.confirmedEdgeIds, a.edgeId])] : s.confirmedEdgeIds.filter((x) => x !== a.edgeId),
        rejectedEdgeIds: a.decision === 'reject' ? [...new Set([...s.rejectedEdgeIds, a.edgeId])] : s.rejectedEdgeIds.filter((x) => x !== a.edgeId),
        graphRevision: s.graphRevision + 1,
        events: [...s.events, a.event],
      };
    case 'toggle_walk_edge':
      return {
        ...s,
        closedWalkEdgeIds: s.closedWalkEdgeIds.includes(a.edgeId) ? s.closedWalkEdgeIds.filter((x) => x !== a.edgeId) : [...s.closedWalkEdgeIds, a.edgeId],
        events: [...s.events, a.event],
      };
    case 'ingest_scan': {
      if (s.ingestedScanIds.includes(a.scanId)) return s;
      const incidents = a.incident && a.session
        ? s.incidents.map((i) => (i.id === a.incident!.id ? { ...i, evidence: a.session!.verdict, severity: a.session!.verdict === 'measurement_disagreement' && i.severity === 'critical' ? 'advisory' as const : i.severity } : i))
        : s.incidents;
      return {
        ...s, incidents, ingestedScanIds: [...s.ingestedScanIds, a.scanId],
        capturedReadings: a.reading ? [...s.capturedReadings, a.reading] : s.capturedReadings,
        verifications: a.session ? [...s.verifications, a.session] : s.verifications,
        events: [...s.events, a.event],
      };
    }
    case 'ack_handoff':
      return { ...s, handoffAcks: [...s.handoffAcks, { by: a.by, t: s.t, note: a.note }], events: [...s.events, a.event] };
  }
}

// ----------------------------------------------------------------- helpers

let evtCounter = 0;
export function makeEvent(t: number, partial: Omit<OpEvent, 'id' | 't' | 'ingestedAt'>): OpEvent {
  evtCounter += 1;
  return { id: `EV-${Date.now().toString(36)}-${evtCounter}`, t, ingestedAt: new Date().toISOString(), ...partial };
}

export function wallClock(t: number): string {
  const total = SCENARIO_WALL_START.h * 60 + SCENARIO_WALL_START.m + Math.round(t);
  const h = Math.floor((((total / 60) % 24) + 24) % 24);
  const m = ((total % 60) + 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function relMin(now: number, t: number): string {
  const d = Math.round(now - t);
  if (d <= 0) return 'just now';
  if (d < 60) return `${d} min ago`;
  return `${Math.floor(d / 60)} h ${d % 60} min ago`;
}

// ----------------------------------------------------------------- context

interface Ctx {
  /** Operator records, with scenarioId / t / playing mirrored from the stage */
  state: OpsState;
  /** Store actions. set_t / play / reset are forwarded to the stage so every screen follows. */
  dispatch: (a: Action) => void;
  run: ScenarioRun;
  scenario: Scenario;
  /** Incidents visible at the current scrub time */
  visibleIncidents: Incident[];
  /** Candidate + derived edges the engine currently uses on top of confirmed ones */
  activeExtraEdges: DependencyEdge[];
}

const OpsContext = createContext<Ctx | null>(null);

function load(): OpsState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OpsState;
    return parsed.schema === 5 ? { ...parsed, playing: false } : null;
  } catch { return null; }
}

export function OpsProvider({ children }: { children: ReactNode }) {
  const stage = useStage();
  const [inner, innerDispatch] = useReducer(reducer, undefined, () => load() ?? initialState(stage.state.scenarioId, stage.state.epoch));
  const channel = useRef<BroadcastChannel | null>(null);
  const fromRemote = useRef(false);
  const epochRef = useRef(stage.state.epoch);
  useEffect(() => { epochRef.current = stage.state.epoch; }, [stage.state.epoch]);

  // persist + broadcast (second tab sees the same record — acceptance A17)
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...inner, playing: false })); } catch { /* storage unavailable: in-memory only */ }
    if (fromRemote.current) { fromRemote.current = false; return; }
    try { channel.current?.postMessage(inner); } catch { /* channel closed during remount */ }
  }, [inner]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    let ch: BroadcastChannel;
    try { ch = new BroadcastChannel(STORAGE_KEY); } catch { return; } // sandboxed frames may refuse it
    ch.onmessage = (m) => {
      const other = m.data as OpsState;
      // another tab's records from an older (or newer) run would resurrect its incidents: ignore
      if (other?.schema !== 5 || other.stageEpoch !== epochRef.current) return;
      fromRemote.current = true;
      innerDispatch({ type: 'hydrate', state: { ...other, playing: false } });
    };
    channel.current = ch;
    return () => { if (channel.current === ch) channel.current = null; ch.close(); };
  }, []);

  // The stage decides the run: a scenario switch or a reset (new epoch) starts fresh operator records.
  const { scenarioId: stageScenarioId, epoch: stageEpoch, fixes, playing } = stage.state;
  const t = stage.t;
  const current = inner.scenarioId === stageScenarioId && inner.stageEpoch === stageEpoch;
  useEffect(() => {
    if (!current) innerDispatch({ type: 'reset_records', scenarioId: stageScenarioId, epoch: stageEpoch });
  }, [current, stageScenarioId, stageEpoch]);

  // What every view reads: records of this run (none while switching), time from the stage.
  const records = current ? inner : initialState(stageScenarioId, stageEpoch);
  const state = useMemo<OpsState>(() => ({ ...records, scenarioId: stageScenarioId, t, playing }), [records, stageScenarioId, t, playing]);

  // Old callers (Timeline, AppShell, phone dashboard) keep working: time and scenario go to the stage.
  const send = stage.send;
  const dispatch = useCallback((a: Action) => {
    switch (a.type) {
      case 'set_t': send({ type: 'seek', t: a.t }); return;
      case 'play': send({ type: a.playing ? 'play' : 'pause' }); return;
      case 'reset':
        if (a.scenarioId && a.scenarioId !== stageScenarioId) send({ type: 'scenario', scenarioId: a.scenarioId });
        else send({ type: 'reset' });
        return;
      default: innerDispatch(a);
    }
  }, [send, stageScenarioId]);

  const scenario = stage.scenario;
  const activeExtraEdges = useMemo(
    () => facility.edges.filter((e) => !e.confirmed && state.confirmedEdgeIds.includes(e.id)).map((e) => ({ ...e, confirmed: true, revision: state.graphRevision })),
    [state.confirmedEdgeIds, state.graphRevision],
  );
  // fixes arrive as new arrays over the network: key the (expensive) run on their content
  const fixesKey = JSON.stringify(fixes);
  const run = useMemo(
    () => simulateScenario({ facility, scenario, seedReadings: seedReadings(), extraEdges: activeExtraEdges, fixes: JSON.parse(fixesKey) as Fix[] }),
    [scenario, activeExtraEdges, fixesKey],
  );

  // auto-raise incidents from the scenario as the clock passes (grouped by cause)
  useEffect(() => {
    if (!current) return;
    let pauseFor: string | null = null;
    for (const inc of derivedIncidents(scenario, run)) {
      if (inc.openedAt <= t && !inner.incidents.some((i) => i.id === inc.id)) {
        innerDispatch({
          type: 'engine_incident', incident: inc, epoch: stageEpoch,
          event: makeEvent(inc.openedAt, { kind: 'incident', actor: 'engine', summary: `Incident opened: ${inc.title}`, links: { incidentId: inc.id, assetId: inc.rootAssetId }, source: 'simulated' }),
        });
        // presenter beat: stop on a fresh incident (not on ones skipped over by a seek)
        if (t - inc.openedAt <= 2) pauseFor ??= inc.title;
      }
    }
    if (pauseFor && stage.state.playing && stage.state.autoPause) stage.send({ type: 'pause', reason: `New incident: ${pauseFor}` });
  }, [current, t, scenario, run, inner.incidents, stageEpoch, stage]);

  // fixes: log when ordered, and when they take effect (the incident at that asset → monitoring)
  useEffect(() => {
    if (!current) return;
    for (const f of fixes) {
      if (!inner.fixesLogged.includes(f.id)) {
        innerDispatch({ type: 'fix_logged', fixId: f.id, epoch: stageEpoch, event: makeEvent(f.orderedAt, { kind: 'task', actor: 'stage', summary: `Fix ordered: ${f.label} (takes effect T+${Math.round(f.effectiveAt)})`, links: { assetId: f.assetId }, source: 'operator' }) });
      }
      if (f.effectiveAt <= t && !inner.fixesInEffect.includes(f.id)) {
        innerDispatch({ type: 'fix_in_effect', fix: f, epoch: stageEpoch, event: makeEvent(f.effectiveAt, { kind: 'task', actor: 'engine', summary: `Fix in effect: ${f.label}`, links: { assetId: f.assetId }, source: 'simulated' }) });
      }
    }
  }, [current, fixes, t, inner.fixesLogged, inner.fixesInEffect, stageEpoch]);

  const visibleIncidents = useMemo(() => state.incidents.filter((i) => i.openedAt <= t), [state.incidents, t]);

  const value = useMemo<Ctx>(() => ({ state, dispatch, run, scenario, visibleIncidents, activeExtraEdges }), [state, dispatch, run, scenario, visibleIncidents, activeExtraEdges]);
  return <OpsContext.Provider value={value}>{children}</OpsContext.Provider>;
}

export function useOps(): Ctx {
  const c = useContext(OpsContext);
  if (!c) throw new Error('useOps outside OpsProvider');
  return c;
}

/** Incidents the engine raises on its own during a scenario. Folded by cause, one clock each. */
function derivedIncidents(scenario: Scenario, run: ScenarioRun): Incident[] {
  if (scenario.incidents) return incidentsFor(scenario, run);
  const scenarioId = scenario.id;
  if (scenarioId === 'scn-riser-leak') {
    const firstWet = Object.entries(run.waterArrival).sort((a, b) => a[1] - b[1]);
    const wetIds = firstWet.map(([id]) => id);
    const upsWet = firstWet.find(([id]) => id.startsWith('UPS') || id.startsWith('BATT'));
    const out: Incident[] = [{
      id: 'INC-1044', title: 'Possible leak — loop make-up flow +6 %', rootAssetId: 'PIPE-L2', alertAssetIds: ['PIPE-L2', ...wetIds],
      severity: 'warning', status: 'open', evidence: 'unverified', shiftLeadId: 'emp-priya', openedAt: 11,
      summary: 'Chilled-water make-up flow no longer matches supply. No leak sensor exists on Level 2; the riser above the east corridor is the only pipe run consistent with the mismatch.',
      recentChanges: ['Vendor on site — BATT-B module replacement scheduled 03:00'], runbookId: 'RB-LEAK',
    }];
    if (upsWet) {
      out.push({
        id: 'INC-1045', title: `Water reached ${upsWet[0]} — battery/UPS exposure`, rootAssetId: upsWet[0], alertAssetIds: wetIds.filter((x) => x.startsWith('UPS') || x.startsWith('BATT')),
        severity: 'critical', status: 'open', evidence: 'unverified', shiftLeadId: 'emp-priya', openedAt: Math.max(12, Math.ceil(upsWet[1])),
        summary: 'Water layer (approximation) shows the wet front at UPS/battery equipment. Li-ion string B is past its 10-year service life.',
        recentChanges: ['BATT-B installed 2015 — past 10-year service life', 'Vendor module work scheduled 03:00 — hold until dry'], runbookId: 'RB-BATT',
      });
    }
    return out;
  }
  if (scenarioId === 'scn-gen-nostart') {
    return [{
      id: 'INC-2001', title: 'Utility lost — generator start not acknowledged', rootAssetId: 'ATS-1', alertAssetIds: ['UTIL', 'GEN-1', 'ATS-1', 'BATT-A', 'BATT-B'],
      severity: 'critical', status: 'open', evidence: 'corroborated_abnormal', shiftLeadId: 'emp-priya', openedAt: 2,
      summary: 'Load is on UPS batteries. The only clock that matters is UPS autonomy; manual generator start is the fastest recovery.',
      recentChanges: ['ATS-1 last test transfer: 41 days ago'],
    }];
  }
  if (scenarioId === 'scn-chiller-trip') {
    return [
      { id: 'INC-3001', title: 'Chiller 1 tripped — running on CH-2 only', rootAssetId: 'CH-1', alertAssetIds: ['CH-1'], severity: 'warning', status: 'open', evidence: 'corroborated_abnormal', shiftLeadId: 'emp-priya', openedAt: 1, summary: 'Redundancy lost on chilled water. No rack impact unless CH-2 also trips.', recentChanges: [] },
      { id: 'INC-3002', title: 'What-if: Chiller 2 tripped — no chilled water', rootAssetId: 'CH-2', alertAssetIds: ['CH-1', 'CH-2', 'P-1', 'P-2'], severity: 'critical', status: 'open', evidence: 'unverified', shiftLeadId: 'emp-priya', openedAt: 12, summary: 'Scenario preview: thermal ride-through clocks start across the hall.', recentChanges: [] },
    ];
  }
  return [];
}
