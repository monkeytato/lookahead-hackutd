import { useMemo, useState } from 'react';
import type { EventKind, OpEvent } from '../domain/types';
import { useOps, wallClock } from '../state/store';
import { Src } from '../components/primitives';

/** Append-only operational history. Corrections supersede; nothing is erased. */
export function LogView() {
  const { state, run } = useOps();
  const [kind, setKind] = useState<EventKind | 'all'>('all');
  const [q, setQ] = useState('');
  const all = useMemo<OpEvent[]>(() => {
    const derived: OpEvent[] = run.stepsUntil(state.t).map((s, i) => ({ id: `SIM-${i + 1}`, t: s.t, ingestedAt: '—', kind: s.kind === 'alert' ? 'alert' : 'telemetry', actor: 'simulator', summary: s.summary, links: { assetId: s.assetId }, source: 'simulated' }));
    return [...derived, ...state.events].filter((e) => e.t <= state.t + 0.01).sort((a, b) => b.t - a.t);
  }, [run, state.events, state.t]);
  const rows = all.filter((e) => (kind === 'all' || e.kind === kind) && (!q || JSON.stringify(e).toLowerCase().includes(q.toLowerCase())));
  const kinds = [...new Set(all.map((e) => e.kind))];
  return (
    <div className="page">
      <header className="page-h">
        <h1>Operational log</h1>
        <div className="page-h-actions">
          <input className="search" placeholder="Filter by asset, incident, task, person…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter log" />
          <select value={kind} onChange={(e) => setKind(e.target.value as EventKind | 'all')} aria-label="Event kind">
            <option value="all">All kinds</option>{kinds.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
      </header>
      <table className="table log">
        <thead><tr><th>Time</th><th>Kind</th><th>Event</th><th>Actor</th><th>Links</th><th>Source</th></tr></thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td className="mono">{wallClock(e.t)}</td>
              <td><span className="tag">{e.kind}</span></td>
              <td>{e.summary}</td>
              <td className="small">{e.actor}</td>
              <td className="mono small">{Object.values(e.links).filter(Boolean).join(' ')}</td>
              <td><Src s={e.source} /></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={6} className="muted">No events yet. Press play on Operations.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
