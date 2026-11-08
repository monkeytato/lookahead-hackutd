/**
 * Scenario & playback bar: the one place to pick or roll a disaster, run the clock, preview the
 * prediction and hand control to a phone. Everything goes through the stage (useControls), so the
 * presenter screen and the phone remote follow.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { listScenarios, randomScenarioId, type ScenarioInfo } from '../domain/scenarios';
import { useOps, wallClock } from '../state/store';
import type { ScenarioStep } from '../domain/types';
import { useControls } from './controls';
import { routeUrl } from './forecast';

const KIND_LABEL: Record<ScenarioInfo['kind'], string> = { real: 'Real incidents (adapted, simulated)', 'what-if': 'Engineering what-ifs', random: 'Random' };
const SPEEDS = [0.5, 1, 2, 4];
const LOOKAHEADS = [0, 10, 20, 30];

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

export function ControlBar() {
  const { state, scenario, run } = useOps();
  const c = useControls();
  const t = state.t;
  const H = scenario.horizonMin;
  const list = useMemo(() => listScenarios(), []);
  const groups = useMemo(() => {
    const g = new Map<ScenarioInfo['kind'], ScenarioInfo[]>();
    for (const s of list) g.set(s.kind, [...(g.get(s.kind) ?? []), s]);
    return (['real', 'what-if'] as const).filter((k) => g.has(k)).map((k) => ({ kind: k, items: g.get(k)! }));
  }, [list]);
  const { open: pickerOpen, setOpen: setPickerOpen, ref: pickerRef } = usePopover();
  const { open: phoneOpen, setOpen: setPhoneOpen, ref: phoneRef } = usePopover();
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    if (!confirmReset) return;
    const id = window.setTimeout(() => setConfirmReset(false), 3500);
    return () => window.clearTimeout(id);
  }, [confirmReset]);

  const isRandom = scenario.kind === 'random' || state.scenarioId.startsWith('rnd-');
  const ticks = useMemo(() => {
    const steps = scenario.steps.filter((s: ScenarioStep) => s.kind !== 'note').map((s: ScenarioStep) => ({ t: s.t, label: s.summary, kind: s.kind }));
    const wet = Object.entries(run.waterArrival).filter(([id]) => /^(UPS|BATT)/.test(id)).map(([id, at]) => ({ t: at, label: `Water reaches ${id} (model)`, kind: 'alert' as const }));
    const fixes = c.fixes.map((f) => ({ t: f.effectiveAt, label: `Fix in effect: ${f.label}`, kind: 'fix' as const }));
    return [...steps, ...wet, ...fixes].filter((k) => k.t <= H).sort((a, b) => a.t - b.t);
  }, [scenario, run, c.fixes, H]);

  const ended = t >= H;
  const remote = routeUrl('#/stage');

  return (
    <section className="cbar" aria-label="Scenario and playback">
      <div className="cbar-scn" ref={pickerRef}>
        <button className="cbar-pick" aria-haspopup="listbox" aria-expanded={pickerOpen} onClick={() => setPickerOpen((o) => !o)} title={scenario.basis}>
          <span className="cbar-pick-k">{isRandom ? 'Random disaster' : scenario.kind === 'real' ? 'Real incident' : 'Scenario'}</span>
          <span className="cbar-pick-v">{scenario.headline ?? scenario.name}</span>
          <span className="cbar-caret" aria-hidden="true">▾</span>
        </button>
        {pickerOpen && (
          <div className="pop pop-scn" role="listbox" aria-label="Choose a scenario">
            {groups.map((g) => (
              <div key={g.kind} className="pop-group">
                <div className="pop-gh">{KIND_LABEL[g.kind]}</div>
                {g.items.map((s) => (
                  <button key={s.id} role="option" aria-selected={s.id === state.scenarioId} className={`pop-item ${s.id === state.scenarioId ? 'is-on' : ''}`}
                    onClick={() => { c.send({ type: 'scenario', scenarioId: s.id }); setPickerOpen(false); }}>
                    <span className="pop-name">{s.name}</span>
                    <span className="pop-head">{s.headline}</span>
                    <span className="pop-basis">{s.basis}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      <button className="cbar-random" onClick={() => c.send({ type: 'scenario', scenarioId: randomScenarioId(), autoplay: true })} title="Generate a new disaster and start the clock">
        <span aria-hidden="true">⚄</span> Random disaster
      </button>

      <div className="cbar-play" role="group" aria-label="Playback">
        <button className="cbar-btn cbar-main" onClick={() => c.send(ended ? { type: 'seek', t: 0 } : { type: c.playing ? 'pause' : 'play' })} aria-label={c.playing ? 'Pause' : ended ? 'Restart from T+0' : 'Play'}>
          {c.playing ? <><PauseIcon /> Pause</> : ended ? <>↺ Restart</> : <><PlayIcon /> Play</>}
        </button>
        <button className="cbar-btn" onClick={() => c.send({ type: 'jump', dt: -5 })} aria-label="Back 5 minutes">−5</button>
        <button className="cbar-btn" onClick={() => c.send({ type: 'jump', dt: 5 })} aria-label="Forward 5 minutes">+5</button>
        <label className="cbar-speed" title={c.shared ? 'Playback speed' : 'Speed needs the stage'}>
          <span className="sr-only">Speed</span>
          <select value={c.speed} disabled={!c.shared} onChange={(e) => c.send({ type: 'speed', speed: +e.target.value })}>
            {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
        </label>
      </div>

      <div className="cbar-track">
        <div className="cbar-time mono"><b>{wallClock(t)}</b> T+{Math.floor(t)}<span> / {H} min</span></div>
        <div className="cbar-rail">
          <input type="range" min={0} max={H} step={0.5} value={t} onChange={(e) => c.send({ type: 'seek', t: +e.target.value })} aria-label="Scenario time" />
          <div className="tl-ticks" aria-hidden="true">
            {ticks.map((k, i) => <span key={i} className={`tl-tick tl-${k.kind} ${k.t <= t ? 'is-past' : ''}`} style={{ left: `${(k.t / H) * 100}%` }} title={`${wallClock(k.t)} ${k.label}`} />)}
            {c.lookaheadMin > 0 && <span className="cbar-ahead" style={{ left: `${(t / H) * 100}%`, width: `${(Math.min(c.lookaheadMin, H - t) / H) * 100}%` }} />}
          </div>
        </div>
      </div>

      <div className="cbar-pred" role="group" aria-label="Prediction preview">
        <span className="cbar-k">Prediction</span>
        <div className="cbar-segs">
        {LOOKAHEADS.map((m) => (
          <button key={m} className={`cbar-seg ${c.lookaheadMin === m ? 'is-on' : ''}`} aria-pressed={c.lookaheadMin === m} disabled={!c.shared}
            onClick={() => c.send({ type: 'lookahead', min: m })}>{m === 0 ? 'Off' : `+${m}`}</button>
        ))}
        </div>
      </div>

      <div className="cbar-end">
        <button className={`cbar-btn ${confirmReset ? 'is-danger' : ''}`} onClick={() => { if (confirmReset) { c.send({ type: 'reset' }); setConfirmReset(false); } else setConfirmReset(true); }}>
          {confirmReset ? 'Confirm reset' : 'Reset'}
        </button>
        <div className="cbar-phone" ref={phoneRef}>
          <button className="cbar-btn cbar-remote" aria-expanded={phoneOpen} onClick={() => setPhoneOpen((o) => !o)}>
            <i className={`link-dot link-${c.link ?? 'none'}`} aria-hidden="true" /> Phone remote
          </button>
          {phoneOpen && (
            <div className="pop pop-phone" role="dialog" aria-label="Drive this demo from a phone">
              <h4>Drive the demo from a second phone</h4>
              <ol>
                {remote.local ? (
                  <>
                    <li>On this laptop run <code>npm run dev:lan</code>.</li>
                    <li>On the phone (same Wi-Fi) open <code>http://&lt;laptop-ip&gt;:5173/#/stage</code>.</li>
                  </>
                ) : (
                  <>
                    <li>Open this same page on the phone: <code className="sel">{remote.url}</code></li>
                    <li>In an artifact link, open the landing page and tap <b>Phone remote</b>.</li>
                  </>
                )}
                <li>Show <a href="#/present" target="_blank" rel="noopener">the presenter screen</a> on the projector.</li>
              </ol>
              <p className="pop-note">Link: <b>{c.link === 'bridge' ? 'bridge (laptop server)' : c.link === 'room' ? 'claude.ai room (all open copies)' : c.link === 'local' ? 'this browser only' : 'not connected — controls act on this screen only'}</b>{c.last ? <> · last: {c.last}</> : null}</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

const PlayIcon = () => <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1 L11 6 L2 11 Z" fill="currentColor" /></svg>;
const PauseIcon = () => <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="1" width="3" height="10" fill="currentColor" /><rect x="7" y="1" width="3" height="10" fill="currentColor" /></svg>;
