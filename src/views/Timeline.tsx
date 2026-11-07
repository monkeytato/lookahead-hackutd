import { useMemo } from 'react';
import { useOps, wallClock } from '../state/store';
import { Btn } from '../components/primitives';

/** Demo playback + scenario event ticks + the latest operational events. */
export function Timeline() {
  const { state, dispatch, scenario, run } = useOps();
  const t = state.t;
  const H = scenario.horizonMin;
  const ticks = useMemo(() => {
    const steps = scenario.steps.map((s) => ({ t: s.t, label: s.summary, kind: s.kind }));
    const wet = Object.entries(run.waterArrival).filter(([id]) => /^(UPS|BATT)/.test(id)).map(([id, at]) => ({ t: at, label: `Water reaches ${id} (model)`, kind: 'alert' as const }));
    return [...steps, ...wet].sort((a, b) => a.t - b.t);
  }, [scenario, run]);

  const recent = useMemo(() => {
    const derived = run.stepsUntil(t).map((s, i) => ({ id: `s${i}`, t: s.t, summary: s.summary, source: 'simulated' }));
    const ops = state.events.filter((e) => e.t <= t + 0.01).map((e) => ({ id: e.id, t: e.t, summary: e.summary, source: e.source }));
    return [...derived, ...ops].sort((a, b) => b.t - a.t).slice(0, 3);
  }, [run, state.events, t]);

  return (
    <section className="timeline" aria-label="Scenario playback">
      <div className="tl-controls">
        <Btn kind="primary" onClick={() => dispatch({ type: 'play', playing: !state.playing })} aria-label={state.playing ? 'Pause' : 'Play'}>
          {state.playing ? 'Pause' : t >= H ? 'Ended' : 'Play'}
        </Btn>
        <Btn kind="ghost" onClick={() => dispatch({ type: 'set_t', t: Math.max(0, Math.floor(t) - 5) })}>−5</Btn>
        <Btn kind="ghost" onClick={() => dispatch({ type: 'set_t', t: Math.min(H, Math.floor(t) + 5) })}>+5</Btn>
        <Btn kind="ghost" onClick={() => { if (confirm('Reset the demo fixture? Operator records for this scenario will be cleared.')) dispatch({ type: 'reset' }); }}>Reset demo</Btn>
      </div>
      <div className="tl-track">
        <input type="range" min={0} max={H} step={0.5} value={t} onChange={(e) => dispatch({ type: 'set_t', t: +e.target.value })} aria-label="Scenario time" />
        <div className="tl-ticks" aria-hidden="true">
          {ticks.map((k, i) => (
            <span key={i} className={`tl-tick tl-${k.kind} ${k.t <= t ? 'is-past' : ''}`} style={{ left: `${(k.t / H) * 100}%` }} title={`${wallClock(k.t)} ${k.label}`} />
          ))}
        </div>
        <div className="tl-scale mono" aria-hidden="true">
          {[0, 15, 30, 45, 60].filter((m) => m <= H).map((m) => <span key={m} style={{ left: `${(m / H) * 100}%` }}>{wallClock(m)}</span>)}
        </div>
      </div>
      <ol className="tl-recent">
        {recent.map((e) => (
          <li key={e.id}><span className="mono">{wallClock(e.t)}</span> {e.summary} <span className="src mono">{e.source === 'simulated' ? 'SIM' : e.source.toUpperCase()}</span></li>
        ))}
      </ol>
    </section>
  );
}
