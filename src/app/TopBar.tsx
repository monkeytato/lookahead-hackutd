/**
 * One bar: status in plain words, Monitor / Facility, the clock, Play, Spawn disaster.
 * Prediction horizon, speed, ±5 min, real-incident replays and phone setup sit behind "⋯";
 * other pages behind "More". Every control goes through the stage (useControls).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { getScenario, listScenarios, randomScenarioId } from '../domain/scenarios';
import { useOps, wallClock } from '../state/store';
import { useGauges } from '../views/Monitor';
import { useControls } from './controls';
import { routeUrl } from './forecast';

const PAGES = [
  { id: 'rig', label: 'Rack node' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'team', label: 'Team' },
  { id: 'dependencies', label: 'Dependencies' },
  { id: 'log', label: 'Log' },
  { id: 'handoff', label: 'Shift handoff' },
];
const SPEEDS = [0.5, 1, 2, 4];
export const NORMAL_ID = 'scn-normal';
/** Normal operations exist once the telemetry work lands; until then "normal" = the scenario at T+0. */
export const hasNormal = () => getScenario(NORMAL_ID).id === NORMAL_ID;

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return { open, setOpen, ref };
}

/** `embedded`: sits under the main workspace header, so it drops its own brand and view tabs. */
export function TopBar({ section, embedded }: { section: string; embedded?: boolean }) {
  const { state, scenario } = useOps();
  const { gauges } = useGauges();
  const c = useControls();
  const t = state.t;
  const ended = t >= scenario.horizonMin;
  const normal = useMemo(hasNormal, []);
  const disaster = scenario.id !== NORMAL_ID && (scenario.faults.length > 0 || !!scenario.leak || !!scenario.hazards?.length);
  const real = useMemo(() => listScenarios().filter((s) => s.kind === 'real'), []);
  const { open: optsOpen, setOpen: setOptsOpen, ref: optsRef } = usePopover();
  const { open: moreOpen, setOpen: setMoreOpen, ref: moreRef } = usePopover();
  const remote = routeUrl('#/stage');
  const abnormal = gauges.filter((g) => g.severity !== 'normal').length;
  const worst = gauges.some((g) => g.severity === 'critical') ? 'critical' : abnormal ? 'warning' : 'ok';
  const statusText = abnormal ? `${abnormal} reading${abnormal === 1 ? '' : 's'} abnormal` : 'All readings normal';
  const linkText = c.link === 'bridge' ? 'Linked to phone and projector' : c.link === 'room' ? 'Linked to every open copy' : c.link === 'local' ? 'This browser only' : 'Not linked';
  const view = section === 'facility' ? 'facility' : section === 'gauges' ? 'monitor' : '';

  const spawn = () => c.send({ type: 'scenario', scenarioId: randomScenarioId(), autoplay: true });
  const backToNormal = () => c.send(normal ? { type: 'scenario', scenarioId: NORMAL_ID, autoplay: c.playing } : { type: 'reset' });

  return (
    <header className={`bar${embedded ? ' bar-embedded' : ''}`} role={embedded ? 'toolbar' : 'banner'} aria-label={embedded ? 'Simulation controls' : undefined}>
      {!embedded && <a className="bar-brand" href="#/">CenterGuard</a>}

      <div className={`bar-status is-${worst}`} title={disaster ? scenario.basis : 'DAL-1 · Hall A (simulated)'}>
        <span className="bar-dot" aria-hidden="true" />
        <span className="bar-status-main">{statusText}</span>
        <span className="bar-status-sub">{disaster ? scenario.headline ?? scenario.name : 'DAL-1 · Hall A · simulated'}</span>
      </div>

      {!embedded && <nav className="bar-tabs" aria-label="View">
        <a href="#/app/gauges" className={view === 'monitor' ? 'is-on' : ''} aria-current={view === 'monitor' ? 'page' : undefined}>Monitor</a>
        <a href="#/app/facility" className={view === 'facility' ? 'is-on' : ''} aria-current={view === 'facility' ? 'page' : undefined}>Facility</a>
      </nav>}

      <div className="bar-clock mono" aria-label="Time">
        <b>{wallClock(t)}</b>
      </div>

      <button className="bar-btn bar-play" onClick={() => c.send(ended ? { type: 'seek', t: 0 } : { type: c.playing ? 'pause' : 'play' })}>
        {c.playing ? 'Pause' : ended ? 'Restart' : 'Play'}
      </button>
      {disaster && (
        <button className="bar-btn bar-normal" onClick={backToNormal} title="End the disaster and return to normal operations">Back to normal</button>
      )}
      <button className="bar-btn bar-spawn" onClick={spawn} title="Start a random disaster somewhere in the hall">Spawn disaster</button>

      <span className={`bar-link link-${c.link ?? 'none'}`} title={linkText} aria-label={linkText} />

      <div className="bar-pop" ref={optsRef}>
        <button className="bar-icon" aria-expanded={optsOpen} aria-label="More controls" onClick={() => setOptsOpen((o) => !o)}>⋯</button>
        {optsOpen && (
          <div className="menu menu-wide" role="dialog" aria-label="More controls">
            <div className="menu-row">
              <span className="menu-k">Predict</span>
              {[10, 20, 30].map((m) => (
                <button key={m} className={(c.lookaheadMin || 20) === m ? 'is-on' : ''} disabled={!c.shared} onClick={() => c.send({ type: 'lookahead', min: m })}>+{m} min</button>
              ))}
            </div>
            <div className="menu-row">
              <span className="menu-k">Speed</span>
              {SPEEDS.map((s) => (
                <button key={s} className={c.speed === s ? 'is-on' : ''} disabled={!c.shared} onClick={() => c.send({ type: 'speed', speed: s })}>{s}×</button>
              ))}
            </div>
            <div className="menu-row">
              <span className="menu-k">Time</span>
              <button onClick={() => c.send({ type: 'jump', dt: -5 })}>−5 min</button>
              <button onClick={() => c.send({ type: 'jump', dt: 5 })}>+5 min</button>
              <span className="menu-t mono">T+{Math.floor(t)}</span>
            </div>
            <label className="menu-row menu-select">
              <span className="menu-k">Replay</span>
              <select value="" onChange={(e) => { if (e.target.value) { c.send({ type: 'scenario', scenarioId: e.target.value, autoplay: true }); setOptsOpen(false); } }}>
                <option value="">A real incident…</option>
                {real.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <div className="menu-note">
              <b>Drive from a phone</b>
              <p>{remote.local
                ? <>Run <code>npm run dev:lan</code>, then open <code>http://&lt;laptop-ip&gt;:5173/#stage</code> on the phone, or use the iPhone app.</>
                : <>Open <code>{remote.url}</code> on the phone.</>}</p>
              <span>{linkText}{c.last ? ` · last: ${c.last}` : ''}</span>
            </div>
          </div>
        )}
      </div>

      <div className="bar-pop" ref={moreRef}>
        <button className="bar-btn bar-more" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>More ▾</button>
        {moreOpen && (
          <nav className="menu" aria-label="Pages">
            {PAGES.map((p) => (
              <a key={p.id} href={`#/app/${p.id}`} className={section === p.id ? 'is-on' : ''} onClick={() => setMoreOpen(false)}>{p.label}</a>
            ))}
            <hr />
            <a href="#/present" target="_blank" rel="noopener">Presenter screen ↗</a>
            <a href="#/stage" target="_blank" rel="noopener">Phone remote ↗</a>
          </nav>
        )}
      </div>
    </header>
  );
}
