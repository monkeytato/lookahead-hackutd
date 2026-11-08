/**
 * Phone remote (#/stage): stage the demo from a second phone. Every button sends a stage command;
 * the laptop/projector (#/present, #/app) and every other screen follow. Nothing here computes
 * its own numbers: prediction lines and "saves N racks" come from the engine runs. Every prediction
 * here uses the store's FORECAST run (only faults observed or inferable by t, audit C1); the faults
 * the script still has in store are listed separately, with their priors, for the presenter.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { facility, seedReadings } from '../domain/fixture';
import { fixOptionsFor, makeFix, predictFix, type FixContext, type FixOption, type FixPrediction } from '../domain/engine';
import { listScenarios, randomScenarioId } from '../domain/scenarios';
import { useOps, wallClock } from '../state/store';
import { hasObservedFault, topHypotheses } from '../state/liveForecast';
import { useStage, type StageLink } from './StageProvider';
import { SPEEDS } from './protocol';
import { fmtMin, nameOf, predictionSummary, problemList, summaryLines, type Problem } from './remoteModel';
import './stage.css';

const LINK_TEXT: Record<StageLink, string> = {
  bridge: 'Laptop link',
  room: 'Live room',
  local: 'This browser only',
};
const LINK_HINT: Record<StageLink, string> = {
  bridge: 'Commands go through the laptop bridge to every screen on this network.',
  room: 'Commands reach everyone who has this page open in Claude.',
  local: 'Only tabs in this browser follow. Open the laptop bridge (npm run dev:lan) or the Claude artifact to drive another screen.',
};

export function StageRemote() {
  const { state: stage, send, t, link, scenario, others } = useStage();
  const { forecast, visibleIncidents } = useOps();
  const H = scenario.horizonMin;
  const ended = t >= H;

  const real = useMemo(() => listScenarios().sort((a, b) => (a.kind === 'real' ? 0 : 1) - (b.kind === 'real' ? 0 : 1)), []);
  const problems = useMemo(() => problemList(visibleIncidents, forecast, t), [visibleIncidents, forecast, t]);
  const prediction = useMemo(() => predictionSummary(forecast, t, stage.lookaheadMin, H), [forecast, t, stage.lookaheadMin, H]);
  const observed = hasObservedFault(forecast, t);
  const minute = Math.floor(t);
  const scripted = useMemo(() => topHypotheses(facility, scenario, minute), [scenario, minute]);

  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    if (!confirmReset) return;
    const id = window.setTimeout(() => setConfirmReset(false), 3000);
    return () => window.clearTimeout(id);
  }, [confirmReset]);

  return (
    <div className="st-root">
      <header className="st-top">
        <div className="st-top-row">
          <span className="st-brand">Lookahead <span className="st-brand-sub">stage remote</span></span>
          <span className={`st-link st-link-${link}`} title={LINK_HINT[link]}>
            <span className="st-dot" aria-hidden="true" />{LINK_TEXT[link]}{others !== null ? ` · ${others} other screen${others === 1 ? '' : 's'}` : ''}
          </span>
        </div>
        <div className="st-headline">{scenario.headline ?? scenario.name}</div>
        <div className="st-top-row st-meta">
          <span className="mono st-clock">{wallClock(t)} · T+{Math.floor(t)}</span>
          <span className={`st-state ${stage.playing && !ended ? 'is-on' : ''}`}>{ended ? 'Ended' : stage.playing ? `Playing ${stage.speed}×` : 'Paused'}</span>
          <span className="st-tag">SIMULATED</span>
        </div>
        {stage.last && <div className="st-last" aria-live="polite">{stage.last}</div>}
      </header>

      <main className="st-main">
        {link === 'local' && <p className="st-note">{LINK_HINT.local}</p>}

        <section className="st-card" aria-labelledby="st-dis">
          <h2 id="st-dis">Disaster</h2>
          <button type="button" className="st-big st-primary" onClick={() => send({ type: 'scenario', scenarioId: randomScenarioId(), autoplay: true })}>
            Random disaster
            <span className="st-sub">Generates a new failure and starts the clock</span>
          </button>
          <div className="st-list" role="list">
            {real.map((s) => (
              <button type="button" role="listitem" key={s.id} className={`st-row ${s.id === stage.scenarioId ? 'is-current' : ''}`} onClick={() => send({ type: 'scenario', scenarioId: s.id, autoplay: true })}>
                <span className="st-row-top">
                  <span className="st-kind">{s.kind === 'real' ? 'Real incident' : s.kind === 'random' ? 'Random' : 'What-if'}</span>
                  {s.id === stage.scenarioId && <span className="st-kind st-kind-on">On stage</span>}
                </span>
                <span className="st-row-title">{s.headline || s.name}</span>
                <span className="st-row-basis">{s.basis}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="st-card" aria-labelledby="st-time">
          <h2 id="st-time">Time</h2>
          <div className="st-grid3">
            <button type="button" className="st-btn" onClick={() => send({ type: 'jump', dt: -5 })}>−5 min</button>
            <button type="button" className="st-btn st-primary" onClick={() => send({ type: stage.playing && !ended ? 'pause' : 'play' })}>
              {stage.playing && !ended ? 'Pause' : ended ? 'Replay' : 'Play'}
            </button>
            <button type="button" className="st-btn" onClick={() => send({ type: 'jump', dt: 5 })}>+5 min</button>
          </div>
          <label className="st-scrub">
            <span className="sr-only">Scenario time</span>
            <input type="range" min={0} max={H} step={1} value={Math.floor(t)} onChange={(e) => send({ type: 'seek', t: +e.target.value })} />
            <span className="mono st-scrub-ends"><span>T+0</span><span>T+{H}</span></span>
          </label>
          <div className="st-chips" role="group" aria-label="Speed">
            {SPEEDS.map((sp) => (
              <button type="button" key={sp} aria-pressed={stage.speed === sp} className={`st-chip ${stage.speed === sp ? 'is-on' : ''}`} onClick={() => send({ type: 'speed', speed: sp })}>{sp}×</button>
            ))}
          </div>
          <button type="button" aria-pressed={stage.autoPause} className={`st-chip st-wide ${stage.autoPause ? 'is-on' : ''}`} onClick={() => send({ type: 'autopause', on: !stage.autoPause })}>
            {stage.autoPause ? 'Pauses on each new incident · on' : 'Pauses on each new incident · off'}
          </button>
          <button type="button" className={`st-btn st-wide ${confirmReset ? 'st-danger' : ''}`} onClick={() => { if (confirmReset) { send({ type: 'reset' }); setConfirmReset(false); } else setConfirmReset(true); }}>
            {confirmReset ? 'Tap again to reset to T+0' : 'Reset scenario'}
          </button>
        </section>

        <section className="st-card" aria-labelledby="st-pred">
          <h2 id="st-pred">Prediction</h2>
          <div className="st-chips" role="group" aria-label="Show prediction on the big screen">
            {[0, 10, 20, 30].map((m) => (
              <button type="button" key={m} aria-pressed={stage.lookaheadMin === m} className={`st-chip ${stage.lookaheadMin === m ? 'is-on' : ''}`} onClick={() => send({ type: 'lookahead', min: m })}>{m === 0 ? 'Off' : `+${m} min`}</button>
            ))}
          </div>
          <ul className="st-pred">
            {summaryLines(prediction, t, stage.lookaheadMin, observed).map((l) => <li key={l}>{l}</li>)}
          </ul>
          <p className="st-fine">Forecast from observed faults only · engine p50 clocks over 400 Monte Carlo runs · simulated facility</p>
          {scripted.length > 0 && (
            <>
              <h3 className="st-h3">Scripted, not yet observable</h3>
              <ul className="st-pred">
                {scripted.map((h) => (
                  <li key={h.id}>{h.label} <span className="mono">· P ≈ {h.prior.toPrecision(2)}</span> <span className="st-fine">({h.basisKind === 'published' ? 'published rate' : 'assumption'})</span></li>
                ))}
              </ul>
              <p className="st-fine">Presenter only: the scenario script still has these. The forecast leaves them out until they can be seen.</p>
            </>
          )}
        </section>

        <FixSection problems={problems} />
      </main>
    </div>
  );
}

// ------------------------------------------------------------------ fixes

function FixSection({ problems }: { problems: Problem[] }) {
  const { state: stage, send, t, scenario } = useStage();
  const { forecast: run } = useOps();
  // options and savings from what is observed at t (forecast mode), as on the desktop and the phone
  const ctx: FixContext = useMemo(() => ({ facility, scenario, seedReadings: seedReadings(), fixes: stage.fixes, t, run, mode: 'forecast' }), [scenario, stage.fixes, t, run]);
  const options = useMemo(() => {
    const ordered = new Set(ctx.fixes.map((f) => `${f.action}|${f.assetId}`));
    const out: { problem: Problem; options: FixOption[] }[] = [];
    for (const p of problems) {
      let opts: FixOption[] = [];
      try { opts = fixOptionsFor(ctx, p.assetId); } catch (e) { console.warn('[stage] fixOptionsFor failed', e); }
      out.push({ problem: p, options: opts.filter((o) => !ordered.has(`${o.action}|${o.assetId}`)) });
    }
    return out;
  }, [problems, ctx]);

  const predictions = usePredictions(ctx, options.flatMap((o) => o.options));

  return (
    <section className="st-card" aria-labelledby="st-fix">
      <h2 id="st-fix">Fix</h2>
      {problems.length === 0 && <p className="st-empty">Nothing is wrong yet. Start a disaster or press play.</p>}
      <div className="st-problems">
        {options.map(({ problem: p, options: opts }) => (
          <div key={p.assetId} className={`st-problem sev-${p.severity}`}>
            <button type="button" className={`st-problem-head ${stage.focusAssetId === p.assetId ? 'is-focus' : ''}`} onClick={() => send({ type: 'focus', assetId: stage.focusAssetId === p.assetId ? null : p.assetId })} aria-pressed={stage.focusAssetId === p.assetId}>
              <span className="st-problem-title">{p.title}</span>
              <span className="st-problem-meta mono">
                {p.assetId} · {p.lost ? 'LOST' : p.inMin !== null ? `lost in ${fmtMin(p.inMin)}` : 'no clock'}
                <span className="st-focus-hint">{stage.focusAssetId === p.assetId ? 'Camera on it' : 'Tap to focus camera'}</span>
              </span>
            </button>
            {opts.length === 0 ? <p className="st-empty">No fixes available yet.</p> : opts.map((o) => {
              const pr = predictions.get(keyOf(o));
              return (
                <button type="button" key={keyOf(o)} className="st-fix" onClick={() => send({ type: 'fix', fix: makeFix(o, t) })}>
                  <span className="st-fix-label">{o.label}</span>
                  <span className="st-fix-desc">{o.description}</span>
                  <span className="st-fix-meta mono">
                    takes {o.delayMin} min · {pr === undefined ? 'predicting…' : pr === null ? 'no prediction' : savesText(pr)}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {stage.fixes.length > 0 && (
        <>
          <h3 className="st-h3">Ordered</h3>
          <ul className="st-ordered">
            {stage.fixes.map((f) => (
              <li key={f.id}>
                <span>
                  <span className="st-fix-label">{f.label}</span>
                  <span className="st-fix-meta mono">{nameOf(f.assetId)} · {f.effectiveAt <= t ? 'in effect' : `takes effect at T+${Math.floor(f.effectiveAt)}`}</span>
                </span>
                <button type="button" className="st-btn st-small" onClick={() => send({ type: 'unfix', fixId: f.id })}>Cancel</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const keyOf = (o: FixOption) => `${o.action}|${o.assetId}`;
function savesText(p: FixPrediction): string {
  const racks = p.racksWithout - p.racksWith;
  if (racks > 0) return `saves ${racks} rack${racks === 1 ? '' : 's'}`;
  const assets = p.lostWithout - p.lostWith;
  if (assets > 0) return `saves ${assets} asset${assets === 1 ? '' : 's'}`;
  return 'no change predicted';
}

/**
 * predictFix runs the engine twice per option, so compute off the click path: one option per
 * macrotask, and only again when the scenario, the fixes or a 5-minute time bucket change.
 */
function usePredictions(ctx: FixContext, options: FixOption[]): Map<string, FixPrediction | null> {
  const [results, setResults] = useState(() => new Map<string, FixPrediction | null>());
  const bucket = Math.floor(ctx.t / 5);
  const key = `${ctx.scenario.id}|${JSON.stringify(ctx.fixes)}|${bucket}|${options.map(keyOf).join(',')}`;
  const ctxRef = useRef(ctx);
  const optsRef = useRef(options);
  useEffect(() => { ctxRef.current = ctx; optsRef.current = options; });
  useEffect(() => {
    let cancelled = false;
    const queue = [...optsRef.current];
    const next = new Map<string, FixPrediction | null>();
    let first = true;
    const step = () => {
      if (cancelled) return;
      if (first) { first = false; setResults(new Map()); }
      const o = queue.shift();
      if (!o) return;
      try { next.set(keyOf(o), predictFix(ctxRef.current, o)); } catch (e) { console.warn('[stage] predictFix failed', e); next.set(keyOf(o), null); }
      setResults(new Map(next));
      window.setTimeout(step, 0);
    };
    const id = window.setTimeout(step, 50);
    return () => { cancelled = true; window.clearTimeout(id); };
  }, [key]);
  return results;
}
