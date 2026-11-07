/**
 * Director tools: the ONLY way the director (Nemotron or the local planner) touches the engine.
 *
 * Each tool takes untrusted JSON arguments, validates them with small hand-written guards
 * (every asset / incident / edge id is checked against the facility and the live situation),
 * calls the deterministic engine directly, and returns compact numbers. Runs are stored per
 * session under ids like `run-2` so the final recommendation can cite them, and every number a
 * run produced is recorded so the post-validator can reject numbers that no tool produced.
 */
import { rankIncidents, runCascade, simulateScenario } from '../../src/domain/engine';
import { employees, facility, scenarios, seedReadings, seedTasks } from '../../src/domain/fixture';
import type { Asset, DependencyEdge, ID, ImpactClock, Incident, Metric, Scenario } from '../../src/domain/types';
import type { Scan } from '../../src/domain/rig/protocol';
import { TARGET_HOLD_S } from '../../src/domain/rig/protocol';
import type { ClockRow, CompactRun, DirectorInput, Evidence, Recommendation, RunParams, ScanValueResult } from './types';

export const MAX_RUNS_PER_SESSION = 10;

const EVIDENCE: Evidence[] = ['unverified', 'corroborated_abnormal', 'measurement_disagreement', 'inconclusive', 'not_corroborated_in_session'];
const METRICS: Metric[] = ['inlet_temp_c', 'humidity_rh', 'dew_point_c', 'vibration_mm_s', 'leak', 'ups_autonomy_min', 'load_kw', 'flow_lpm', 'pressure_kpa', 'battery_temp_c', 'supply_temp_c'];
/** What the Rack Monitor rig can actually measure: acoustic inlet/outlet air temperature + reference probe, floor water. */
export const RIG_METRICS: Metric[] = ['inlet_temp_c', 'leak'];
const UNCERTAIN: Evidence[] = ['unverified', 'inconclusive', 'measurement_disagreement'];

const assetById = new Map<ID, Asset>(facility.assets.map((a) => [a.id, a]));
const edgeById = new Map<ID, DependencyEdge>(facility.edges.map((e) => [e.id, e]));

// ------------------------------------------------------------------ helpers

const METRIC_LABEL: Partial<Record<Metric, string>> = { inlet_temp_c: 'inlet temperature', vibration_mm_s: 'fan vibration', leak: 'liquid', ups_autonomy_min: 'UPS autonomy', battery_temp_c: 'battery temperature', supply_temp_c: 'supply temperature', humidity_rh: 'humidity', dew_point_c: 'dew point', flow_lpm: 'flow', pressure_kpa: 'pressure', load_kw: 'load' };
export const metricLabel = (m: Metric) => METRIC_LABEL[m] ?? m;
const r1 = (x: number) => Math.round(x * 10) / 10;
const fromNow = (abs: number | null, now: number) => (abs === null ? null : r1(abs - now));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Strip control characters and clamp length — model text is untrusted. */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return s ? s.slice(0, max) : null;
}
const knownAsset = (id: unknown): id is string => typeof id === 'string' && assetById.has(id);

export class ToolError extends Error {}
const fail = (msg: string): never => { throw new ToolError(msg); };

function assetIdOrFail(v: unknown, field: string): ID {
  if (!knownAsset(v)) {
    const near = typeof v === 'string' ? facility.assets.filter((a) => a.id.toLowerCase().startsWith(v.slice(0, 2).toLowerCase())).slice(0, 6).map((a) => a.id) : [];
    fail(`unknown asset id ${JSON.stringify(v)} in ${field}${near.length ? ` — did you mean one of ${near.join(', ')}?` : ''} Use ids from get_situation.`);
  }
  return v as ID;
}

// ------------------------------------------------------------------ session

interface WaterBase { arrival: Record<ID, number>; derivedEdges: DependencyEdge[]; sourceId: ID | null; startT: number | null }
const waterCache = new Map<string, WaterBase>();

function waterFor(scn: Scenario): WaterBase {
  const hit = waterCache.get(scn.id);
  if (hit) return hit;
  let base: WaterBase = { arrival: {}, derivedEdges: [], sourceId: null, startT: null };
  if (scn.leak) {
    const run = simulateScenario({ facility, scenario: scn, seedReadings: seedReadings(), runs: 1 });
    const arrival: Record<ID, number> = {};
    for (const [id, t] of Object.entries(run.waterArrival)) if (t <= scn.horizonMin) arrival[id] = t;
    const leak = scn.leak;
    const pipes = facility.assets.filter((a) => a.type === 'pipe')
      .sort((a, b) => Math.hypot(a.pos.x - leak.x, a.pos.z - leak.z) - Math.hypot(b.pos.x - leak.x, b.pos.z - leak.z));
    base = { arrival, derivedEdges: run.derivedEdges, sourceId: pipes[0]?.id ?? 'LEAK', startT: leak.startT };
  }
  waterCache.set(scn.id, base);
  return base;
}

export interface Session {
  input: DirectorInput;
  scenario: Scenario;
  now: number;
  horizon: number;
  incidents: Incident[];
  baseEdges: DependencyEdge[];
  water: WaterBase;
  runs: Map<string, CompactRun>;
  clocks: Map<string, Record<ID, ImpactClock>>;
  runKeys: Map<string, string>;
  /** Every number a tool produced, per run id (clocks of that run + deltas it took part in) */
  numbers: Map<string, Set<number>>;
  scanValues: ScanValueResult[];
  nextRun: number;
  maxRuns: number;
  baselineId: string | null;
  recommendation: Recommendation | null;
  notes: string[];
}

export class DirectorInputError extends Error {}

function sanitizeIncidents(raw: unknown): Incident[] {
  if (!Array.isArray(raw)) return [];
  const out: Incident[] = [];
  for (const i of raw.slice(0, 50)) {
    if (!isObj(i) || typeof i.id !== 'string' || !knownAsset(i.rootAssetId)) continue;
    const evidence = EVIDENCE.includes(i.evidence as Evidence) ? (i.evidence as Evidence) : 'unverified';
    out.push({
      ...(i as unknown as Incident),
      id: i.id.slice(0, 40),
      title: cleanText(i.title, 160) ?? i.id,
      alertAssetIds: Array.isArray(i.alertAssetIds) ? i.alertAssetIds.filter(knownAsset) : [],
      evidence,
      status: i.status === 'resolved' || i.status === 'monitoring' ? i.status : 'open',
      openedAt: typeof i.openedAt === 'number' && Number.isFinite(i.openedAt) ? i.openedAt : 0,
      recentChanges: Array.isArray(i.recentChanges) ? i.recentChanges.filter((s): s is string => typeof s === 'string').slice(0, 5) : [],
    });
  }
  return out;
}

function sanitizeScans(raw: unknown): Scan[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-40).filter((s): s is Scan => isObj(s) && typeof s.id === 'string' && typeof s.assetId === 'string' && isObj(s.channels));
}

export function createSession(rawInput: DirectorInput, maxRuns = MAX_RUNS_PER_SESSION): Session {
  const scenario = scenarios.find((s) => s.id === rawInput?.scenarioId);
  if (!scenario) throw new DirectorInputError(`unknown scenario ${JSON.stringify(rawInput?.scenarioId)}`);
  const now = Number(rawInput.t);
  if (!Number.isFinite(now)) throw new DirectorInputError('t must be a finite scenario minute');
  const input: DirectorInput = {
    scenarioId: scenario.id,
    t: Math.max(0, Math.min(scenario.horizonMin, now)),
    incidents: sanitizeIncidents(rawInput.incidents),
    scans: sanitizeScans(rawInput.scans),
    confirmedEdgeIds: Array.isArray(rawInput.confirmedEdgeIds) ? rawInput.confirmedEdgeIds.filter((id) => typeof id === 'string' && edgeById.has(id)) : [],
    question: cleanText(rawInput.question, 500) ?? undefined,
  };
  const notes: string[] = [];
  const dropped = (Array.isArray(rawInput.confirmedEdgeIds) ? rawInput.confirmedEdgeIds : []).filter((id) => !input.confirmedEdgeIds.includes(id));
  if (dropped.length) notes.push(`ignored unknown confirmedEdgeIds: ${dropped.slice(0, 5).join(', ')}`);
  return {
    input,
    scenario,
    now: input.t,
    horizon: scenario.horizonMin,
    incidents: input.incidents.filter((i) => i.status !== 'resolved' && i.openedAt <= input.t),
    baseEdges: input.confirmedEdgeIds.map((id) => ({ ...edgeById.get(id)!, confirmed: true })),
    water: waterFor(scenario),
    runs: new Map(),
    clocks: new Map(),
    runKeys: new Map(),
    numbers: new Map(),
    scanValues: [],
    nextRun: 1,
    maxRuns,
    baselineId: null,
    recommendation: null,
    notes,
  };
}

// ------------------------------------------------------------------ engine runs

function paramsKey(p: RunParams): string {
  const s = <T>(a: T[]) => a.map((x) => JSON.stringify(x)).sort();
  return JSON.stringify([s(p.extraFaults), s(p.confirmEdges), s(p.suppressFaults), s(p.assumeEvidence)]);
}

function addNumbers(session: Session, runId: string, values: (number | null | undefined)[]) {
  let set = session.numbers.get(runId);
  if (!set) { set = new Set(); session.numbers.set(runId, set); }
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) { set.add(v); set.add(r1(Math.abs(v))); }
}

/** Execute (or reuse) one engine run for these parameters. */
export function executeRun(session: Session, params: RunParams): { run: CompactRun; reused: boolean } {
  const key = paramsKey(params);
  const existing = session.runKeys.get(key);
  if (existing) return { run: session.runs.get(existing)!, reused: true };
  if (session.runs.size >= session.maxRuns) fail(`run cap reached (${session.maxRuns} runs this session). Compare the runs you have and call recommend.`);

  const { scenario, now, horizon, water } = session;
  const suppressed = new Set(params.suppressFaults);
  // Suppressing the leak source removes the whole water layer (the leak is not real).
  const leakOff = water.sourceId !== null && suppressed.has(water.sourceId);
  const faults: { assetId: ID; t: number }[] = scenario.faults.filter((f) => !suppressed.has(f.assetId));
  if (water.sourceId !== null && water.startT !== null && !leakOff) {
    faults.push({ assetId: water.sourceId, t: water.startT });
    for (const [assetId, t] of Object.entries(water.arrival)) if (!suppressed.has(assetId)) faults.push({ assetId, t });
  }
  faults.push(...params.extraFaults);
  const extraEdges = [
    ...session.baseEdges,
    ...params.confirmEdges.map((id) => ({ ...edgeById.get(id)!, confirmed: true })),
    ...(leakOff ? [] : water.derivedEdges.filter((e) => !suppressed.has(e.to))),
  ];
  const clocks = runCascade(facility, faults, { horizonMin: horizon, extraEdges });

  const evidence = new Map(params.assumeEvidence.map((a) => [a.incidentId, a.verdict]));
  const incidents = session.incidents.map((i) => (evidence.has(i.id) ? { ...i, evidence: evidence.get(i.id)! } : i));
  const ranked = incidents.length ? rankIncidents(incidents, { facility, clocks, now, tasks: seedTasks(), employees }) : [];

  const id = `run-${session.nextRun++}`;
  const all = Object.values(clocks);
  const lost = all.filter((c) => c.p50 !== null);
  const upcoming = lost.filter((c) => c.p50! >= now).sort((a, b) => a.p50! - b.p50! || a.assetId.localeCompare(b.assetId));
  const racks = lost.filter((c) => assetById.get(c.assetId)?.type === 'rack');
  const upcomingRacks = upcoming.filter((c) => assetById.get(c.assetId)?.type === 'rack');
  const row = (c: ImpactClock): ClockRow => ({
    assetId: c.assetId, p10: fromNow(c.p10, now), p50: fromNow(c.p50, now), p90: fromNow(c.p90, now),
    atP50: c.p50, prob: Math.round(c.probWithinHorizon * 100) / 100, path: c.path.join('>'),
  });
  const evOf = new Map(incidents.map((i) => [i.id, i.evidence]));
  const run: CompactRun = {
    id,
    label: params.label,
    params,
    now,
    horizonMin: horizon,
    topClocks: upcoming.slice(0, 8).map(row),
    lostByHorizon: lost.length,
    alreadyLost: lost.length - upcoming.length,
    lostAfterNow: upcoming.length,
    earliest: upcoming[0] ? { assetId: upcoming[0].assetId, inMin: r1(upcoming[0].p50! - now), atMin: upcoming[0].p50! } : null,
    firstRackLoss: upcomingRacks[0] ? { assetId: upcomingRacks[0].assetId, inMin: r1(upcomingRacks[0].p50! - now), atMin: upcomingRacks[0].p50! } : null,
    racksLostByHorizon: racks.length,
    ranking: ranked.map((r, i) => ({ rank: i + 1, incidentId: r.incidentId, total: r.total, evidence: evOf.get(r.incidentId) ?? 'unverified' })),
    wetArrivals: leakOff ? [] : Object.entries(water.arrival).filter(([a]) => !suppressed.has(a)).sort((a, b) => a[1] - b[1]).map(([assetId, t]) => ({ assetId, atMin: t, inMin: r1(t - now) })),
  };
  session.runs.set(id, run);
  session.clocks.set(id, clocks);
  session.runKeys.set(key, id);
  addNumbers(session, id, [now, horizon, horizon - now, ...all.flatMap((c) => [c.p10, c.p50, c.p90, fromNow(c.p10, now), fromNow(c.p50, now), fromNow(c.p90, now)]),
    ...run.wetArrivals.flatMap((w) => [w.atMin, w.inMin]), ...params.extraFaults.flatMap((f) => [f.t, f.t - now])]);
  return { run, reused: false };
}

function baseline(session: Session): CompactRun {
  if (session.baselineId) return session.runs.get(session.baselineId)!;
  const { run } = executeRun(session, { label: 'baseline — situation as modeled', extraFaults: [], confirmEdges: [], suppressFaults: [], assumeEvidence: [] });
  session.baselineId = run.id;
  return run;
}

// ------------------------------------------------------------------ comparisons

const remaining = (s: Session) => r1(s.horizon - s.now);
/** Shift between two "minutes from now" values; null (not lost within horizon) counts as the remaining horizon. */
function shift(s: Session, a: number | null, b: number | null): number {
  const x = a ?? remaining(s);
  const y = b ?? remaining(s);
  return r1(Math.abs(x - y));
}

export interface CompareResult {
  a: string; b: string;
  earliest: { a: CompactRun['earliest']; b: CompactRun['earliest']; shiftMin: number };
  firstRackLoss: { a: CompactRun['firstRackLoss']; b: CompactRun['firstRackLoss']; shiftMin: number };
  lostAfterNow: { a: number; b: number; delta: number };
  racksLostByHorizon: { a: number; b: number; delta: number };
  clockChanges: { assetId: ID; aInMin: number | null; bInMin: number | null; deltaMin: number | null }[];
  ranking: { a: ID[]; b: ID[]; topChanged: boolean; orderChanged: boolean; moved: { incidentId: ID; aRank: number | null; bRank: number | null; aTotal: number | null; bTotal: number | null }[] };
}

export function compareRuns(session: Session, aId: string, bId: string): CompareResult {
  const A = session.runs.get(aId);
  const B = session.runs.get(bId);
  if (!A || !B) fail(`unknown run id ${!A ? aId : bId}; known runs: ${[...session.runs.keys()].join(', ') || 'none'}`);
  const ca = session.clocks.get(aId)!;
  const cb = session.clocks.get(bId)!;
  const now = session.now;
  const ids = new Set([...Object.keys(ca), ...Object.keys(cb)]);
  const changes: CompareResult['clockChanges'] = [];
  for (const id of ids) {
    const x = ca[id]?.p50 ?? null;
    const y = cb[id]?.p50 ?? null;
    if (x === y || (x !== null && y !== null && Math.abs(x - y) < 0.5)) continue;
    if ((x ?? Infinity) < now && (y ?? Infinity) < now) continue; // both already past
    changes.push({ assetId: id, aInMin: fromNow(x, now), bInMin: fromNow(y, now), deltaMin: x !== null && y !== null ? r1(y - x) : null });
  }
  changes.sort((p, q) => Math.min(p.aInMin ?? 1e9, p.bInMin ?? 1e9) - Math.min(q.aInMin ?? 1e9, q.bInMin ?? 1e9) || p.assetId.localeCompare(q.assetId));
  const ra = A!.ranking.map((r) => r.incidentId);
  const rb = B!.ranking.map((r) => r.incidentId);
  const moved = [...new Set([...ra, ...rb])].map((incidentId) => {
    const x = A!.ranking.find((r) => r.incidentId === incidentId);
    const y = B!.ranking.find((r) => r.incidentId === incidentId);
    return { incidentId, aRank: x?.rank ?? null, bRank: y?.rank ?? null, aTotal: x?.total ?? null, bTotal: y?.total ?? null };
  }).filter((m) => m.aRank !== m.bRank || m.aTotal !== m.bTotal);
  const res: CompareResult = {
    a: aId, b: bId,
    earliest: { a: A!.earliest, b: B!.earliest, shiftMin: shift(session, A!.earliest?.inMin ?? null, B!.earliest?.inMin ?? null) },
    firstRackLoss: { a: A!.firstRackLoss, b: B!.firstRackLoss, shiftMin: shift(session, A!.firstRackLoss?.inMin ?? null, B!.firstRackLoss?.inMin ?? null) },
    lostAfterNow: { a: A!.lostAfterNow, b: B!.lostAfterNow, delta: B!.lostAfterNow - A!.lostAfterNow },
    racksLostByHorizon: { a: A!.racksLostByHorizon, b: B!.racksLostByHorizon, delta: B!.racksLostByHorizon - A!.racksLostByHorizon },
    clockChanges: changes.slice(0, 10),
    ranking: { a: ra, b: rb, topChanged: (ra[0] ?? null) !== (rb[0] ?? null), orderChanged: ra.join() !== rb.join(), moved },
  };
  const nums = [res.earliest.shiftMin, res.firstRackLoss.shiftMin, ...changes.flatMap((c) => [c.aInMin, c.bInMin, c.deltaMin])];
  addNumbers(session, aId, nums);
  addNumbers(session, bId, nums);
  return res;
}

/**
 * Decision value of a scan (illustrative, deterministic, documented): how much the two possible
 * readings change what the team does first.
 *   10 if the top-ranked incident changes, else 3 if the ranking order changes
 * + first-rack-loss shift (min, cap 60) / 3
 * + earliest-upcoming-loss shift (min, cap 60) / 6
 * + |Δ assets lost after now| (cap 30) / 6
 */
export const DECISION_VALUE_FORMULA = '10·[top incident changes] (else 3·[order changes]) + min(first-rack-loss shift, 60)/3 + min(earliest-loss shift, 60)/6 + min(|Δ assets lost after now|, 30)/6';
function decisionValue(c: CompareResult): number {
  const v = (c.ranking.topChanged ? 10 : c.ranking.orderChanged ? 3 : 0)
    + Math.min(c.firstRackLoss.shiftMin, 60) / 3
    + Math.min(c.earliest.shiftMin, 60) / 6
    + Math.min(Math.abs(c.lostAfterNow.delta), 30) / 6;
  return r1(v);
}

export function defaultMetricFor(session: Session, assetId: ID): Metric {
  const a = assetById.get(assetId)!;
  if (a.type === 'pipe' || a.type === 'drain' || assetId in session.water.arrival) return 'leak';
  switch (a.type) {
    case 'rack': return 'inlet_temp_c';
    case 'crah': return 'vibration_mm_s';
    case 'battery': return 'battery_temp_c';
    case 'ups': return 'ups_autonomy_min';
    case 'cdu': return 'supply_temp_c';
    default: return 'leak';
  }
}

export function scanPoint(assetId: ID, metric: Metric): string {
  const a = assetById.get(assetId)!;
  if (metric === 'leak') {
    if (a.type === 'battery' || a.zoneId === 'Z-BATT') return 'Battery room threshold, floor (floor water sensor)';
    if (a.type === 'pipe') return `Corridor floor below ${a.id} (floor water sensor)`;
    return `Floor at ${a.id} footprint (floor water sensor)`;
  }
  if (metric === 'inlet_temp_c') return `${a.id} front inlet, both beams + reference probe at sensor height`;
  return `${a.id} ${metricLabel(metric)} measurement point`;
}

function scanSummary(s: Scan): string {
  const parts: string[] = [];
  for (const [ch, st] of Object.entries(s.channels ?? {})) {
    if (st && typeof st.mean === 'number') parts.push(`${ch}=${r1(st.mean)}${st.unit ? ` ${st.unit}` : ''}`);
  }
  return `${s.id} @ ${s.assetId} (${s.point ?? '?'}) ${s.status ?? '?'}${s.source ? `, ${s.source}` : ''}: ${parts.slice(0, 6).join(', ') || 'no channels'}${s.quality?.length ? ` [${s.quality.slice(0, 4).join(', ')}]` : ''}`;
}

function relevantScan(session: Session, assetId: ID, metric: Metric): Scan | undefined {
  const channels = metric === 'leak' ? ['floor_wet'] : metric === 'inlet_temp_c' ? ['inlet_top_c', 'inlet_bottom_c', 'ref_c'] : [];
  return [...session.input.scans].reverse().find((s) => s.assetId === assetId && s.status === 'complete' && channels.some((c) => c in (s.channels ?? {})));
}

export function scanValue(session: Session, assetId: ID, metric: Metric): ScanValueResult {
  const inc = session.incidents.find((i) => i.rootAssetId === assetId) ?? session.incidents.find((i) => i.alertAssetIds.includes(assetId));
  if (!inc) fail(`no open incident covers ${assetId}; scan_value evaluates a reading against an open incident. Use run_scenario for free-form what-ifs.`);
  const incident = inc!;
  const { water, now } = session;
  baseline(session);

  let abnormal: RunParams;
  let normal: RunParams;
  let hypA: string;
  let hypN: string;
  let expects: ScanValueResult['modelExpectsNow'] = 'n/a';
  const evNormal: Evidence = metric === 'inlet_temp_c' ? 'measurement_disagreement' : 'not_corroborated_in_session';
  // the reading bears on every open incident that covers this asset (e.g. the leak and the wet-UPS incident)
  const covering = session.incidents.filter((i) => i.rootAssetId === assetId || i.alertAssetIds.includes(assetId));
  const ev = (v: Evidence) => covering.map((i) => ({ incidentId: i.id, verdict: v }));
  const P = (label: string, p: Partial<RunParams>): RunParams => ({ label, extraFaults: [], confirmEdges: [], suppressFaults: [], assumeEvidence: [], ...p });

  if (metric === 'leak' && water.sourceId !== null && (assetId === water.sourceId || assetId in water.arrival)) {
    const arr = assetId === water.sourceId ? water.startT! : water.arrival[assetId];
    if (arr <= now) {
      expects = 'abnormal';
      // A dry reading here means the water front is behind the model: everything that the model
      // wets at or after this point stays dry. At the source, the leak itself is not real.
      const later = assetId === water.sourceId ? [assetId] : Object.entries(water.arrival).filter(([, t]) => t >= arr).map(([a]) => a);
      hypA = `${assetId} reads wet — water front as modeled`;
      hypN = assetId === water.sourceId ? `${assetId}: no liquid — make-up flow mismatch is a meter/valve fault, not a leak` : `${assetId} dry — water layer overestimates spread (front stops before ${assetId})`;
      abnormal = P(hypA, { assumeEvidence: ev('corroborated_abnormal') });
      normal = P(hypN, { suppressFaults: later, assumeEvidence: ev(evNormal) });
    } else {
      expects = 'normal';
      hypA = `${assetId} already wet — water ahead of the model`;
      hypN = `${assetId} dry now — front arrives as modeled at T+${arr}`;
      abnormal = P(hypA, { extraFaults: [{ assetId, t: now }], assumeEvidence: ev('corroborated_abnormal') });
      normal = P(hypN, { assumeEvidence: ev(evNormal) });
    }
  } else {
    const hasFault = session.scenario.faults.some((f) => f.assetId === assetId);
    if (metric === 'leak') {
      expects = 'normal';
      hypA = `${assetId} wet — liquid the water layer does not model`;
      hypN = `${assetId} dry — as modeled`;
      abnormal = P(hypA, { extraFaults: [{ assetId, t: now }], assumeEvidence: ev('corroborated_abnormal') });
      normal = P(hypN, { assumeEvidence: ev(evNormal) });
    } else {
      hypA = `${assetId} ${metricLabel(metric)} alarm is real (corroborated)`;
      hypN = metric === 'inlet_temp_c'
        ? `${assetId} installed sensor disagrees with reference — telemetry problem, not heat`
        : `${assetId} reading not corroborated${hasFault ? ' — modeled fault does not happen' : ''}`;
      abnormal = P(hypA, { assumeEvidence: ev('corroborated_abnormal') });
      normal = P(hypN, { suppressFaults: hasFault ? [assetId] : [], assumeEvidence: ev(evNormal) });
    }
  }

  const ra = executeRun(session, abnormal!).run;
  const rn = executeRun(session, normal!).run;
  const cmp = compareRuns(session, ra.id, rn.id);
  const prior = relevantScan(session, assetId, metric);
  const rig = RIG_METRICS.includes(metric);
  const notes: string[] = [];
  if (!rig) notes.push(`the rig cannot measure ${metric}; dispatch the runbook check instead of a rig scan`);
  if (prior) notes.push(`already scanned (${prior.id}) — do not repeat unless conditions changed`);
  if (expects === 'normal') notes.push('the model expects a normal reading right now; an abnormal one would mean the model is behind reality');
  const res: ScanValueResult = {
    assetId, metric, incidentId: incident.id, rigMeasurable: rig, point: scanPoint(assetId, metric),
    alreadyScanned: prior ? { scanId: prior.id, summary: scanSummary(prior) } : null,
    modelExpectsNow: expects,
    runIfAbnormal: ra.id, runIfNormal: rn.id, hypothesisAbnormal: hypA!, hypothesisNormal: hypN!,
    topIfAbnormal: ra.ranking[0]?.incidentId ?? null, topIfNormal: rn.ranking[0]?.incidentId ?? null,
    topChanged: cmp.ranking.topChanged, orderChanged: cmp.ranking.orderChanged,
    earliestIfAbnormalMin: ra.earliest?.inMin ?? null, earliestIfNormalMin: rn.earliest?.inMin ?? null, earliestShiftMin: cmp.earliest.shiftMin,
    firstRackLossIfAbnormalMin: ra.firstRackLoss?.inMin ?? null, firstRackLossIfNormalMin: rn.firstRackLoss?.inMin ?? null, firstRackShiftMin: cmp.firstRackLoss.shiftMin,
    lostAfterNowDelta: cmp.lostAfterNow.delta,
    decisionValue: decisionValue(cmp),
    note: [`decisionValue = ${DECISION_VALUE_FORMULA}; null clocks count as the remaining horizon`, ...notes].join('; '),
  };
  session.scanValues.push(res);
  return res;
}

// ------------------------------------------------------------------ tool JSON schemas

const verdictEnum = EVIDENCE;
export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'get_situation',
      description: 'Live situation: scenario + now, open incidents with evidence state, latest rig scans, candidate (unconfirmed) dependency edges, and the baseline engine run (run-1) with the top time-to-impact clocks. Clock fields p10/p50/p90/inMin are MINUTES FROM NOW; atMin/atP50 are absolute scenario minutes. Call this first.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_scenario',
      description: 'Run one what-if hypothesis through the deterministic cascade engine and rank incidents under it. Returns a run id (e.g. run-2) and compact numbers: top 8 upcoming clocks (minutes from now, p10/p50/p90, probability), assets lost by the horizon, first rack loss, incident ranking. Identical parameters reuse the existing run.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Short hypothesis label, e.g. "CRAH-2 trips in 10 min"' },
          extraFaults: { type: 'array', description: 'Additional asset failures. Give either t (absolute scenario minute) or inMin (minutes from now).', items: { type: 'object', properties: { assetId: { type: 'string' }, t: { type: 'number' }, inMin: { type: 'number' } }, required: ['assetId'] } },
          confirmEdges: { type: 'array', items: { type: 'string' }, description: 'Ids of unconfirmed candidate edges (from get_situation.candidateEdges) to treat as real in this run' },
          suppressFaults: { type: 'array', items: { type: 'string' }, description: 'Asset ids whose modeled faults / water arrivals do NOT happen in this run (e.g. "sensor fault, fan is fine"). Suppressing the leaking pipe removes the whole leak.' },
          assumeEvidence: { type: 'array', items: { type: 'object', properties: { incidentId: { type: 'string' }, verdict: { type: 'string', enum: verdictEnum } }, required: ['incidentId', 'verdict'] }, description: 'Evidence overrides used for ranking in this run' },
        },
        required: ['label'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_runs',
      description: 'Deltas between two runs: earliest-loss and first-rack-loss shift (minutes), changed clocks, assets lost after now, ranking order and whether the top incident changes.',
      parameters: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scan_value',
      description: `Decision value of taking a physical scan at an asset: runs the two hypotheses for that asset's open incident (reading abnormal vs normal), and reports whether the top-ranked incident changes and how far the earliest and first-rack-loss clocks move. decisionValue = ${DECISION_VALUE_FORMULA}. The Rack Monitor rig measures only: ${RIG_METRICS.join(', ')}.`,
      parameters: { type: 'object', properties: { assetId: { type: 'string' }, metric: { type: 'string', enum: METRICS } }, required: ['assetId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recommend',
      description: 'Terminal tool. Final recommendation: the single next scan with the highest decision value (or null), the next action, the hypotheses you tested with the run ids that support them, and a short summary. Every number in text must come from a tool result; cite run ids like run-3.',
      parameters: {
        type: 'object',
        properties: {
          nextScan: { type: ['object', 'null'], properties: { assetId: { type: 'string' }, point: { type: 'string' }, reason: { type: 'string' } }, required: ['assetId', 'point', 'reason'] },
          nextAction: { type: 'string' },
          hypotheses: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, support: { type: 'string' }, runIds: { type: 'array', items: { type: 'string' } } }, required: ['label', 'support', 'runIds'] } },
          summary: { type: 'string' },
        },
        required: ['nextScan', 'nextAction', 'hypotheses', 'summary'],
      },
    },
  },
] as const;

export type ToolName = (typeof TOOL_DEFS)[number]['function']['name'];
export const TOOL_NAMES: ToolName[] = TOOL_DEFS.map((t) => t.function.name);

// ------------------------------------------------------------------ dispatch

export interface ToolOutcome {
  ok: boolean;
  /** JSON-serializable payload for the model (or { error }) */
  content: unknown;
  summary: string;
  runId?: string;
  runIds?: string[];
  terminal?: boolean;
  /** Arguments were not valid JSON */
  invalidJson?: boolean;
}

function parseRunParams(session: Session, a: Record<string, unknown>): RunParams {
  const label = cleanText(a.label, 120) ?? 'unnamed hypothesis';
  const extraFaults: RunParams['extraFaults'] = [];
  if (a.extraFaults !== undefined) {
    if (!Array.isArray(a.extraFaults)) fail('extraFaults must be an array');
    for (const f of (a.extraFaults as unknown[]).slice(0, 10)) {
      if (!isObj(f)) fail('each extraFault must be an object {assetId, t | inMin}');
      const ff = f as Record<string, unknown>;
      const assetId = assetIdOrFail(ff.assetId, 'extraFaults');
      const t = typeof ff.t === 'number' ? ff.t : typeof ff.inMin === 'number' ? session.now + ff.inMin : session.now;
      if (!Number.isFinite(t) || t < 0 || t > session.horizon) fail(`extraFaults ${assetId}: t must be within 0–${session.horizon} (scenario minutes)`);
      extraFaults.push({ assetId, t: r1(t) });
    }
  }
  const idList = (v: unknown, field: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) fail(`${field} must be an array of strings`);
    return [...new Set(v as string[])].slice(0, 20);
  };
  const confirmEdges = idList(a.confirmEdges, 'confirmEdges');
  for (const id of confirmEdges) if (!edgeById.has(id)) fail(`unknown edge id ${JSON.stringify(id)} in confirmEdges; candidate edges are listed in get_situation.candidateEdges`);
  const suppressFaults = idList(a.suppressFaults, 'suppressFaults').map((id) => assetIdOrFail(id, 'suppressFaults'));
  const assumeEvidence: RunParams['assumeEvidence'] = [];
  if (a.assumeEvidence !== undefined) {
    if (!Array.isArray(a.assumeEvidence)) fail('assumeEvidence must be an array');
    for (const e of (a.assumeEvidence as unknown[]).slice(0, 10)) {
      if (!isObj(e)) fail('each assumeEvidence item must be {incidentId, verdict}');
      const ee = e as Record<string, unknown>;
      if (!session.incidents.some((i) => i.id === ee.incidentId)) fail(`unknown incident id ${JSON.stringify(ee.incidentId)}; open incidents: ${session.incidents.map((i) => i.id).join(', ') || 'none'}`);
      if (!EVIDENCE.includes(ee.verdict as Evidence)) fail(`verdict must be one of ${EVIDENCE.join(', ')}`);
      assumeEvidence.push({ incidentId: ee.incidentId as string, verdict: ee.verdict as Evidence });
    }
  }
  return { label, extraFaults, confirmEdges: confirmEdges.filter((id) => !session.input.confirmedEdgeIds.includes(id)), suppressFaults, assumeEvidence };
}

function situation(session: Session) {
  const base = baseline(session);
  const confirmed = new Set(session.input.confirmedEdgeIds);
  return {
    scenario: { id: session.scenario.id, name: session.scenario.name, now: session.now, horizonMin: session.horizon, basis: session.scenario.basis },
    incidents: session.incidents.map((i) => ({ id: i.id, title: i.title, rootAssetId: i.rootAssetId, alertAssetIds: i.alertAssetIds.slice(0, 8), evidence: i.evidence, severity: i.severity, status: i.status, openedAt: i.openedAt, recentChanges: i.recentChanges.slice(0, 3) })),
    baseline: base,
    scans: session.input.scans.slice(-10).map(scanSummary),
    candidateEdges: facility.edges.filter((e) => !e.confirmed && !confirmed.has(e.id)).map((e) => ({ id: e.id, from: e.from, to: e.to, kind: e.kind, basis: e.basis })),
    confirmedExtraEdges: [...confirmed],
    rigMeasurableMetrics: RIG_METRICS,
    scanHoldS: TARGET_HOLD_S,
    units: 'p10/p50/p90/inMin = minutes from now; atMin/atP50 = absolute scenario minutes; null = not lost within the horizon at that percentile',
    question: session.input.question ?? null,
    notes: session.notes,
  };
}

function runSummary(r: CompactRun): string {
  const e = r.earliest ? `earliest ${r.earliest.assetId} in ${r.earliest.inMin} min` : 'no upcoming loss';
  const f = r.firstRackLoss ? `first rack ${r.firstRackLoss.assetId} in ${r.firstRackLoss.inMin} min` : 'no rack loss in horizon';
  return `${r.id} "${r.label}": ${e}; ${f}; ${r.lostAfterNow} assets lost after now; top ${r.ranking[0]?.incidentId ?? '—'}`;
}

function parseRecommendation(session: Session, a: Record<string, unknown>): Recommendation {
  if (session.runs.size === 0) fail('no engine runs yet — call get_situation / scan_value / run_scenario before recommend');
  let nextScan: Recommendation['nextScan'] = null;
  if (a.nextScan !== null && a.nextScan !== undefined) {
    if (!isObj(a.nextScan)) fail('nextScan must be an object {assetId, point, reason} or null');
    const ns = a.nextScan as Record<string, unknown>;
    const assetId = assetIdOrFail(ns.assetId, 'nextScan.assetId');
    nextScan = { assetId, point: cleanText(ns.point, 160) ?? scanPoint(assetId, defaultMetricFor(session, assetId)), reason: cleanText(ns.reason, 500) ?? '', holdS: TARGET_HOLD_S as 10 };
  }
  const nextAction = cleanText(a.nextAction, 600);
  if (!nextAction) fail('nextAction is required (string)');
  const summary = cleanText(a.summary, 1200);
  if (!summary) fail('summary is required (string)');
  if (!Array.isArray(a.hypotheses) || a.hypotheses.length === 0) fail('hypotheses must be a non-empty array of {label, support, runIds}');
  const hypotheses = (a.hypotheses as unknown[]).slice(0, 6).map((h, i) => {
    if (!isObj(h)) fail(`hypotheses[${i}] must be an object`);
    const hh = h as Record<string, unknown>;
    const runIds = Array.isArray(hh.runIds) ? hh.runIds.filter((x): x is string => typeof x === 'string').slice(0, 8) : [];
    if (!runIds.length) fail(`hypotheses[${i}].runIds must cite at least one run id`);
    const unknown = runIds.filter((r) => !session.runs.has(r));
    if (unknown.length) fail(`hypotheses[${i}] cites unknown run ids ${unknown.join(', ')}; known runs: ${[...session.runs.keys()].join(', ')}`);
    return { label: cleanText(hh.label, 160) ?? `hypothesis ${i + 1}`, support: cleanText(hh.support, 400) ?? '', runIds };
  });
  return { nextScan, nextAction: nextAction!, hypotheses, summary: summary! };
}

/**
 * Dispatch a tool call by whitelisted name with untrusted arguments (a JSON string from the
 * model, or an object from the local planner). Never throws: errors become tool messages.
 */
export function dispatchTool(session: Session, name: string, rawArgs: unknown): ToolOutcome {
  let args: unknown = rawArgs ?? {};
  if (typeof rawArgs === 'string') {
    if (rawArgs.trim() === '') args = {};
    else {
      try { args = JSON.parse(rawArgs); } catch {
        return { ok: false, invalidJson: true, content: { error: 'arguments are not valid JSON — resend the call with a JSON object matching the tool schema' }, summary: `rejected: invalid JSON arguments for ${String(name).slice(0, 40)}` };
      }
    }
  }
  if (!isObj(args)) return { ok: false, invalidJson: true, content: { error: 'arguments must be a JSON object' }, summary: 'rejected: arguments not an object' };
  if (!TOOL_NAMES.includes(name as ToolName)) return { ok: false, content: { error: `unknown tool ${JSON.stringify(String(name).slice(0, 40))}; available: ${TOOL_NAMES.join(', ')}` }, summary: `rejected: unknown tool ${String(name).slice(0, 40)}` };
  try {
    switch (name as ToolName) {
      case 'get_situation': {
        const s = situation(session);
        return { ok: true, content: s, summary: `${s.incidents.length} open incidents at T+${session.now}; ${runSummary(s.baseline)}`, runId: s.baseline.id };
      }
      case 'run_scenario': {
        const p = parseRunParams(session, args);
        const { run, reused } = executeRun(session, p);
        return { ok: true, content: { ...run, reused }, summary: `${reused ? '(reused) ' : ''}${runSummary(run)}`, runId: run.id };
      }
      case 'compare_runs': {
        const c = compareRuns(session, String(args.a ?? ''), String(args.b ?? ''));
        return { ok: true, content: c, summary: `${c.a} vs ${c.b}: first-rack-loss shift ${c.firstRackLoss.shiftMin} min, earliest shift ${c.earliest.shiftMin} min, top ${c.ranking.topChanged ? 'changes' : 'unchanged'}`, runIds: [c.a, c.b] };
      }
      case 'scan_value': {
        const assetId = assetIdOrFail(args.assetId, 'assetId');
        let metric = args.metric as Metric | undefined;
        if (metric === undefined) metric = defaultMetricFor(session, assetId);
        if (!METRICS.includes(metric)) fail(`metric must be one of ${METRICS.join(', ')}`);
        const v = scanValue(session, assetId, metric);
        return {
          ok: true, content: v,
          summary: `${assetId} ${metric} (${v.incidentId}): decision value ${v.decisionValue} — ${v.runIfAbnormal} vs ${v.runIfNormal}, first-rack-loss shift ${v.firstRackShiftMin} min, top ${v.topChanged ? 'changes' : 'unchanged'}${v.rigMeasurable ? '' : ' (not rig-measurable)'}${v.alreadyScanned ? ' (already scanned)' : ''}`,
          runId: `${v.runIfAbnormal}/${v.runIfNormal}`, runIds: [v.runIfAbnormal, v.runIfNormal],
        };
      }
      case 'recommend': {
        const rec = parseRecommendation(session, args);
        session.recommendation = rec;
        return { ok: true, terminal: true, content: { accepted: true }, summary: rec.nextScan ? `next scan ${rec.nextScan.assetId} — ${rec.nextScan.point}` : `no scan; ${rec.nextAction.slice(0, 120)}`, runIds: [...new Set(rec.hypotheses.flatMap((h) => h.runIds))] };
      }
    }
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, content: { error: e.message }, summary: `rejected: ${e.message.slice(0, 160)}` };
    throw e;
  }
  return { ok: false, content: { error: 'unreachable' }, summary: 'rejected' };
}

export { UNCERTAIN as UNCERTAIN_EVIDENCE };
