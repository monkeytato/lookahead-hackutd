import { describe, expect, it } from 'vitest';
import { canComplete, suggestAssignees, transition } from '../../src/domain/engine';
import type { TaskAction } from '../../src/domain/engine';
import { employees, facility, seedTasks } from '../../src/domain/fixture';
import type { Task } from '../../src/domain/types';

const ctx = (task: Task, t = 5) => ({ actor: 'emp-priya', t, expectedVersion: task.version, ingestedAt: '2026-11-07T02:15:00Z' });
function apply(task: Task, ...actions: TaskAction[]): Task {
  let cur = task;
  for (const a of actions) {
    const r = transition(cur, a, ctx(cur));
    if (!r.ok) throw new Error(`${a.type}: ${r.error}`);
    cur = r.task;
  }
  return cur;
}
const tsk = (id: string) => seedTasks().find((t) => t.id === id)!;
const toAsset = (t: Task) => apply(t, { type: 'assign', ownerId: 'emp-marcus' }, { type: 'accept' }, { type: 'depart' }, { type: 'arrive' });

describe('task state machine', () => {
  it('A13: start before confirm_asset fails; wrong asset id fails', () => {
    const t = toAsset(tsk('TSK-201'));
    expect(t.status).toBe('at_asset');
    const early = transition(t, { type: 'start' }, ctx(t));
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.error).toBe('asset_not_confirmed');
    const wrong = transition(t, { type: 'confirm_asset', scannedId: 'A-12' }, ctx(t));
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toBe('asset_mismatch');
    const started = apply(t, { type: 'confirm_asset', scannedId: 'A-11' }, { type: 'start' });
    expect(started.status).toBe('in_progress');
    expect(started.assetConfirmed).toBe(true);
  });

  it('A14: submit without required steps fails; with them a no-review task completes', () => {
    const t = apply(toAsset(tsk('TSK-201')), { type: 'confirm_asset', scannedId: 'A-11' }, { type: 'start' });
    const sub = transition(t, { type: 'submit' }, ctx(t));
    expect(sub.ok).toBe(false);
    if (!sub.ok) expect(sub.error).toBe('required_steps_incomplete');
    const required = t.checklist.filter((s) => s.required);
    const recorded = apply(t, ...required.map((s) => ({ type: 'record_step', stepId: s.id, result: 'pass' }) as TaskAction));
    expect(canComplete(recorded)).toBe(true);
    const done = apply(recorded, { type: 'submit' });
    expect(done.status).toBe('completed');
  });

  it('review-required task goes to review, then approve', () => {
    const t = apply(toAsset(tsk('TSK-202')), { type: 'confirm_asset', scannedId: 'CRAH-2' }, { type: 'start' });
    const rec = apply(t, ...t.checklist.filter((s) => s.required).map((s) => ({ type: 'record_step', stepId: s.id, result: 'pass', evidenceId: 'EVD-1' }) as TaskAction));
    const sub = apply(rec, { type: 'submit' });
    expect(sub.status).toBe('submitted_for_review');
    expect(apply(sub, { type: 'approve' }).status).toBe('completed');
    expect(apply(sub, { type: 'request_changes', reason: 'photo blurry' }).status).toBe('in_progress');
  });

  it('A10: stale version fails and input is never mutated', () => {
    const t = tsk('TSK-201');
    const snapshot = JSON.stringify(t);
    const ok = transition(t, { type: 'assign', ownerId: 'emp-marcus' }, ctx(t));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.task.version).toBe(t.version + 1);
      expect(ok.event.kind).toBe('task');
      expect(ok.event.links.taskId).toBe('TSK-201');
    }
    expect(JSON.stringify(t)).toBe(snapshot);
    const stale = transition(t, { type: 'accept' }, { actor: 'x', t: 6, expectedVersion: t.version - 1 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error).toBe('stale_version');
  });

  it('A16: reopen preserves the checklist', () => {
    const t = apply(toAsset(tsk('TSK-201')), { type: 'confirm_asset', scannedId: 'A-11' }, { type: 'start' });
    const done = apply(t, ...t.checklist.filter((s) => s.required).map((s) => ({ type: 'record_step', stepId: s.id, result: 'pass', note: 'ok' }) as TaskAction), { type: 'submit' });
    const re = apply(done, { type: 'reopen', reason: 'new alarm' });
    expect(re.status).toBe('reopened');
    expect(re.checklist).toEqual(done.checklist);
    expect(re.ownerId).toBe('emp-marcus');
  });

  it('illegal transitions and block/unblock', () => {
    const t = tsk('TSK-201');
    const r = transition(t, { type: 'arrive' }, ctx(t));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('illegal_transition');
    const enRoute = apply(t, { type: 'assign', ownerId: 'emp-marcus' }, { type: 'accept' }, { type: 'depart' });
    const blocked = apply(enRoute, { type: 'block', reason: 'door closed' });
    expect(blocked.status).toBe('blocked');
    expect(apply(blocked, { type: 'unblock' }).status).toBe('en_route');
  });
});

describe('suggestAssignees (A09)', () => {
  it('filters by skill, zone access and availability', () => {
    const s = suggestAssignees(tsk('TSK-202'), employees, facility, 5);
    expect(s).toHaveLength(employees.length);
    const eligible = s.filter((x) => x.eligible).map((x) => x.employeeId);
    expect(eligible).toEqual(['emp-marcus']);
    expect(s[0].employeeId).toBe('emp-marcus');
    expect(s[0].route?.ok).toBe(true);
    const jordan = s.find((x) => x.employeeId === 'emp-jordan')!;
    expect(jordan.reasons.join(' ')).toMatch(/Busy/);
    expect(jordan.reasons.join(' ')).toMatch(/Missing skill: vibration/);
  });

  it('zone access excludes, stale check-ins are flagged, ranking is by ETA', () => {
    const ups: ReturnType<typeof tsk> = { ...tsk('TSK-201'), id: 'TSK-X', assetId: 'UPS-B', requiredSkills: ['electrical'] };
    const s = suggestAssignees(ups, employees, facility, 5);
    const priya = s.find((x) => x.employeeId === 'emp-priya')!;
    expect(priya.eligible).toBe(false);
    expect(priya.reasons.join(' ')).toMatch(/zone Z-UPS/);
    expect(s.filter((x) => x.eligible).map((x) => x.employeeId).sort()).toEqual(['emp-amara', 'emp-sofia']);
    for (let i = 1; i < s.length; i++) if (s[i].eligible) expect(s[i - 1].score).toBeGreaterThanOrEqual(s[i].score);

    const cooling = suggestAssignees(tsk('TSK-201'), employees, facility, 5);
    const jordan = cooling.find((x) => x.employeeId === 'emp-jordan')!;
    expect(jordan.reasons.join(' ')).toMatch(/Location stale/);
  });
});
