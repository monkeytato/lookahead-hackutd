/**
 * Tasks — big rows, owner above the job, and an inline checklist that can be ticked off and
 * completed in place. Uses the same task records (and event log) as the rest of the app.
 */
import { useState } from 'react';
import { makeEvent, useOps } from '../state/store';
import { assetById } from '../state/selectors';
import type { Task } from '../domain/types';
import { plainAsset, plainText } from './plain';

const OPEN = ['unassigned', 'reopened', 'assigned', 'accepted', 'en_route', 'at_asset', 'in_progress', 'blocked', 'submitted_for_review'];

export function TasksView() {
  const { state, dispatch } = useOps();
  const [openId, setOpenId] = useState<string | null>(null);
  const tasks = [...state.tasks].sort((a, b) => Number(OPEN.includes(b.status)) - Number(OPEN.includes(a.status)));

  const toggle = (task: Task, stepId: string) => {
    const step = task.checklist.find((c) => c.id === stepId);
    if (!step) return;
    const done = !step.result;
    dispatch({
      type: 'upsert_task',
      task: {
        ...task,
        checklist: task.checklist.map((c) => (c.id === stepId ? { ...c, result: done ? ('pass' as const) : undefined } : c)),
        version: task.version + 1,
      },
      event: makeEvent(state.t, {
        kind: 'task', actor: 'Priya Raman',
        summary: `${done ? 'Checked' : 'Cleared'}: ${plainText(step.text)} (${task.id})`,
        links: { taskId: task.id, assetId: task.assetId }, source: 'operator',
      }),
    });
  };

  const assign = (task: Task, employeeId: string) => {
    const ownerId = employeeId || undefined;
    const owner = state.employees.find((e) => e.id === employeeId);
    const status: Task['status'] = ownerId
      ? task.status === 'unassigned' || task.status === 'reopened' ? 'assigned' : task.status
      : 'unassigned';
    dispatch({
      type: 'upsert_task',
      task: { ...task, ownerId, status, version: task.version + 1 },
      event: makeEvent(state.t, {
        kind: 'task', actor: 'Priya Raman',
        summary: owner ? `Assigned to ${owner.name}: ${plainText(task.title)} (${task.id})` : `Unassigned: ${plainText(task.title)} (${task.id})`,
        links: { taskId: task.id, assetId: task.assetId, employeeId: ownerId }, source: 'operator',
      }),
    });
  };

  const complete = (task: Task) => {
    dispatch({
      type: 'upsert_task',
      task: { ...task, status: 'completed', version: task.version + 1 },
      event: makeEvent(state.t, {
        kind: 'task', actor: 'Priya Raman',
        summary: `Task completed: ${plainText(task.title)} (${task.id})`,
        links: { taskId: task.id, assetId: task.assetId, incidentId: task.incidentId }, source: 'operator',
      }),
    });
  };

  return (
    <div className="page tasks-page">
      <header className="page-h"><h1>Tasks</h1></header>

      <ul className="task-list">
        {tasks.map((x) => {
          const owner = state.employees.find((e) => e.id === x.ownerId);
          const asset = assetById.get(x.assetId);
          const required = x.checklist.filter((c) => c.required);
          const done = required.filter((c) => c.result).length;
          const completeReady = required.length > 0 && done === required.length;
          const open = openId === x.id;
          const finished = x.status === 'completed' || x.status === 'cancelled';
          return (
            <li key={x.id} className={`task-row ${finished ? 'is-done' : ''}`}>
              <button className="task-row-main" onClick={() => setOpenId(open ? null : x.id)} aria-expanded={open}>
                <span className="task-owner">
                  <span className="task-avatar mono">{(owner?.initials ?? '—').slice(0, 2)}</span>
                  {owner?.name ?? 'Unassigned'}
                </span>
                <span className="task-title">{plainText(x.title)}</span>
                <span className="task-meta">
                  {plainAsset(asset?.id ?? x.assetId)}
                  <span className={`word word-${finished ? 'normal' : x.status === 'blocked' ? 'critical' : 'watch'}`}>{finished ? 'Done' : x.status.replace(/_/g, ' ')}</span>
                  {required.length > 0 && <span className="task-progress mono">{done}/{required.length}</span>}
                </span>
              </button>

              {open && (
                <div className="task-panel">
                  <ul className="task-checks">
                    {x.checklist.map((c) => (
                      <li key={c.id}>
                        <label>
                          <input type="checkbox" checked={!!c.result} onChange={() => toggle(x, c.id)} disabled={finished} />
                          <span className={c.result ? 'is-checked' : ''}>{plainText(c.text)}</span>
                          {!c.required && <span className="mon-sub">optional</span>}
                        </label>
                      </li>
                    ))}
                  </ul>
                  <div className="task-actions">
                    <label className="task-assign">
                      <span className="mon-sub">Owner</span>
                      <select value={x.ownerId ?? ''} onChange={(e) => assign(x, e.target.value)} disabled={finished}>
                        <option value="">Unassigned</option>
                        {state.employees.map((e) => (
                          <option key={e.id} value={e.id}>{e.name} · {e.role.replace(/_/g, ' ')}</option>
                        ))}
                      </select>
                    </label>
                    <button className="btn btn-primary" disabled={finished || !completeReady} onClick={() => complete(x)}>
                      {finished ? 'Completed' : completeReady ? 'Mark complete' : `Tick ${required.length - done} more`}
                    </button>
                    {x.blocker && <span className="small is-warn">Blocked: {plainText(x.blocker)}</span>}
                  </div>
                </div>
              )}
            </li>
          );
        })}
        {tasks.length === 0 && <li className="mon-empty">No tasks.</li>}
      </ul>
    </div>
  );
}
