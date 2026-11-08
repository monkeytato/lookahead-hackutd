import { useMemo, useState } from 'react';
import { facility } from '../domain/fixture';
import { findRoute, rankIncidents } from '../domain/engine';
import type { Severity, Waypoint } from '../domain/types';
import { Twin, type TwinLayers } from '../twin/Twin';
import { useOps, wallClock, type Selection } from '../state/store';
import { assetById, clocksForIncident, honestVisual, visibleClocks, waypointById } from '../state/selectors';
import { Detail } from './Detail';
import { impactLine, leakVisible } from '../app/forecast';
import { usePrediction } from '../app/usePrediction';

const MAX_CARDS = 3;

/**
 * The workspace: what to fix first (left), the hall in 3D (center), the selected problem (right,
 * only when something is selected), and one forecast line at the bottom.
 */
export function Facility() {
  // run = the world (what is happening); forecast = predictions from what is observed (audit C1)
  const { state, run, forecast, scenario, visibleIncidents } = useOps();
  const t = state.t;
  const H = scenario.horizonMin;
  // a selection belongs to the scenario it was made in; a new scenario (or a vanished incident) closes the panel
  const [picked, setPicked] = useState<{ sel: Selection; scenarioId: string }>({ sel: null, scenarioId: state.scenarioId });
  const setSel = (s: Selection) => setPicked({ sel: s, scenarioId: state.scenarioId });
  const [layers, setLayers] = useState<TwinLayers>({ heat: false, water: true, deps: true, people: false });
  const [viewOpen, setViewOpen] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [mobilePane, setMobilePane] = useState<'queue' | 'twin'>('twin');

  const clocks = useMemo(() => visibleClocks(forecast.clocks, scenario, t), [forecast, scenario, t]);
  const ranked = useMemo(
    () => rankIncidents(visibleIncidents.filter((i) => i.status !== 'resolved'), { facility, clocks: Object.fromEntries(clocks.map((c) => [c.assetId, c])), now: t, tasks: state.tasks, employees: state.employees }),
    [visibleIncidents, clocks, t, state.tasks, state.employees],
  );

  const raw = picked.scenarioId === state.scenarioId ? picked.sel : null;
  const sel: Selection = raw?.kind === 'incident' && !visibleIncidents.some((i) => i.id === raw.id) ? null : raw;

  // the twin draws the prediction ghost itself (run at t + lookahead); it gets the present state
  const visual = useMemo(() => honestVisual(run, scenario, t, t, forecast), [run, forecast, scenario, t]);
  const leakKnown = leakVisible(scenario, t);

  const highlightPath = useMemo(() => {
    if (sel?.kind === 'incident') {
      const inc = visibleIncidents.find((i) => i.id === sel.id);
      if (inc) return clocksForIncident(inc, clocks).sort((a, b) => b.path.length - a.path.length)[0]?.path;
    }
    if (sel?.kind === 'asset') return forecast.clocks[sel.id]?.path;
    return undefined;
  }, [sel, visibleIncidents, clocks, forecast]);

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

  const cards = ranked.slice(0, MAX_CARDS).map((p) => {
    const inc = visibleIncidents.find((x) => x.id === p.incidentId)!;
    const impact = impactLine(clocksForIncident(inc, clocks), facility, t, H);
    // the time line is colored by how soon the loss is; the stripe also reflects the incident's own severity
    const timeSev: Severity = impact.lost || (impact.minutes != null && impact.minutes <= 10) ? 'critical' : impact.minutes != null && impact.minutes <= 30 ? 'warning' : 'advisory';
    const sev: Severity = timeSev === 'critical' || timeSev === 'warning' ? timeSev : inc.severity;
    return { inc, impact, sev, timeSev };
  });

  return (
    <div className={`ops ${sel ? 'has-detail' : ''} ops-show-${mobilePane}`}>
      <div className="mobile-tabs" role="tablist">
        <button role="tab" aria-selected={mobilePane === 'queue'} onClick={() => setMobilePane('queue')}>Fix first ({ranked.length})</button>
        <button role="tab" aria-selected={mobilePane === 'twin'} onClick={() => setMobilePane('twin')}>Facility</button>
      </div>

      <aside className="queue" aria-label="What to fix first">
        <h2 className="queue-h">What to fix first</h2>
        <ol className="cards">
          {cards.map(({ inc, impact, sev, timeSev }) => {
            const active = sel?.kind === 'incident' && sel.id === inc.id;
            return (
              <li key={inc.id} className={`card sev-stripe-${sev} ${active ? 'is-active' : ''}`}>
                <button className="card-main" onClick={() => setSel({ kind: 'incident', id: inc.id })}>
                  <span className="card-title">{inc.title}</span>
                  <span className={`card-time ${timeSev === 'critical' ? 'is-critical' : timeSev === 'warning' ? 'is-warning' : 'is-advisory'}`}>{impact.text}</span>
                </button>
                <button className="card-fix" onClick={() => setSel({ kind: 'incident', id: inc.id })}>Fix</button>
              </li>
            );
          })}
          {cards.length === 0 && <li className="cards-empty">All clear. Press <b>Play</b> or <b>Random disaster</b> to start.</li>}
        </ol>
        {ranked.length > MAX_CARDS && <p className="cards-more">+{ranked.length - MAX_CARDS} more lower-priority</p>}
      </aside>

      <section className="stage" aria-label="3D facility">
        <Twin
          facility={facility}
          visual={visual}
          water={leakKnown && layers.water ? run.water : undefined}
          t={t}
          now={t}
          run={forecast}
          selectedId={selectedAssetId ?? null}
          onSelect={(id) => setSel(id ? { kind: 'asset', id } : null)}
          employees={state.employees}
          route={route}
          highlightPath={highlightPath}
          layers={layers}
          resetViewKey={resetKey}
        />
        <div className="view-menu">
          <button className="view-btn" aria-expanded={viewOpen} onClick={() => setViewOpen((o) => !o)}>View</button>
          {viewOpen && (
            <div className="view-pop">
              {(Object.keys(layers) as (keyof TwinLayers)[]).map((k) => (
                <label key={k}>
                  <input type="checkbox" checked={layers[k]} onChange={() => setLayers({ ...layers, [k]: !layers[k] })} />
                  {k === 'heat' ? 'Heat slice (indicative)' : k === 'water' ? 'Water (approximation)' : k === 'deps' ? 'Dependency path' : 'People'}
                </label>
              ))}
              <button onClick={() => { setSel(null); setResetKey((x) => x + 1); }}>Reset camera</button>
            </div>
          )}
        </div>
      </section>

      {sel && (
        <aside className="detail" aria-label="Selected" key={`${sel.kind}:${sel.id}`}>
          <Detail sel={sel} setSel={setSel} clocks={clocks} ranked={ranked} />
        </aside>
      )}

      <ForecastLine />
    </div>
  );
}

/** "If nothing changes: first rack lost at 02:44 · 48 racks by 03:10" — and the effect of your fixes. */
function ForecastLine() {
  const p = usePrediction();
  const end = wallClock(p.horizon);
  const line = (f: typeof p.now) => f.firstRack
    ? `first rack lost at ${wallClock(f.firstRack.at)} · ${f.racksLost} rack${f.racksLost === 1 ? '' : 's'} by ${end}`
    : `no rack loss by ${end}`;
  const base = p.without ?? p.now;
  const saved = p.without ? p.without.racksLost - p.now.racksLost : 0;
  return (
    <footer className="forecast" aria-live="polite">
      <span className="forecast-k">If nothing changes</span>
      <span>{p.observed ? line(base) : 'no observed fault · watching'}</span>
      {p.without && (
        <>
          <span className="forecast-k forecast-sep">With your fixes</span>
          <span className={saved > 0 ? 'is-good' : ''}>{line(p.now)}{saved > 0 ? ` · ${saved} saved` : ''}</span>
        </>
      )}
      <span className="forecast-src">forecast from observed faults only · simulated</span>
    </footer>
  );
}
