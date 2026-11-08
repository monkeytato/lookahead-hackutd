import { useMemo } from 'react';
import { facility, seedReadings } from '../domain/fixture';
import { simulateScenario } from '../domain/engine';
import { makeEvent, useOps } from '../state/store';
import { Btn } from '../components/primitives';

/** Cited candidate dependencies → human review → graph revision → replay the same prediction. */
export function DependenciesView() {
  const { state, dispatch, run, activeExtraEdges, scenario } = useOps();
  const candidates = facility.edges.filter((e) => !e.confirmed);

  // frozen replay: same scenario, same seed, without the confirmed candidates
  const baseline = useMemo(() => simulateScenario({ facility, scenario, seedReadings: seedReadings() }), [scenario]);
  const diff = useMemo(() => {
    const ids = new Set([...Object.keys(baseline.clocks), ...Object.keys(run.clocks)]);
    return [...ids].map((id) => ({ id, before: baseline.clocks[id]?.p50 ?? null, after: run.clocks[id]?.p50 ?? null }))
      .filter((d) => d.before !== d.after).sort((a, b) => (a.after ?? 1e9) - (b.after ?? 1e9)).slice(0, 12);
  }, [baseline, run]);

  const counts = facility.edges.reduce<Record<string, number>>((m, e) => { if (e.confirmed) m[e.kind] = (m[e.kind] ?? 0) + 1; return m; }, {});

  return (
    <div className="page">
      <header className="page-h">
        <h1>Dependencies</h1>
        <p className="muted">Graph revision <span className="mono">r{state.graphRevision}</span> · {counts.powers ?? 0} power, {counts.cools ?? 0} cooling, {counts.shares_space ?? 0} shared-fate confirmed edges. Unconfirmed and rejected edges never affect the engine.</p>
      </header>

      <h2 className="page-h2">Candidates for review</h2>
      {candidates.map((e) => {
        const status = state.confirmedEdgeIds.includes(e.id) ? 'confirmed' : state.rejectedEdgeIds.includes(e.id) ? 'rejected' : 'pending';
        return (
          <article key={e.id} className="cand">
            <div className="cand-h"><span className="mono">{e.from} → {e.to}</span> <span className="tag">{e.kind.replace('_', ' ')}</span> <span className={`tag tag-${status}`}>{status}</span></div>
            <blockquote>{e.basis}</blockquote>
            <p className="muted small">Proposed delay {e.delay.min}–{e.delay.max} min (mode {e.delay.mode}). Documentary confirmation, not a physical measurement.</p>
            <div className="cand-actions">
              <Btn kind="primary" disabled={status === 'confirmed'} onClick={() => dispatch({ type: 'review_edge', edgeId: e.id, decision: 'confirm', event: makeEvent(state.t, { kind: 'dependency', actor: 'Amara Singh', summary: `Confirmed ${e.from} → ${e.to} (${e.kind}); graph r${state.graphRevision + 1}`, links: { assetId: e.to }, source: 'operator' }) })}>Confirm</Btn>
              <Btn disabled={status === 'rejected'} onClick={() => dispatch({ type: 'review_edge', edgeId: e.id, decision: 'reject', event: makeEvent(state.t, { kind: 'dependency', actor: 'Amara Singh', summary: `Rejected ${e.from} → ${e.to}`, links: { assetId: e.to }, source: 'operator' }) })}>Reject</Btn>
            </div>
          </article>
        );
      })}

      <h2 className="page-h2">Derived by the water layer</h2>
      <table className="table">
        <thead><tr><th>Edge</th><th>Arrival</th><th>Basis</th></tr></thead>
        <tbody>
          {run.derivedEdges.map((e) => <tr key={e.id}><td className="mono">{e.from} → {e.to}</td><td className="mono">T+{Math.round(run.waterArrival[e.to] ?? 0)}</td><td className="small">{e.basis}</td></tr>)}
          {run.derivedEdges.length === 0 && <tr><td colSpan={3} className="muted">No water in this scenario.</td></tr>}
        </tbody>
      </table>

      <h2 className="page-h2">Replay: same inputs, before vs after review</h2>
      <p className="muted small">{activeExtraEdges.length ? `${activeExtraEdges.length} confirmed candidate edge(s) applied.` : 'No candidates confirmed — before and after are identical.'} Seeded Monte Carlo, identical actions and horizon.</p>
      <table className="table">
        <thead><tr><th>Asset</th><th>p50 before</th><th>p50 after</th></tr></thead>
        <tbody>
          {diff.map((d) => <tr key={d.id}><td className="mono">{d.id}</td><td className="mono">{d.before == null ? '—' : `T+${Math.round(d.before)}`}</td><td className="mono">{d.after == null ? '—' : `T+${Math.round(d.after)}`}</td></tr>)}
          {diff.length === 0 && <tr><td colSpan={3} className="muted">No clock changed.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
