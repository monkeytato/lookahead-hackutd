/**
 * Presenter screen (#/present): the projector view while a phone drives the demo from #/stage.
 * Full-bleed twin, a headline, the clock, ONE number (time to the next rack loss), one forecast line,
 * the prediction banner and fix toasts. It follows the shared stage; its only controls are keys
 * (Space play/pause, R random disaster, P prediction, F full screen).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { facility } from '../domain/fixture';
import { randomScenarioId } from '../domain/scenarios';
import type { Fix } from '../domain/types';
import { Twin, type TwinLayers } from '../twin/Twin';
import { useOps, wallClock } from '../state/store';
import { honestVisual, visibleClocks } from '../state/selectors';
import { useControls } from '../app/controls';
import { impactLine, leakVisible } from '../app/forecast';
import { usePrediction } from '../app/usePrediction';
import { useStageOptional } from '../stage/StageProvider';
import './present.css';

const LAYERS: TwinLayers = { heat: false, water: true, deps: true, people: false };

export function Present() {
  // run = the world (what is happening); forecast = what can be predicted from what is observed (audit C1)
  const { state, run, forecast, scenario } = useOps();
  const c = useControls();
  const t = state.t;
  const H = scenario.horizonMin;
  const viewT = Math.min(H, t + c.lookaheadMin);
  const visual = useMemo(() => honestVisual(run, scenario, t, t, forecast), [run, forecast, scenario, t]);
  const clocks = useMemo(() => visibleClocks(forecast.clocks, scenario, t), [forecast, scenario, t]);
  const hero = useMemo(() => impactLine(clocks, facility, t, H), [clocks, t, H]);
  const pred = usePrediction();
  const stageFocus = useStageOptional()?.state.focusAssetId ?? null;
  const [picked, setPicked] = useState<{ id: string | null; over: string | null }>({ id: null, over: null });
  // a click on the projector wins until the phone asks for a different focus
  const focus = picked.id && picked.over === stageFocus ? picked.id : stageFocus;
  const setFocus = (id: string | null) => setPicked({ id, over: stageFocus });
  const soonest = useMemo(() => clocks.filter((x) => x.p50 != null && x.p50 > t).sort((a, b) => a.p50! - b.p50!)[0], [clocks, t]);
  const highlightPath = focus ? forecast.clocks[focus]?.path : soonest?.path;
  const heroTone = hero.lost || (hero.minutes != null && hero.minutes <= 10) ? 'is-critical' : hero.minutes != null && hero.minutes <= 30 ? 'is-warning' : '';
  const base = pred.without ?? pred.now;
  const saved = pred.without ? pred.without.racksLost - pred.now.racksLost : 0;

  const toast = useFixToast(c.fixes, t);
  useKeys(c);

  const kind = scenario.kind === 'real' ? 'Real incident · adapted & simulated' : state.scenarioId.startsWith('rnd-') || scenario.kind === 'random' ? 'Random disaster · simulated' : 'Scenario · simulated';

  return (
    <div className="pz">
      <div className="pz-twin">
        <Twin
          facility={facility}
          visual={visual}
          water={leakVisible(scenario, t) ? run.water : undefined}
          t={t}
          now={t}
          run={forecast}
          presenter
          selectedId={focus}
          onSelect={setFocus}
          employees={state.employees}
          highlightPath={highlightPath}
          layers={LAYERS}
        />
      </div>

      <header className="pz-top">
        <a className="pz-back" href="#/app">← Dashboard</a>
        <div className="pz-title">
          <div className="pz-kind">{kind}</div>
          <h1>{scenario.headline ?? scenario.name}</h1>
          <p className="pz-basis" title={scenario.basis}>{scenario.basis}</p>
        </div>
        <div className="pz-clock" title="Keys: Space play/pause · R random disaster · P prediction · F full screen">
          <div className="pz-wall mono">{wallClock(t)}</div>
          <div className="pz-t mono">T+{Math.floor(t)} / {H} min{c.speed !== 1 ? ` · ${c.speed}×` : ''}</div>
          <div className={`pz-state ${c.playing ? 'is-live' : ''}`}>{c.playing ? 'LIVE' : t >= H ? 'ENDED' : t === 0 ? 'READY' : 'PAUSED'}</div>
        </div>
      </header>

      {c.lookaheadMin > 0 && (
        <div className="pz-pred" role="status">
          <b>Prediction +{c.lookaheadMin} min</b>
          <span className="mono">{wallClock(viewT)}</span>
          <span>{!pred.observed ? 'No observed fault · nothing to forecast yet' : `${pred.now.firstRack ? `First rack lost at ${wallClock(pred.now.firstRack.at)}` : 'No rack loss forecast'} · ${pred.now.racksLost} racks by T+${H}`}</span>
          <em>forecast from observed faults only</em>
        </div>
      )}

      {toast && (
        <div className={`pz-toast ${toast.live ? 'is-live' : ''}`} role="status">
          <span className="pz-toast-k">{toast.live ? 'Fix in effect' : 'Fix ordered'}</span>
          <span className="pz-toast-v">{toast.fix.label}</span>
          <span className="mono">{toast.live ? `since ${wallClock(toast.fix.effectiveAt)}` : `takes effect ${wallClock(toast.fix.effectiveAt)} (T+${Math.floor(toast.fix.effectiveAt)})`}</span>
        </div>
      )}

      <footer className="pz-bottom">
        <div className={`pz-hero ${heroTone}`}>
          <span className="pz-hero-v">{t === 0 && !c.playing ? 'Ready' : !pred.observed ? 'No observed fault · watching' : hero.minutes == null && !hero.lost ? 'No loss forecast' : hero.text}</span>
          {hero.assetId && <span className="pz-hero-s mono">{hero.assetId} · {facility.assets.find((a) => a.id === hero.assetId)?.name}</span>}
        </div>
        <div className="pz-line">
          <span className="pz-fk">Forecast if nothing changes</span>
          <span>{!pred.observed ? 'no observed fault · watching' : `${base.firstRack ? `first rack lost at ${wallClock(base.firstRack.at)} · ` : ''}${base.racksLost} racks lost by ${wallClock(H)}`}</span>
          {pred.without && (
            <>
              <span className="pz-fk">With your fixes</span>
              <span className={saved > 0 ? 'pz-saved' : ''}>{pred.now.racksLost} racks{saved > 0 ? ` · ${saved} saved` : ''}</span>
            </>
          )}
        </div>
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
