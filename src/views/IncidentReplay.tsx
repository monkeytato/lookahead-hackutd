/**
 * Plays an evaluated incident on the workspace's 3D map: the incident's own scenario run from
 * "now" to the end of the horizon, without or with the evaluated response (scenarios/playback.ts).
 * Water spreads, failed equipment goes dark, a fix shows its recovery sweep. Few words on purpose:
 * a play button, a Without/With switch, the clock and the racks down.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkAnalysis, WorkIssue } from '../domain/workflow';
import { incidentPlayback, racksDownAt, type IncidentPlayback } from '../domain/scenarios/playback';
import type { AssetVisualState, WaterGrid } from '../domain/types';
import type { TwinRun } from '../twin/Twin';

const PLAY_MS = 10_000;
const STEP = 0.5; // scenario minutes; visualAt is memoised per step

export interface ReplayView {
  visual: Record<string, AssetVisualState>;
  water?: WaterGrid;
  t: number;
  run: TwinRun;
  focusAssetId: string | null;
}

export function useIncidentReplay(issue: WorkIssue | undefined, analysis: WorkAnalysis | undefined) {
  const e = analysis?.comparison?.ensemble;
  const action = analysis?.comparison?.action ?? null;
  const key = issue && e ? `${analysis!.at}|${issue.id}` : null;
  const [side, setSide] = useState<'without' | 'with'>('without');
  const [t, setT] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const lastKey = useRef<string | null>(null);

  const runs = useMemo(() => {
    if (!issue || !e) return null;
    return { without: incidentPlayback(issue.kind, e.pReal, null), with: incidentPlayback(issue.kind, e.pReal, action) };
  }, [issue?.kind, e?.pReal, action]);
  const p: IncidentPlayback | null = runs ? runs[side] : null;

  // A new analysis starts the replay from "now", without a response first.
  useEffect(() => {
    if (key === lastKey.current) return;
    lastKey.current = key;
    if (!key || !runs) { setT(null); setPlaying(false); return; }
    setSide('without'); setT(runs.without.from); setPlaying(true);
  }, [key, runs]);

  useEffect(() => {
    if (!playing || !p) return;
    let raf = 0, start: number | null = null;
    const from = t === null || t >= p.to ? p.from : t;
    const tick = (now: number) => {
      start ??= now;
      const next = from + ((now - start) / PLAY_MS) * (p.to - p.from);
      if (next >= p.to) { setT(p.to); setPlaying(false); return; }
      setT(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // t is read when playback starts only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, p]);

  if (!p || t === null || !issue) return { view: null, bar: null, play: () => {} };
  const tq = Math.round(t / STEP) * STEP;
  const view: ReplayView = { visual: p.run.visualAt(tq), water: p.run.water, t: tq, run: p.run, focusAssetId: null };
  const down = racksDownAt(p, tq);
  const fixDone = p.fix && tq >= p.fix.at;
  const play = () => { if (!playing && t >= p.to) setT(p.from); setPlaying(!playing); };
  const pickSide = (s: 'without' | 'with') => { setSide(s); setT(runs![s].from); setPlaying(true); };

  const bar = <div className="mw-replay" role="group" aria-label="Incident replay">
    <button type="button" className="mw-replay-play" onClick={play} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
    <div className="mw-replay-seg" role="radiogroup" aria-label="Response">
      <button type="button" role="radio" aria-checked={side === 'without'} className={side === 'without' ? 'on' : ''} onClick={() => pickSide('without')}>Without</button>
      <button type="button" role="radio" aria-checked={side === 'with'} className={side === 'with' ? 'on' : ''} onClick={() => pickSide('with')} title={action ?? undefined}>With fix</button>
    </div>
    <div className="mw-replay-track">
      <input type="range" min={p.from} max={p.to} step={STEP} value={tq} aria-label="Minutes" onChange={(ev) => { setPlaying(false); setT(Number(ev.target.value)); }} />
      {p.fix && <span className={`mw-replay-fix ${fixDone ? 'done' : ''}`} style={{ left: `${((p.fix.at - p.from) / (p.to - p.from)) * 100}%` }} title={p.fix.label} aria-hidden="true" />}
    </div>
    <output className="mw-replay-clock">+{Math.round(tq - p.from)} min</output>
    <output className={`mw-replay-down ${down ? 'bad' : ''}`} aria-label={`${down} racks down`}><b>{down}</b> racks down</output>
  </div>;
  return { view, bar, play: () => { setSide('without'); setT(runs!.without.from); setPlaying(true); } };
}
