import { useEffect, useMemo, useState } from 'react';
import { facility } from '../domain/fixture';
import { findRoute, rankIncidents } from '../domain/engine';
import type { Waypoint } from '../domain/types';
import { Twin, type TwinLayers } from '../twin/Twin';
import { useOps, wallClock, type Selection } from '../state/store';
import { assetById, clocksForIncident, detectedAt, groupClocks, honestVisual, visibleClocks, waypointById } from '../state/selectors';
import { Countdown, EvidenceTag, SevMark } from '../components/primitives';
import { Inspector } from './Inspector';
import { Timeline } from './Timeline';

export function Operations() {
  const { state, run, scenario, visibleIncidents } = useOps();
  const t = state.t;
  const [sel, setSelRaw] = useState<Selection>(null);
  // the camera only flies when a person picks something — the default selection keeps the overview
  const [userPicked, setUserPicked] = useState(false);
  const setSel = (s: Selection) => { setUserPicked(true); setSelRaw(s); };
  const [preview, setPreview] = useState(0);
  const [layers, setLayers] = useState<TwinLayers>({ heat: false, water: true, deps: true, people: true });
  const [resetKey, setResetKey] = useState(0);
  const [mobilePane, setMobilePane] = useState<'queue' | 'twin' | 'inspect'>('twin');

  const clocks = useMemo(() => visibleClocks(run.clocks, scenario, t), [run, scenario, t]);
  const groups = useMemo(() => groupClocks(clocks, t), [clocks, t]);
  const ranked = useMemo(
    () => rankIncidents(visibleIncidents.filter((i) => i.status !== 'resolved'), { facility, clocks: Object.fromEntries(clocks.map((c) => [c.assetId, c])), now: t, tasks: state.tasks, employees: state.employees }),
    [visibleIncidents, clocks, t, state.tasks, state.employees],
  );

  // default selection: top-ranked incident
  useEffect(() => {
    if (!sel && ranked[0]) setSelRaw({ kind: 'incident', id: ranked[0].incidentId });
  }, [ranked, sel]);

  const viewT = Math.min(scenario.horizonMin, t + preview);
  const visual = useMemo(() => honestVisual(run, scenario, t, viewT), [run, scenario, t, viewT]);
  // the water layer appears once the leak is observable (make-up flow mismatch), not before
  const leakKnown = !!scenario.leak && detectedAt(scenario, 'PIPE-L2') <= t;

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

  const budget = visibleIncidents.filter((i) => i.openedAt > t - 60).length;
  const staleCount = Object.values(run.visualAt(t)).filter((v) => v.freshness === 'stale').length;

  return (
    <div className={`ops ops-show-${mobilePane}`}>
      {/* Level 1 — what is wrong, how long do I have */}
      <section className="strip" aria-label="Facility overview">
        <div className="strip-clocks">
          {groups.length === 0 && <div className="strip-quiet"><span className="mono">No running clocks.</span> Hall is within limits on every fresh reading.</div>}
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
        <div className="strip-meta">
          <div className="meta-row">
            <span className="meta-k">Incidents this hour</span>
            <span className="budget" aria-label={`${budget} of budget 6`}>
              {Array.from({ length: 6 }, (_, i) => <span key={i} className={i < budget ? 'on' : ''} />)}
            </span>
            <span className="mono meta-v">{budget}/6</span>
          </div>
          <div className="meta-row"><span className="meta-k">Stale readings</span><span className={`mono meta-v ${staleCount ? 'is-warn' : ''}`}>{staleCount}</span></div>
          <div className="meta-row"><span className="meta-k">Data</span><span className="meta-v">Simulated facility · fixture probe readings</span></div>
        </div>
      </section>

      <div className="mobile-tabs" role="tablist">
        {(['queue', 'twin', 'inspect'] as const).map((p) => (
          <button key={p} role="tab" aria-selected={mobilePane === p} onClick={() => setMobilePane(p)}>{p === 'queue' ? `Queue (${ranked.length})` : p === 'twin' ? 'Facility' : 'Details'}</button>
        ))}
      </div>

      {/* Response queue */}
      <aside className="queue" aria-label="Ranked response queue">
        <header className="pane-h"><h2>Response queue</h2><span className="pane-sub mono">policy P-demo · illustrative weights</span></header>
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
              <li key={inc.id}>
                <button className={`q-item ${active ? 'is-active' : ''}`} onClick={() => { setSel({ kind: 'incident', id: inc.id }); setMobilePane('inspect'); }}>
                  <span className="q-rank mono">{i + 1}</span>
                  <span className="q-body">
                    <span className="q-title"><SevMark sev={inc.severity} /> {inc.title}</span>
                    <span className="q-meta">
                      <EvidenceTag v={inc.evidence} />
                      {first && <span className="mono q-clock">{first.p50 == null ? '>60' : first.p50 <= t ? 'impact' : `T−${Math.round(first.p50 - t)}`} · {assetById.get(first.assetId)?.id}</span>}
                    </span>
                    <span className="q-why">{top ? `${top.label}: ${top.note}` : inc.summary}</span>
                    <span className="q-next">
                      <span className="q-k">Next</span>
                      {task ? `${task.title} — ${task.status.replace(/_/g, ' ')}${task.ownerId ? ` · ${state.employees.find((e) => e.id === task.ownerId)?.initials}` : ''}` : p.resolvingCheck ?? 'Create a task'}
                    </span>
                    <span className="q-owner">Owner {owner ? owner.name : <em>unassigned — {state.employees.find((e) => e.id === inc.shiftLeadId)?.name} (shift lead) holds it</em>}</span>
                  </span>
                  <span className="q-score mono" title="Priority total (illustrative weights)">{Math.round(p.total * 100)}</span>
                </button>
              </li>
            );
          })}
          {ranked.length === 0 && <li className="q-empty">Nothing needs attention. Press play to run the scenario.</li>}
        </ol>
      </aside>

      {/* Level 2 — the hall, 3D */}
      <section className="stage" aria-label="3D facility twin">
        <Twin
          facility={facility}
          visual={visual}
          water={leakKnown ? run.water : undefined}
          t={viewT}
          now={t}
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
          <span className="lg-stale">Stale</span>
          {layers.water && <span className="lg-water">Water · approximation</span>}
          {layers.heat && <span className="lg-heat">Heat · indicative, not CFD</span>}
        </div>
        <div className={`preview ${preview > 0 ? 'is-on' : ''}`}>
          <label htmlFor="preview">Look ahead</label>
          <input id="preview" type="range" min={0} max={30} step={1} value={preview} onChange={(e) => setPreview(+e.target.value)} />
          <span className="mono">{preview === 0 ? 'now' : `+${preview} min · ${wallClock(viewT)}`}</span>
          {preview > 0 && <span className="preview-note">Scenario forecast — engine output, not observed</span>}
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
