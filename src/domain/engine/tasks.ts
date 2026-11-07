/**
 * Work-order state machine and assignee suggestion.
 *
 * `transition` is pure: it never mutates the input task, enforces optimistic concurrency via
 * `expectedVersion` (A10), and returns the new task (version + 1) plus the OpEvent to log.
 *
 *   unassigned ─assign→ assigned ─accept→ accepted ─depart→ en_route ─arrive→ at_asset
 *   at_asset ─confirm_asset(scan)→ at_asset (assetConfirmed) ─start→ in_progress
 *   in_progress ─record_step…─submit→ submitted_for_review ─approve→ completed
 *                                    (no review required: submit → completed)
 *   submitted_for_review ─request_changes→ in_progress
 *   completed / submitted_for_review / cancelled ─reopen→ reopened (checklist kept, A16)
 *   active states ─block→ blocked ─unblock→ previous state;  non-terminal ─cancel→ cancelled
 *   assigned ─decline→ unassigned
 */
import type { Employee, Facility, ID, OpEvent, Route, Skill, Task, TaskStatus } from '../types';
import { findRoute } from './routing';

export type TaskAction =
  | { type: 'assign'; ownerId: ID }
  | { type: 'accept' }
  | { type: 'decline'; reason: string }
  | { type: 'depart' }
  | { type: 'arrive' }
  | { type: 'confirm_asset'; scannedId: ID }
  | { type: 'start' }
  | { type: 'record_step'; stepId: ID; result: 'pass' | 'fail' | 'not_assessed'; note?: string; evidenceId?: ID }
  | { type: 'block'; reason: string }
  | { type: 'unblock' }
  | { type: 'submit' }
  | { type: 'approve' }
  | { type: 'request_changes'; reason: string }
  | { type: 'reopen'; reason: string }
  | { type: 'cancel'; reason: string };

export type TransitionError =
  | 'stale_version'
  | 'illegal_transition'
  | 'asset_mismatch'
  | 'asset_not_confirmed'
  | 'required_steps_incomplete'
  | 'unknown_step'
  | 'missing_owner';

export type TransitionResult =
  | { ok: true; task: Task; event: OpEvent }
  | { ok: false; error: TransitionError; message: string };

export interface TransitionContext {
  actor: string;
  t: number;
  expectedVersion: number;
  /** Wall-clock ingestion time for the event; defaults to now. Pass for deterministic output. */
  ingestedAt?: string;
}

/** True when every required checklist step has a recorded result. */
export function canComplete(task: Task): boolean {
  return task.checklist.every((s) => !s.required || s.result !== undefined);
}

const ACTIVE: TaskStatus[] = ['assigned', 'accepted', 'en_route', 'at_asset', 'in_progress', 'reopened'];
const TERMINAL: TaskStatus[] = ['completed', 'cancelled'];

export function transition(task: Task, action: TaskAction, ctx: TransitionContext): TransitionResult {
  const err = (error: TransitionError, message: string): TransitionResult => ({ ok: false, error, message });
  if (ctx.expectedVersion !== task.version) {
    return err('stale_version', `Task ${task.id} is at version ${task.version}; you edited version ${ctx.expectedVersion}. Reload and retry.`);
  }
  const illegal = () => err('illegal_transition', `Cannot ${action.type} a task that is ${task.status}.`);
  const s = task.status;
  // shallow copy; checklist copied only when a step changes
  let next: Task = { ...task };
  let summary = '';

  switch (action.type) {
    case 'assign':
      if (!['unassigned', 'assigned', 'reopened', 'accepted'].includes(s)) return illegal();
      next = { ...next, status: 'assigned', ownerId: action.ownerId };
      summary = `${task.id} assigned to ${action.ownerId}`;
      break;
    case 'accept':
      if (s !== 'assigned' && s !== 'reopened') return illegal();
      if (!task.ownerId) return err('missing_owner', `${task.id} has no owner to accept it.`);
      next.status = 'accepted';
      summary = `${task.ownerId} accepted ${task.id}`;
      break;
    case 'decline':
      if (s !== 'assigned') return illegal();
      next = { ...next, status: 'unassigned', ownerId: undefined };
      summary = `${task.ownerId ?? ctx.actor} declined ${task.id}: ${action.reason}`;
      break;
    case 'depart':
      if (s !== 'accepted') return illegal();
      next.status = 'en_route';
      summary = `${task.ownerId ?? ctx.actor} en route to ${task.assetId}`;
      break;
    case 'arrive':
      if (s !== 'en_route' && s !== 'accepted') return illegal();
      next.status = 'at_asset';
      summary = `${task.ownerId ?? ctx.actor} arrived at ${task.assetId}`;
      break;
    case 'confirm_asset':
      if (s !== 'at_asset' && s !== 'en_route' && s !== 'accepted') return illegal();
      if (action.scannedId !== task.assetId) {
        return err('asset_mismatch', `Scanned ${action.scannedId}, but this task is for ${task.assetId}. Do not start work on the wrong asset.`);
      }
      next = { ...next, status: 'at_asset', assetConfirmed: true };
      summary = `Asset ${task.assetId} confirmed by scan for ${task.id}`;
      break;
    case 'start':
      if (s !== 'at_asset') return illegal();
      if (!task.assetConfirmed) return err('asset_not_confirmed', `Confirm the asset ID (${task.assetId}) before starting ${task.id}.`);
      next.status = 'in_progress';
      summary = `Work started on ${task.id}`;
      break;
    case 'record_step': {
      if (s !== 'in_progress') return illegal();
      const idx = task.checklist.findIndex((st) => st.id === action.stepId);
      if (idx < 0) return err('unknown_step', `Step ${action.stepId} is not on ${task.id}'s checklist.`);
      const old = task.checklist[idx];
      const step = {
        ...old,
        result: action.result,
        note: action.note ?? old.note,
        evidenceIds: action.evidenceId ? [...old.evidenceIds, action.evidenceId] : [...old.evidenceIds],
      };
      next.checklist = task.checklist.map((st, i) => (i === idx ? step : st));
      summary = `${task.id} step "${old.text}" recorded: ${action.result}`;
      break;
    }
    case 'block':
      if (!ACTIVE.includes(s)) return illegal();
      next = { ...next, status: 'blocked', blocker: action.reason, blockedFrom: s };
      summary = `${task.id} blocked: ${action.reason}`;
      break;
    case 'unblock':
      if (s !== 'blocked') return illegal();
      next = { ...next, status: task.blockedFrom ?? (task.ownerId ? 'assigned' : 'unassigned'), blocker: undefined, blockedFrom: undefined };
      summary = `${task.id} unblocked`;
      break;
    case 'submit':
      if (s !== 'in_progress') return illegal();
      if (!canComplete(task)) {
        const missing = task.checklist.filter((st) => st.required && st.result === undefined).map((st) => st.id);
        return err('required_steps_incomplete', `Required steps not recorded: ${missing.join(', ')}.`);
      }
      next.status = task.reviewRequired ? 'submitted_for_review' : 'completed';
      summary = task.reviewRequired ? `${task.id} submitted for review` : `${task.id} completed`;
      break;
    case 'approve':
      if (s !== 'submitted_for_review') return illegal();
      next.status = 'completed';
      summary = `${task.id} approved by ${ctx.actor}`;
      break;
    case 'request_changes':
      if (s !== 'submitted_for_review') return illegal();
      next.status = 'in_progress';
      summary = `${ctx.actor} requested changes on ${task.id}: ${action.reason}`;
      break;
    case 'reopen':
      if (s !== 'completed' && s !== 'submitted_for_review' && s !== 'cancelled') return illegal();
      // Checklist and evidence are preserved; the asset must be re-confirmed on return.
      next = { ...next, status: 'reopened', assetConfirmed: false };
      summary = `${task.id} reopened by ${ctx.actor}: ${action.reason}`;
      break;
    case 'cancel':
      if (TERMINAL.includes(s)) return illegal();
      next.status = 'cancelled';
      summary = `${task.id} cancelled: ${action.reason}`;
      break;
  }

  next.version = task.version + 1;
  const event: OpEvent = {
    id: `EV-${task.id}-v${next.version}`,
    t: ctx.t,
    ingestedAt: ctx.ingestedAt ?? new Date().toISOString(),
    kind: 'task',
    actor: ctx.actor,
    summary,
    links: { taskId: task.id, assetId: task.assetId, incidentId: task.incidentId, employeeId: next.ownerId },
    source: 'operator',
  };
  return { ok: true, task: next, event };
}

// ------------------------------------------------------------- assignees

export interface AssigneeSuggestion {
  employeeId: ID;
  eligible: boolean;
  reasons: string[];
  route?: Route;
  score: number;
}

const CHECKIN_STALE_MIN = 30;
const STALE_PENALTY_MIN = 5;
const OPEN_STATES: TaskStatus[] = ['assigned', 'accepted', 'en_route', 'at_asset', 'in_progress', 'blocked', 'reopened'];

/**
 * Rank employees for a task. Eligible = available, holds every required skill, and has access to
 * the asset's zone. Ranked by walking ETA from last check-in (+5 min if the check-in is older than
 * 30 min) plus 10 min per open task already owned. `score` is 0–100, higher is better; ineligible
 * people are included (score 0) with the reasons, so the UI can explain who was excluded and why.
 */
export function suggestAssignees(task: Task, employees: Employee[], facility: Facility, now: number, tasks: Task[] = []): AssigneeSuggestion[] {
  const asset = facility.assets.find((a) => a.id === task.assetId);
  const out: AssigneeSuggestion[] = employees.map((emp) => {
    const reasons: string[] = [];
    let eligible = true;
    if (emp.availability !== 'available') { eligible = false; reasons.push(emp.availability === 'busy' ? 'Busy on other work' : 'Off shift'); }
    const missing = task.requiredSkills.filter((sk: Skill) => !emp.skills.includes(sk));
    if (missing.length) { eligible = false; reasons.push(`Missing skill: ${missing.join(', ')}`); }
    if (asset && !emp.zones.includes(asset.zoneId)) { eligible = false; reasons.push(`No access to zone ${asset.zoneId}`); }
    if (eligible) reasons.push(`Has ${task.requiredSkills.join(', ') || 'no specific'} skill; ${asset ? `${asset.zoneId} access` : 'zone n/a'}`);

    let cost = 0;
    let route: Route | undefined;
    if (!emp.location) {
      reasons.push('No check-in on record — location unknown');
      cost += 15;
    } else if (asset) {
      route = findRoute(facility, emp.location.waypointId, asset.accessWaypoint, {
        skills: emp.skills,
        startSource: { source: emp.location.source, t: emp.location.t, now },
      });
      const age = now - emp.location.t;
      if (age > CHECKIN_STALE_MIN) {
        reasons.push(`Location stale (${Math.round(age)} min since check-in) — +${STALE_PENALTY_MIN} min`);
        cost += STALE_PENALTY_MIN;
      }
      if (route.ok) {
        cost += route.etaMin;
        reasons.push(`ETA ${route.etaMin} min from ${emp.location.waypointId}`);
      } else {
        eligible = false;
        reasons.push(`No route: ${route.blockedReason}`);
      }
    }
    const load = tasks.filter((t) => t.ownerId === emp.id && t.id !== task.id && OPEN_STATES.includes(t.status)).length;
    if (load) { reasons.push(`${load} open task${load > 1 ? 's' : ''} already`); cost += 10 * load; }

    const score = eligible ? Math.max(0, Math.round((100 - cost * 3) * 10) / 10) : 0;
    return { employeeId: emp.id, eligible, reasons, route, score };
  });
  return out.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.employeeId.localeCompare(b.employeeId));
}
