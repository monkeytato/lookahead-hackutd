import { useOps } from '../state/store';
import { assetById } from '../state/selectors';
import type { TaskStatus } from '../domain/types';

const COLS: { key: string; label: string; statuses: TaskStatus[] }[] = [
  { key: 'todo', label: 'Unassigned', statuses: ['unassigned', 'reopened'] },
  { key: 'assigned', label: 'Assigned', statuses: ['assigned', 'accepted'] },
  { key: 'field', label: 'In the field', statuses: ['en_route', 'at_asset', 'in_progress'] },
  { key: 'blocked', label: 'Blocked', statuses: ['blocked'] },
  { key: 'review', label: 'Review', statuses: ['submitted_for_review'] },
  { key: 'done', label: 'Completed', statuses: ['completed', 'cancelled'] },
];

export function TasksView() {
  const { state } = useOps();
  return (
    <div className="page">
      <header className="page-h"><h1>Tasks</h1><p className="muted">What needs attention, who owns it, where it is, what blocks it and what evidence is missing.</p></header>
      <div className="board">
        {COLS.map((c) => {
          const items = state.tasks.filter((x) => c.statuses.includes(x.status));
          return (
            <section key={c.key} className="board-col" aria-label={c.label}>
              <h2>{c.label} <span className="mono muted">{items.length}</span></h2>
              {items.map((x) => {
                const owner = state.employees.find((e) => e.id === x.ownerId);
                const a = assetById.get(x.assetId);
                const missing = x.checklist.filter((s) => s.required && !s.result).length;
                return (
                  <a key={x.id} className="card" href={x.ownerId ? `#/app/field/${x.id}` : '#/app'}>
                    <div className="mono card-k">{x.id} · {x.type}</div>
                    <div className="card-t">{x.title}</div>
                    <div className="card-m"><span className="mono">{a?.id}</span> · {owner?.name ?? 'unowned — shift lead holds it'}</div>
                    {x.blocker && <div className="is-warn small">Blocked: {x.blocker}</div>}
                    <div className="small muted">{missing ? `${missing} required step${missing > 1 ? 's' : ''} without evidence` : 'Checklist evidence complete'}{x.reviewRequired ? ' · review' : ''}</div>
                  </a>
                );
              })}
              {items.length === 0 && <p className="muted small">None</p>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
