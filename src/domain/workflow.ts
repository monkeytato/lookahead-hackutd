/** Shared laptop/phone incident record. Demo alerts never command physical equipment. */
import { facility } from './fixture';
import { sensorBaseline, sensorsFor } from './sensors';
export type ErrorKind = 'sensor' | 'heat' | 'water' | 'vibration';
export interface Evidence {
  value: number; unit: string; source: 'live' | 'simulated' | 'fixture';
  scanId: string; at: string; verdict: 'confirmed' | 'disagrees' | 'inconclusive'; note: string;
}
export interface WorkIssue {
  id: string; kind: ErrorKind; assetId: string; title: string; location: string;
  installed: number; unit: string; status: 'new' | 'acknowledged' | 'verified' | 'resolved';
  createdAt: string; evidence?: Evidence; ownerId?: string; steps: { id: string; label: string; done: boolean }[];
  resolution?: string;
  /** Labels of checklist steps left unchecked when the outcome was submitted. Absent on complete closes. */
  incomplete?: string[];
}
export interface WorkEvent { id: string; at: string; actor: string; issueId?: string; assetId?: string; kind: string; summary: string; source: string; flag?: 'incomplete' }
export interface WorkAnalysis { issueId: string; provider: string; summary: string; nextAction: string; at: string; runs: number; warnings: string[]; comparison?: { action: string; without: number; with: number; saved: number; assumptions: string; ensemble?: EnsembleComparison } }

/** One side of the ensemble comparison (engine output; minutes are from "now"). */
export interface EnsembleSide {
  racksP10: number; racksP50: number; racksP90: number; racksMean: number;
  /** P(any criticality ≥ 4 service has every replica impacted within the horizon) */
  pServiceDown: number; ci90: [number, number];
  /** service-impact clock: inlet ≥ T_trip ~ U(40, 45) °C, or a power / water loss */
  firstImpactMin: { p10: number | null; p50: number | null; p90: number | null } | null;
  /** out-of-envelope clock: inlet ≥ 32 °C (ASHRAE A1 allowable) */
  firstEnvelopeMin: { p10: number | null; p50: number | null; p90: number | null } | null;
}
/** Optional ensemble detail on WorkAnalysis.comparison (PREDICTION-SCIENCE.md §6 Step 6). Absent on older analyses. */
export interface EnsembleComparison {
  trials: number; ess: number; provider: 'nemotron' | 'local_planner';
  /** evidence posterior P(alarm reflects a real condition) used as the hypothesis weight */
  pReal: number; pRealBasis: string;
  scenarioId: string; horizonMin: number;
  without: EnsembleSide; with: EnsembleSide;
  /** Design A: the stress region carrying the largest share of the remaining failure probability */
  dominantFailure?: { label: string; priorOneIn: number; shareOfFailure: number; pFailGivenRegion: number };
  stress?: { by: 'nemotron' | 'cross_entropy'; trials: number; ess: number; pFail: number; ci90: [number, number]; rounds: number; regions: { label: string; priorOneIn: number; shareOfFailure: number; pFailGivenRegion: number }[]; rejected: number };
  /** Design B: highest expected value of sample information among rig-measurable scans */
  nextScan?: { assetId: string; point: string; evsi: number; why: string };
  hypotheses: { label: string; p: number; basisKind: string }[];
  coverageNote: string;
  /** what each number rests on */
  basis: string;
}
export interface WorkState { version: 1; revision: number; issues: WorkIssue[]; events: WorkEvent[]; analyses: WorkAnalysis[] }
export const ERROR_CHOICES: { id: ErrorKind; title: string; hint: string }[] = [
  { id: 'sensor', title: 'Temperature alert', hint: 'A-11 · independent reading may disagree' },
  { id: 'heat', title: 'Cooling failure', hint: 'CH-1 · check downstream cooling risk' },
  { id: 'water', title: 'Water leak', hint: 'PIPE-L2 · water moving toward power equipment' },
  { id: 'vibration', title: 'Fan vibration', hint: 'CRAH-2 · inspect before replacing equipment' },
];
export function emptyWork(): WorkState { return { version: 1, revision: 0, issues: [], events: [], analyses: [] }; }
export const CATALOG: Record<ErrorKind, { assetId: string; title: string; location: string; installed: number; unit: string }> = {
  sensor: { assetId: 'A-11', title: 'Rack inlet temperature is high', location: 'Hall A · Row A · Rack 11 · front inlet', installed: 34.2, unit: '°C' },
  heat: { assetId: 'CH-1', title: 'Chiller supply temperature is high', location: 'Mechanical yard · Chiller 1', installed: 30.8, unit: '°C' },
  water: { assetId: 'PIPE-L2', title: 'Possible chilled-water leak', location: 'East corridor · Level 2 riser · floor below pipe', installed: 1, unit: 'wet' },
  vibration: { assetId: 'CRAH-2', title: 'Cooling fan vibration is rising', location: 'Hall A · CRAH 2 · fan housing', installed: 6.8, unit: 'mm/s' },
};
export type WorkCommand =
  | { type: 'simulate_error'; kind: ErrorKind }
  | { type: 'create_response'; kind: ErrorKind; assetId: string; title: string }
  | { type: 'acknowledge'; issueId: string }
  | { type: 'verify_fixture'; issueId: string }
  | { type: 'evidence'; issueId: string; evidence: Evidence }
  | { type: 'assign'; issueId: string; employeeId: string }
  | { type: 'check'; issueId: string; stepId: string; done: boolean }
  | { type: 'resolve'; issueId: string; note: string }
  | { type: 'analysis'; analysis: WorkAnalysis }
  | { type: 'note'; issueId?: string; text: string }
  | { type: 'review' }
  | { type: 'reset' };

/** Independent evidence: a conclusive portable-sensor reading (live or simulated device). A scripted fixture reference is not a measurement. */
export function hasIndependentEvidence(i: WorkIssue): boolean {
  return !!i.evidence && i.evidence.verdict !== 'inconclusive' && i.evidence.source !== 'fixture';
}
/** Whether a checklist step counts as done. `verify` counts only with independent evidence attached. */
export function stepDone(i: WorkIssue, step: WorkIssue['steps'][number]): boolean {
  return step.done && (step.id !== 'verify' || hasIndependentEvidence(i));
}
/** Steps that would be left unchecked if the issue were closed now: the one rule the reducer, handoff review and every view use. */
export function uncheckedSteps(i: WorkIssue): string[] {
  return i.steps.filter(x => !stepDone(i, x)).map(x => x.label);
}
const defaultSteps = (): WorkIssue['steps'] => [{ id: 'locate', label: 'Confirm equipment and measurement point', done: false }, { id: 'verify', label: 'Collect independent sensor evidence', done: false }, { id: 'act', label: 'Record inspection or response performed', done: false }, { id: 'recheck', label: 'Recheck equipment and record outcome', done: false }];
/** Location of an operator-created response: zone and equipment name from the facility fixture. */
export function assetLocation(assetId: string): string {
  const a = facility.assets.find(x => x.id === assetId);
  return a ? `${facility.zones.find(z => z.id === a.zoneId)?.name ?? a.zoneId} · ${a.name}` : '';
}
/** Installed reading of an operator-created response: the asset's baseline fixture reading for the warning type. */
function installedFor(assetId: string, kind: ErrorKind): { installed: number; unit: string } {
  const a = facility.assets.find(x => x.id === assetId)!;
  const metric = kind === 'water' ? 'leak' : kind === 'vibration' ? 'vibration_mm_s' : kind === 'heat' && sensorsFor(a).includes('supply_temp_c') ? 'supply_temp_c' : sensorsFor(a)[0];
  const r = sensorBaseline({ ...facility, assets: [a] }).find(x => x.metric === metric);
  return { installed: r?.value ?? 0, unit: kind === 'water' ? 'wet' : r?.unit ?? '' };
}

export function reviewWork(s: WorkState): string[] {
  const closedIncomplete = s.issues.filter(i => i.status === 'resolved' && i.incomplete?.length)
    .map(i => `${i.assetId}: closed with ${i.incomplete!.length} unchecked step${i.incomplete!.length === 1 ? '' : 's'}: ${i.incomplete!.join('; ')}.`);
  return [...s.issues.filter(i => i.status !== 'resolved').flatMap(i => [
    ...(!i.evidence ? [`${i.assetId}: independent evidence is missing.`] : []),
    ...(!i.ownerId ? [`${i.assetId}: no technician owns the next step.`] : []),
    ...(uncheckedSteps(i).length ? [`${i.assetId}: checklist is incomplete.`] : []),
    ...(i.evidence?.verdict === 'disagrees' ? [`${i.assetId}: readings disagree; inspect sensor placement/calibration before changing equipment.`] : []),
  ]), ...closedIncomplete];
}

/** Pure reducer: timestamps/ids are injected for repeatable lifecycle tests. */
export function changeWork(state: WorkState, command: WorkCommand, actor: string, at: string, uid: string): WorkState {
  const s = structuredClone(state);
  const log = (kind: string, summary: string, source = 'operator', issue?: WorkIssue, flag?: WorkEvent['flag']) => s.events.push({ id: uid, at, actor, kind, summary, source, issueId: issue?.id, assetId: issue?.assetId, ...(flag ? { flag } : {}) });
  if (command.type === 'reset') {
    const fresh = emptyWork(); fresh.revision = state.revision + 1;
    fresh.events = [{ id: uid, at, actor, kind: 'session', summary: 'New demo session. Previous session cleared by presenter.', source: 'demo' }];
    return fresh;
  }
  if (command.type === 'simulate_error') {
    if (!(command.kind in CATALOG)) throw new Error('Unknown demo incident');
    // Same equipment and type only: an operator-created response on other equipment never blocks the demo warning.
    if (s.issues.some(i => i.kind === command.kind && i.assetId === CATALOG[command.kind].assetId && i.status !== 'resolved')) throw new Error('This warning is already active. Resolve it before triggering another.');
    const i: WorkIssue = { ...CATALOG[command.kind], id: `INC-${uid.slice(0,8)}`, kind: command.kind, status: 'new', createdAt: at, steps: defaultSteps() };
    s.issues.push(i); log('alert', `${i.assetId}: ${i.title}. Warning injected from demo controller.`, 'demo alert', i);
  } else if (command.type === 'create_response') {
    if (!(command.kind in CATALOG)) throw new Error('Choose a response type');
    if (!facility.assets.some(a => a.id === command.assetId)) throw new Error('Choose equipment from the facility list');
    const title = command.title.trim().slice(0, 120);
    if (title.length < 3) throw new Error('Give the response a title (at least 3 characters)');
    if (s.issues.some(i => i.kind === command.kind && i.assetId === command.assetId && i.status !== 'resolved')) throw new Error('A response of this type is already open for this equipment. Close it before creating another.');
    // Created by the operator, so it starts acknowledged; independent verification is next, as for a demo warning.
    const i: WorkIssue = { id: `INC-${uid.slice(0,8)}`, kind: command.kind, assetId: command.assetId, title, location: assetLocation(command.assetId), ...installedFor(command.assetId, command.kind), status: 'acknowledged', createdAt: at, steps: defaultSteps() };
    s.issues.push(i); log('response', `${i.assetId}: ${i.title}. Team response created by operator (${ERROR_CHOICES.find(c => c.id === i.kind)!.title.toLowerCase()}).`, 'operator-created response', i);
  } else if (command.type === 'note') {
    if (command.text.trim().length < 8) throw new Error('Add at least 8 characters of context');
    const i = command.issueId ? s.issues.find(x => x.id === command.issueId) : undefined;
    log('context', command.text.trim().slice(0, 600), 'operator note · unverified context', i);
  } else if (command.type === 'review') {
    const gaps = reviewWork(s);
    log('review', gaps.length ? `Handoff checks: ${gaps.join(' ')}` : 'Handoff checks passed: no open ownership, evidence or checklist gaps.', 'rule-based review');
  } else if (command.type === 'analysis') {
    s.analyses.push(command.analysis);
    log('analysis', command.analysis.summary, command.analysis.provider, s.issues.find(i => i.id === command.analysis.issueId));
  } else {
    const i = s.issues.find(i => i.id === command.issueId);
    if (!i) throw new Error('Incident not found');
    if (i.status === 'resolved') throw new Error('This incident is already closed');
    switch (command.type) {
      case 'acknowledge':
        if (i.status !== 'new') throw new Error('Warning already acknowledged');
        i.status = 'acknowledged'; log('acknowledgement', `Acknowledged ${i.assetId}; independent verification is next.`, 'operator', i); break;
      case 'verify_fixture': {
        // The scripted values and verdicts are written for the demo warning equipment; they mean nothing elsewhere.
        if (i.assetId !== CATALOG[i.kind].assetId) throw new Error('The scripted demo reference exists for the demo warnings only. Take a portable sensor scan.');
        const value = i.kind === 'sensor' ? 22.4 : i.kind === 'water' ? 1 : i.kind === 'heat' ? 31 : 6.5;
        i.evidence = { value, unit: i.unit, source: 'fixture', at, scanId: `FIXTURE-${uid}`, verdict: i.kind === 'sensor' ? 'disagrees' : 'confirmed', note: 'Scripted reference reading for the walkthrough; no physical measurement was taken.' };
        i.status = 'verified'; i.steps.find(x => x.id === 'verify')!.done = true;
        log('verification', `${i.assetId}: installed ${i.installed} ${i.unit}, reference ${value} ${i.unit}; ${i.evidence.verdict}.`, 'fixture reference', i); break;
      }
      case 'evidence':
        i.evidence = command.evidence;
        i.status = command.evidence.verdict === 'inconclusive' ? 'acknowledged' : 'verified';
        i.steps.find(x => x.id === 'verify')!.done = command.evidence.verdict !== 'inconclusive';
        log('verification', `${i.assetId} [scan ${command.evidence.scanId}]: independent ${command.evidence.value} ${command.evidence.unit}; ${command.evidence.verdict}. ${command.evidence.note}`, `${command.evidence.source} portable sensor`, i); break;
      case 'assign':
        if (!command.employeeId) throw new Error('Choose a technician');
        i.ownerId = command.employeeId; log('assignment', `${i.assetId}: assigned to ${command.employeeId}.`, 'operator', i); break;
      case 'check': {
        if (!i.ownerId) throw new Error('Assign a technician before recording work');
        if (command.stepId === 'verify') throw new Error('Verification completes only when evidence is attached');
        const step = i.steps.find(x => x.id === command.stepId);
        if (!step) throw new Error('Unknown checklist step');
        step.done = command.done; log('checklist', `${command.done ? 'Completed' : 'Reopened'}: ${step.label}.`, 'operator', i); break;
      }
      case 'resolve': {
        if (!i.ownerId) throw new Error('Assign a technician before submitting the outcome');
        if (command.note.trim().length < 8) throw new Error('Record the inspection result and what changed (at least 8 characters)');
        const missing = uncheckedSteps(i);
        i.status = 'resolved'; i.resolution = command.note.trim().slice(0,600);
        if (missing.length) {
          i.incomplete = missing;
          log('resolution', `${i.assetId}: INCOMPLETE submission, ${missing.length} unchecked step${missing.length === 1 ? '' : 's'} (${missing.join('; ')}). ${i.resolution}`, 'operator-submitted outcome · incomplete', i, 'incomplete');
        } else log('resolution', `${i.assetId}: ${i.resolution}`, 'operator-confirmed outcome', i);
        break;
      }
    }
  }
  s.events = s.events.slice(-250); s.analyses = s.analyses.slice(-25); s.revision++;
  return s;
}
