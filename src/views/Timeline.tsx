import { useMemo } from 'react';
import { useOps, wallClock } from '../state/store';

/** Latest scenario and operator events (playback controls live in the control bar). */
export function Timeline() {
  const { state, run } = useOps();
  const t = state.t;
  const recent = useMemo(() => {
    const derived = run.stepsUntil(t).map((s, i) => ({ id: `s${i}`, t: s.t, summary: s.summary, source: 'simulated' }));
    const ops = state.events.filter((e) => e.t <= t + 0.01).map((e) => ({ id: e.id, t: e.t, summary: e.summary, source: e.source }));
    return [...derived, ...ops].sort((a, b) => b.t - a.t).slice(0, 4);
  }, [run, state.events, t]);

  return (
    <section className="timeline tl-ticker" aria-label="Latest events" aria-live="polite">
      <span className="tl-label">Latest</span>
      <ol className="tl-recent">
        {recent.length === 0 && <li className="muted">Nothing has happened yet. Press Play or roll a random disaster.</li>}
        {recent.map((e) => (
          <li key={e.id}><span className="mono">{wallClock(e.t)}</span> {e.summary} <span className="src mono">{e.source === 'simulated' ? 'SIM' : e.source.toUpperCase()}</span></li>
        ))}
      </ol>
    </section>
  );
}
