import { facility } from '../domain/fixture';
import { makeEvent, relMin, useOps } from '../state/store';
import { checkinState, ROLE_LABEL, waypointById, zoneById } from '../state/selectors';
import { Btn, FreshTag } from '../components/primitives';

export function TeamView() {
  const { state, dispatch } = useOps();
  const t = state.t;
  return (
    <div className="page">
      <header className="page-h">
        <h1>Team</h1>
        <p className="muted">Locations come from manual or QR check-ins. A position older than 30 minutes is shown as stale, never as live.</p>
      </header>
      <table className="table">
        <thead><tr><th>Name</th><th>Role</th><th>Skills</th><th>Availability</th><th>Last check-in</th><th>Current work</th><th /></tr></thead>
        <tbody>
          {state.employees.map((e) => {
            const work = state.tasks.filter((x) => x.ownerId === e.id && !['completed', 'cancelled'].includes(x.status));
            const ck = checkinState(e, t);
            return (
              <tr key={e.id}>
                <td><span className="avatar mono">{e.initials}</span> {e.name}<div className="muted small">{e.team} · {e.shift}</div></td>
                <td>{ROLE_LABEL[e.role]}</td>
                <td className="small">{e.skills.join(', ')}</td>
                <td>
                  <select value={e.availability} onChange={(ev) => dispatch({ type: 'set_availability', employeeId: e.id, availability: ev.target.value as typeof e.availability })}>
                    <option value="available">Available</option><option value="busy">Busy</option><option value="off_shift">Off shift</option>
                  </select>
                </td>
                <td className={ck === 'stale' ? 'is-stale-cell' : ''}>
                  {e.location ? <>{waypointById.get(e.location.waypointId)?.label}<div className="muted small mono">{relMin(t, e.location.t)} · {e.location.source}</div></> : <span className="muted">Unknown</span>}
                  {ck === 'stale' && <FreshTag f="stale" age={t - (e.location?.t ?? 0)} />}
                </td>
                <td className="small">{work.map((w) => <a key={w.id} href={`#/app/field/${w.id}`} className="mono">{w.id} </a>)}{work.length === 0 && <span className="muted">—</span>}</td>
                <td>
                  <label className="sr-only" htmlFor={`ck-${e.id}`}>Check in location</label>
                  <select id={`ck-${e.id}`} defaultValue="" onChange={(ev) => {
                    const w = waypointById.get(ev.target.value); if (!w) return;
                    dispatch({ type: 'checkin', employeeId: e.id, location: { zoneId: w.zoneId, waypointId: w.id, t, source: 'manual' }, event: makeEvent(t, { kind: 'checkin', actor: e.name, summary: `${e.name} checked in at ${w.label}`, links: { employeeId: e.id }, source: 'operator' }) });
                    ev.target.value = '';
                  }}>
                    <option value="" disabled>Check in at…</option>
                    {facility.waypoints.filter((w) => !/^[NS]-\d/.test(w.id)).map((w) => <option key={w.id} value={w.id}>{w.label} ({zoneById.get(w.zoneId)?.name})</option>)}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2 className="page-h2">Walkway closures</h2>
      <p className="muted">Closing a segment changes every route that crossed it. There is no straight-line fallback.</p>
      <ul className="closures">
        {facility.walkEdges.filter((w) => w.note).map((w) => (
          <li key={w.id}>
            <span>{w.note} <span className="mono muted">{w.a}–{w.b}</span></span>
            <Btn kind={state.closedWalkEdgeIds.includes(w.id) ? 'danger' : 'ghost'} onClick={() => dispatch({ type: 'toggle_walk_edge', edgeId: w.id, event: makeEvent(t, { kind: 'note', actor: 'Priya Raman', summary: `${state.closedWalkEdgeIds.includes(w.id) ? 'Reopened' : 'Closed'} walkway: ${w.note}`, links: {}, source: 'operator' }) })}>
              {state.closedWalkEdgeIds.includes(w.id) ? 'Closed — reopen' : 'Close'}
            </Btn>
          </li>
        ))}
      </ul>
    </div>
  );
}
