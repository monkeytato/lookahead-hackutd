/**
 * Demo controls. Deliberately secondary: this lives inside a collapsed "Demo controls"
 * disclosure on the operations dashboard. Scenario choice, playback, one elapsed scenario
 * clock and an honest "advance to result". Nothing here is needed to read the dashboard.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { listScenarios, randomScenarioId, type ScenarioInfo } from '../domain/scenarios';
import { useOps } from '../state/store';
import type { ScenarioStep } from '../domain/types';
import { useControls } from './controls';

const KIND_LABEL: Record<ScenarioInfo['kind'], string> = { real: 'Real incidents (adapted, simulated)', 'what-if': 'Engineering what-ifs', random: 'Random' };
const SPEEDS = [1, 2, 4, 8];
const LOOKAHEADS = [0, 10, 20, 30];

const elapsed = (min: number) => `${String(Math.floor(min)).padStart(2, '0')}:${String(Math.floor((min % 1) * 60)).padStart(2, '0')}`;

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
  const { open: moreOpen, setOpen: setMoreOpen, ref: moreRef } = usePopover();
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    if (!confirmReset) return;
    const id = window.setTimeout(() => setConfirmReset(false), 3500);
    return () => window.clearTimeout(id);
  }, [confirmReset]);

  const isRandom = scenario.kind === 'random' || state.scenarioId.startsWith('rnd-');
  const ended = t >= H;

  // next meaningful moment ahead: a scenario event, a fix taking effect, or the end
  const advanceTo = useMemo(() => {
    const ahead: number[] = [H];
    for (const s of scenario.steps as ScenarioStep[]) if (s.kind !== 'note' && s.t > t + 0.05) ahead.push(s.t);
    for (const at of Object.values(run.waterArrival)) if (at > t + 0.05) ahead.push(at);
    for (const f of c.fixes) if (f.effectiveAt > t + 0.05) ahead.push(f.effectiveAt);
    return Math.min(...ahead);
  }, [scenario, run, c.fixes, t, H]);

  const nextLabel = advanceTo >= H - 0.01 ? 'Jump to outcome' : 'Advance to result';

  return (
    <section className="demo" aria-label="Demo controls">
      <div className="demo-row">
        <div className="demo-pickwrap" ref={pickerRef}>
          <button className="demo-pick" aria-haspopup="listbox" aria-expanded={pickerOpen} onClick={() => setPickerOpen((o) => !o)} title={scenario.basis}>
            <span className="demo-k">{isRandom ? 'Random' : scenario.kind === 'real' ? 'Real incident' : 'Scenario'}</span>
            <span className="demo-pick-v">{scenario.headline ?? scenario.name}</span>
            <span aria-hidden="true">▾</span>
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
        <button className="demo-btn" onClick={() => c.send({ type: 'scenario', scenarioId: randomScenarioId() })} title="Load a generated disaster (paused until you start it)">
          Random disaster
        </button>
        <span className="demo-sep" aria-hidden="true" />
        <button className="demo-btn demo-play" onClick={() => c.send(ended ? { type: 'seek', t: 0 } : { type: c.playing ? 'pause' : 'play' })} aria-label={c.playing ? 'Pause' : ended ? 'Restart' : 'Start'}>
          {c.playing ? <><PauseIcon /> Pause</> : <><PlayIcon /> {ended ? 'Restart' : 'Start'}</>}
        </button>
        <button className="demo-btn" onClick={() => { c.send({ type: 'seek', t: 0 }); c.send({ type: 'pause' }); }} title="Back to the start, paused">Restart</button>
        <div className="demo-clock" title="Simulated scenario clock — an hour of incident time runs in a few minutes. Not wall time.">
          <span className="demo-k">Demo time</span>
          <b className="mono">{elapsed(t)}</b>
          <span className="demo-of">/ {elapsed(H)}</span>
        </div>
        <button className="demo-btn demo-advance" disabled={!c.shared || ended}
          onClick={() => c.send({ type: 'seek', t: Math.min(H, advanceTo + 0.01) })}
          title="See the next modelled result without waiting for playback">
          {nextLabel} →
        </button>
        <div className="demo-morewrap" ref={moreRef}>
          <button className="demo-btn" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>More controls ▾</button>
          {moreOpen && (
            <div className="pop pop-more" role="dialog" aria-label="More demo controls">
              <div className="pop-field">
                <span>Demo speed</span>
                <div className="pop-segs">
                  {SPEEDS.map((s) => (
                    <button key={s} className={`pop-seg ${c.speed === s ? 'is-on' : ''}`} disabled={!c.shared} onClick={() => c.send({ type: 'speed', speed: s })}>{s}×</button>
                  ))}
                </div>
              </div>
              <label className="pop-field pop-slider">
                <span>Jump to minute</span>
                <input type="range" min={0} max={H} step={0.5} value={t} onChange={(e) => c.send({ type: 'seek', t: +e.target.value })} aria-label="Scenario time" />
              </label>
              <div className="pop-field">
                <span>Forecast lookahead</span>
                <div className="pop-segs">
                  {LOOKAHEADS.map((m) => (
                    <button key={m} className={`pop-seg ${c.lookaheadMin === m ? 'is-on' : ''}`} disabled={!c.shared} onClick={() => c.send({ type: 'lookahead', min: m })}>{m === 0 ? 'Off' : `+${m}`}</button>
                  ))}
                </div>
              </div>
              <div className="pop-field pop-actions">
                <a href="#/present" target="_blank" rel="noopener">Presenter screen ↗</a>
                <button className={`demo-btn ${confirmReset ? 'is-danger' : ''}`} onClick={() => { if (confirmReset) { c.send({ type: 'reset' }); setConfirmReset(false); } else setConfirmReset(true); }}>
                  {confirmReset ? 'Confirm reset' : 'Reset scenario'}
                </button>
              </div>
              <p className="pop-note">Link: <b>{c.link === 'bridge' ? 'bridge (laptop server)' : c.link === 'room' ? 'claude.ai room' : c.link === 'local' ? 'this browser only' : 'not connected — controls act on this screen only'}</b></p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

const PlayIcon = () => <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1 L11 6 L2 11 Z" fill="currentColor" /></svg>;
const PauseIcon = () => <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="1" width="3" height="10" fill="currentColor" /><rect x="7" y="1" width="3" height="10" fill="currentColor" /></svg>;
