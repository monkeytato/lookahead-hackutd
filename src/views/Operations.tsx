import { useEffect, useMemo, useState } from 'react';
import { facility } from '../domain/fixture';
import { findRoute, rankIncidents } from '../domain/engine';
import type { Waypoint } from '../domain/types';
import { Twin, type TwinLayers } from '../twin/Twin';
import { useOps, type Selection } from '../state/store';
import { assetById, clocksForIncident, groupClocks, honestVisual, visibleClocks, waypointById } from '../state/selectors';
import { Countdown, EvidenceTag, SevMark } from '../components/primitives';
import { Inspector } from './Inspector';
import { Timeline } from './Timeline';
import { PredictionPanel } from './PredictionPanel';
import { leakVisible } from '../app/forecast';

export function Operations() {
  const { state, run, scenario, visibleIncidents } = useOps();
  const t = state.t;
  const [sel, setSelRaw] = useState<Selection>(null);
  // the camera only flies when a person picks something — the default selection keeps the overview
  const [userPicked, setUserPicked] = useState(false);
  const setSel = (s: Selection) => { setUserPicked(true); setSelRaw(s); };
  const [layers, setLayers] = useState<TwinLayers>({ heat: false, water: true, deps: true, people: true });
  const [resetKey, setResetKey] = useState(0);
  const [mobilePane, setMobilePane] = useState<'queue' | 'twin' | 'inspect'>('twin');

  const clocks = useMemo(() => visibleClocks(run.clocks, scenario, t), [run, scenario, t]);
  const groups = useMemo(() => groupClocks(clocks, t), [clocks, t]);
  const lostNow = useMemo(() => clocks.filter((c) => c.p50 != null && c.p50 <= t).length, [clocks, t]);
  const ranked = useMemo(
    () => rankIncidents(visibleIncidents.filter((i) => i.status !== 'resolved'), { facility, clocks: Object.fromEntries(clocks.map((c) => [c.assetId, c])), now: t, tasks: state.tasks, employees: state.employees }),
    [visibleIncidents, clocks, t, state.tasks, state.employees],
  );

  // default selection: top-ranked incident
  // (also when the selection points at an incident a new scenario no longer has)
  const selGone = sel?.kind === 'incident' && !visibleIncidents.some((i) => i.id === sel.id);
  useEffect(() => {
    if ((!sel || selGone) && ranked[0]) setSelRaw({ kind: 'incident', id: ranked[0].incidentId });
    else if (selGone) setSelRaw(null);
  }, [ranked, sel, selGone]);

  // the twin draws the prediction ghost itself (run at t + lookahead); it gets the present state
  const visual = useMemo(() => honestVisual(run, scenario, t, t), [run, scenario, t]);
  // the water layer appears once the leak is observable (make-up flow mismatch), not before
  const leakKnown = leakVisible(scenario, t);

  // highlight path: selected incident's earliest clock, or selected asset's own clock
  const highlightPath = useMemo(() => {
    if (sel?.kind === 'incident') {
      const inc = visibleIncidents.find((i) => i.id === sel.id);
      if (inc) return clocksForIncident(inc, clocks).sort((a, b) => b.path.length - a.path.length)[0]?.path;
    }
    if (sel?.kind === 'asset') return run.clocks[sel.id]?.path;
    return undefined;
  }, [sel, visibleIncidents, clocks, run]);

  // route for the selected task (from owner's last valid check-in to the asset's service point)
  const route = useMemo<Waypoint[] | undefined>(() => {
    const task = sel?.kind === 'task' ? state.tasks.find((x) => x.id === sel.id) : undefined;
    if (!task?.ownerId) return undefined;
    const emp = state.employees.find((e) => e.id === task.ownerId);
    const asset = assetById.get(task.assetId);
    if (!emp?.location || !asset) return undefined;
    const r = findRoute(facility, emp.location.waypointId, asset.accessWaypoint, { skills: emp.skills, closedEdgeIds: state.closedWalkEdgeIds });
    return r.ok ? r.path.map((id) => waypointById.get(id)!).filter(Boolean) : undefined;
  }, [sel, state.tasks, state.employees, state.closedWalkEdgeIds]);

  const selectedAssetId = sel?.kind === 'asset' ? sel.id
    : sel?.kind === 'incident' ? visibleIncidents.find((i) => i.id === sel.id)?.rootAssetId
    : sel?.kind === 'task' ? state.tasks.find((x) => x.id === sel.id)?.assetId : null;

  const staleCount = Object.values(run.visualAt(t)).filter((v) => v.freshness === 'stale').length;

  return (
    <div className={`ops ops-show-${mobilePane}`}>
      {/* Level 1 — what is wrong, how long do I have */}
      <section className="strip" aria-label="Facility overview">
        <div className="strip-clocks">
          {groups.length === 0 && (
            <div className="strip-quiet">
              <span className="mono">No running clocks.</span>
              {lostNow > 0 ? <> {lostNow} asset{lostNow === 1 ? ' is' : 's are'} already modeled as lost — see the forecast and the queue.</> : t === 0 ? <> Press <b>Play</b> or roll a <b>Random disaster</b>.</> : <> Hall is within limits on every fresh reading.</>}
            </div>
          )}
          {groups.slice(0, 4).map((g) => (
            <button key={g.key} className="clock-tile" onClick={() => setSel({ kind: 'asset', id: g.clock.assetId })} aria-label={`${g.label} clock`}>
              <div className="clock-tile-h">
                <SevMark sev={g.clock.p50 != null && g.clock.p50 - t <= 10 ? 'critical' : g.clock.p50 != null && g.clock.p50 - t <= 30 ? 'warning' : 'advisory'} />
                <span className="clock-label">{g.label}</span>
                {g.count > 1 && <span className="clock-count mono">×{g.count}</span>}
              </div>
              <Countdown clock={g.clock} now={t} horizon={scenario.horizonMin} />
              <div className="clock-detail">{g.detail}</div>
            </button>
          ))}
        </div>
        <PredictionPanel />
      </section>

      <div className="mobile-tabs" role="tablist">
        {(['queue', 'twin', 'inspect'] as const).map((p) => (
          <button key={p} role="tab" aria-selected={mobilePane === p} onClick={() => setMobilePane(p)}>{p === 'queue' ? `Queue (${ranked.length})` : p === 'twin' ? 'Facility' : 'Details'}</button>
        ))}
      </div>

      {/* Response queue */}
      <aside className="queue" aria-label="Ranked response queue">
        <header className="pane-h"><h2>What to fix first</h2><span className="pane-sub">ranked by impact and time</span></header>
        <ol className="q-list">
          {ranked.map((p, i) => {
            const inc = visibleIncidents.find((x) => x.id === p.incidentId)!;
            const incClocks = clocksForIncident(inc, clocks);
            const first = incClocks.find((c) => c.p50 == null || c.p50 > t) ?? incClocks[0];
            const owner = state.employees.find((e) => e.id === inc.ownerId);
            const task = state.tasks.find((x) => x.incidentId === inc.id && x.status !== 'completed' && x.status !== 'cancelled');
            const top = [...p.factors].sort((a, b) => b.score * b.weight - a.score * a.weight)[0];
            const active = sel?.kind === 'incident' && sel.id === inc.id;
            return (
              <li key={inc.id} className={`q-card ${active ? 'is-active' : ''}`}>
                <button className={`q-item ${active ? 'is-active' : ''}`} onClick={() => { setSel({ kind: 'incident', id: inc.id }); setMobilePane('inspect'); }}>
                  <span className="q-rank mono">{i + 1}</span>
                  <span className="q-body">
                    <span className="q-title"><SevMark sev={inc.severity} /> {inc.title}</span>
                    <span className="q-meta">
                      <EvidenceTag v={inc.evidence} />
                      {first && <span className="mono q-clock">{first.p50 == null ? 'no loss within the hour' : first.p50 <= t ? `${first.assetId} lost` : `${first.assetId} in ${Math.round(first.p50 - t)} min`}</span>}
                    </span>
                    <span className="q-next">
                      <span className="q-k">Next</span>
                      {task ? `${task.title} — ${task.status.replace(/_/g, ' ')}${task.ownerId ? ` · ${state.employees.find((e) => e.id === task.ownerId)?.initials}` : ''}` : p.resolvingCheck ?? 'Open it to order a fix or create a task'}
                    </span>
                    <span className="q-owner">{owner ? `Owner: ${owner.name}` : `Unassigned · ${state.employees.find((e) => e.id === inc.shiftLeadId)?.name ?? 'the shift lead'} holds it`}</span>
                  </span>
                  <span className="q-score mono" title="Priority score (illustrative weights)">{Math.round(p.total * 100)}</span>
                </button>
                <div className="q-foot">
                  <details className="q-why">
                    <summary>Why this rank</summary>
                    <ul>
                      {[...p.factors].sort((a, b) => b.score * b.weight - a.score * a.weight).slice(0, 3).map((f) => (
                        <li key={f.key}><span className="q-wbar"><span style={{ width: `${Math.round(f.score * 100)}%` }} /></span>{f.label}</li>
                      ))}
                    </ul>
                    {top && <p className="q-note">{top.note}</p>}
                  </details>
                  <button className="q-fix" onClick={() => { setSel({ kind: 'incident', id: inc.id }); setMobilePane('inspect'); }} title="Open the fix options for this incident">Fix…</button>
                </div>
              </li>
            );
          })}
          {ranked.length === 0 && <li className="q-empty">Nothing needs attention yet. Press <b>Play</b> or roll a <b>Random disaster</b> in the bar above.</li>}
        </ol>
      </aside>

      {/* Level 2 — the hall, 3D */}
      <section className="stage" aria-label="3D facility twin">
        <Twin
          facility={facility}
          visual={visual}
          water={leakKnown ? run.water : undefined}
          t={t}
          now={t}
          run={run}
          selectedId={userPicked ? selectedAssetId : null}
          onSelect={(id) => setSel(id ? { kind: 'asset', id } : null)}
          employees={state.employees}
          route={route}
          highlightPath={highlightPath}
          layers={layers}
          resetViewKey={resetKey}
        />
        <div className="stage-tools">
          {(Object.keys(layers) as (keyof TwinLayers)[]).map((k) => (
            <label key={k} className={`chip ${layers[k] ? 'is-on' : ''}`}>
              <input type="checkbox" checked={layers[k]} onChange={() => setLayers({ ...layers, [k]: !layers[k] })} />
              {k === 'heat' ? 'Heat slice' : k === 'water' ? 'Water' : k === 'deps' ? 'Dependencies' : 'People'}
            </label>
          ))}
          <button className="chip" onClick={() => { setUserPicked(false); setResetKey((k) => k + 1); }}>Reset view</button>
        </div>
        <div className="stage-legend">
          <span><SevMark sev="critical" /> P1</span><span><SevMark sev="warning" /> P2</span><span><SevMark sev="advisory" /> P3</span>
          <span className="lg-stale" title="Sensors whose last reading is older than expected">Stale{staleCount ? ` · ${staleCount}` : ''}</span>
          {layers.water && <span className="lg-water">Water · approximation</span>}
          {layers.heat && <span className="lg-heat">Heat · indicative, not CFD</span>}
        </div>
      </section>

      {/* Level 3/4 — inspector */}
      <aside className="inspector" aria-label="Inspector" key={sel ? `${sel.kind}:${sel.id}` : 'none'}>
        <Inspector sel={sel} setSel={setSel} clocks={clocks} ranked={ranked} />
      </aside>

      <Timeline />
    </div>
  );
}
