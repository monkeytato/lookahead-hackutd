/**
 * Presenter screen (#/present): the projector view while a phone drives the demo from #/stage.
 * Full-bleed twin, a big headline, the clocks that matter, a live ticker, the prediction banner and
 * fix toasts. It follows the shared stage; its only controls are keys (Space, R, P, F).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { facility } from '../domain/fixture';
import { randomScenarioId } from '../domain/scenarios';
import type { Fix } from '../domain/types';
import { Twin, type TwinLayers } from '../twin/Twin';
import { useOps, wallClock } from '../state/store';
import { groupClocks, honestVisual, visibleClocks } from '../state/selectors';
import { SevMark } from '../components/primitives';
import { useControls } from '../app/controls';
import { clockText, leakVisible, routeUrl } from '../app/forecast';
import { usePrediction } from '../app/usePrediction';
import { useStageOptional } from '../stage/StageProvider';
import './present.css';

const LAYERS: TwinLayers = { heat: false, water: true, deps: true, people: false };

export function Present() {
  const { state, run, scenario } = useOps();
  const c = useControls();
  const t = state.t;
  const H = scenario.horizonMin;
  const viewT = Math.min(H, t + c.lookaheadMin);
  const visual = useMemo(() => honestVisual(run, scenario, t, t), [run, scenario, t]);
  const clocks = useMemo(() => visibleClocks(run.clocks, scenario, t), [run, scenario, t]);
  const groups = useMemo(() => groupClocks(clocks, t).slice(0, 4), [clocks, t]);
  const lostNow = useMemo(() => clocks.filter((x) => x.p50 != null && x.p50 <= t).length, [clocks, t]);
  const pred = usePrediction();
  const stageFocus = useStageOptional()?.state.focusAssetId ?? null;
  const [picked, setPicked] = useState<{ id: string | null; over: string | null }>({ id: null, over: null });
  // a click on the projector wins until the phone asks for a different focus
  const focus = picked.id && picked.over === stageFocus ? picked.id : stageFocus;
  const setFocus = (id: string | null) => setPicked({ id, over: stageFocus });
  const highlightPath = focus ? run.clocks[focus]?.path : groups[0]?.clock.path;

  // ticker: scenario steps + fixes taking effect, newest first
  const ticker = useMemo(() => {
    const steps = run.stepsUntil(t).filter((s) => s.kind !== 'note').map((s, i) => ({ id: `s${i}`, t: s.t, text: s.summary, kind: s.kind as string }));
    const fx = c.fixes.filter((f) => f.effectiveAt <= t).map((f) => ({ id: f.id, t: f.effectiveAt, text: `Fix in effect: ${f.label}`, kind: 'fix' }));
    return [...steps, ...fx].sort((a, b) => b.t - a.t).slice(0, 3);
  }, [run, t, c.fixes]);

  const toast = useFixToast(c.fixes, t);
  useKeys(c);

  const kind = scenario.kind === 'real' ? 'Real incident · adapted & simulated' : state.scenarioId.startsWith('rnd-') || scenario.kind === 'random' ? 'Random disaster · simulated' : 'Scenario · simulated';
  const remote = routeUrl('#/stage');

  return (
    <div className="pz">
      <div className="pz-twin">
        <Twin
          facility={facility}
          visual={visual}
          water={leakVisible(scenario, t) ? run.water : undefined}
          t={t}
          now={t}
          run={run}
          presenter
          selectedId={focus}
          onSelect={setFocus}
          employees={state.employees}
          highlightPath={highlightPath}
          layers={LAYERS}
        />
      </div>

      <header className="pz-top">
        <div className="pz-title">
          <div className="pz-kind">{kind}</div>
          <h1>{scenario.headline ?? scenario.name}</h1>
          <p className="pz-basis">{scenario.basis}</p>
        </div>
        <div className="pz-side">
        <div className="pz-clock">
          <div className="pz-wall mono">{wallClock(t)}</div>
          <div className="pz-t mono">T+{Math.floor(t)} / {H} min{c.speed !== 1 ? ` · ${c.speed}×` : ''}</div>
          <div className={`pz-state ${c.playing ? 'is-live' : ''}`}>{c.playing ? 'LIVE' : t >= H ? 'ENDED' : t === 0 ? 'READY' : 'PAUSED'}</div>
        </div>
        <div className="pz-hint mono" aria-hidden="true">
            Driven from phone: {remote.local ? 'http://<laptop-ip>:5173/#/stage' : `${remote.url}`} · Space play · R random · P prediction · F full screen
        </div>
        </div>
      </header>

      {c.lookaheadMin > 0 && (
        <div className="pz-pred" role="status">
          <b>Prediction +{c.lookaheadMin} min</b>
          <span className="mono">{wallClock(viewT)}</span>
          <span>{pred.now.firstRack ? `First rack lost at ${wallClock(pred.now.firstRack.at)}` : 'No rack loss predicted'} · {pred.now.racksLost} racks by T+{H}</span>
          <em>engine forecast, not observed</em>
        </div>
      )}

      {toast && (
        <div className={`pz-toast ${toast.live ? 'is-live' : ''}`} role="status">
          <span className="pz-toast-k">{toast.live ? 'Fix in effect' : 'Fix ordered'}</span>
          <span className="pz-toast-v">{toast.fix.label}</span>
          <span className="mono">{toast.live ? `since ${wallClock(toast.fix.effectiveAt)}` : `takes effect ${wallClock(toast.fix.effectiveAt)} (T+${Math.round(toast.fix.effectiveAt)})`}</span>
        </div>
      )}

      <footer className="pz-bottom">
        <div className="pz-clocks">
          {groups.length === 0 && <div className="pz-calm">{lostNow > 0 ? `No running clocks · ${lostNow} asset${lostNow === 1 ? '' : 's'} already lost` : t === 0 ? 'Ready · press Play on the phone' : 'All clear · no running clocks'}</div>}
          {groups.map((g) => {
            const txt = clockText(g.clock, t, H);
            const sev = g.clock.p50 != null && g.clock.p50 - t <= 10 ? 'critical' : g.clock.p50 != null && g.clock.p50 - t <= 30 ? 'warning' : 'advisory';
            return (
              <button key={g.key} className={`pz-tile ${txt.lost ? 'is-lost' : ''}`} onClick={() => setFocus(g.clock.assetId)}>
                <span className="pz-tile-h"><SevMark sev={sev} size={18} /> {g.label}{g.count > 1 ? <em> ×{g.count}</em> : null}</span>
                <span className="pz-tile-v mono">{txt.main}</span>
                <span className="pz-tile-s">{txt.range ? `${txt.range} · ` : ''}{txt.lost ? g.detail : txt.likelihood}</span>
              </button>
            );
          })}
          <div className="pz-forecast">
            <span className="pz-fk">{c.fixes.length ? `With ${c.fixes.length} fix${c.fixes.length === 1 ? '' : 'es'}` : 'If nothing changes'}</span>
            <b className="mono">{pred.now.racksLost}</b>
            <span>racks lost by T+{H}</span>
            {pred.without && pred.without.racksLost > pred.now.racksLost && <span className="pz-saved">{pred.without.racksLost - pred.now.racksLost} saved</span>}
          </div>
        </div>
        <ol className="pz-ticker" aria-live="polite">
          {ticker.length === 0 && <li className="pz-quiet">Waiting for the first event…</li>}
          {ticker.map((e) => <li key={e.id} className={`pz-ev pz-ev-${e.kind}`}><span className="mono">{wallClock(e.t)}</span> {e.text}</li>)}
        </ol>
      </footer>

    </div>
  );
}

/** Shows the newest fix for 7 s when ordered, and again for 7 s when it takes effect. */
function useFixToast(fixes: Fix[], t: number) {
  const [toast, setToast] = useState<{ fix: Fix; live: boolean } | null>(null);
  const seen = useRef<Set<string>>(new Set(fixes.map((f) => f.id)));
  const live = useRef<Set<string>>(new Set(fixes.filter((f) => f.effectiveAt <= t).map((f) => f.id)));
  useEffect(() => {
    for (const f of fixes) {
      if (!seen.current.has(f.id)) { seen.current.add(f.id); setToast({ fix: f, live: false }); }
      if (f.effectiveAt <= t && !live.current.has(f.id)) { live.current.add(f.id); setToast({ fix: f, live: true }); }
    }
    if (!fixes.length) { seen.current.clear(); live.current.clear(); }
  }, [fixes, t]);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 7000);
    return () => window.clearTimeout(id);
  }, [toast]);
  return toast;
}

function useKeys(c: ReturnType<typeof useControls>) {
  const ref = useRef(c);
  useEffect(() => { ref.current = c; });
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const cur = ref.current;
      if (k === ' ') { e.preventDefault(); cur.send({ type: cur.playing ? 'pause' : 'play' }); }
      else if (k === 'r') cur.send({ type: 'scenario', scenarioId: randomScenarioId(), autoplay: true });
      else if (k === 'p') cur.send({ type: 'lookahead', min: cur.lookaheadMin ? 0 : 20 });
      else if (k === 'f') { void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.())?.catch(() => {}); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
}
