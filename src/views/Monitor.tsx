/**
 * The default screen: a monitor. One card per watched reading — what it is, its unit, a dial with the
 * normal band and alarm line, and a trend (solid = measured, dotted = predicted). Above it, one strip
 * that says either "All readings normal" or what is wrong, how long we have, and a Fix button.
 */
import { useMemo, useState } from 'react';
import { facility } from '../domain/fixture';
import { gaugeSeries, monitorGauges, type Gauge } from '../domain/telemetry';
import { useOps } from '../state/store';
import { assetById, clocksForIncident, visibleClocks } from '../state/selectors';
import { impactLine } from '../app/forecast';
import { useControls } from '../app/controls';
import { GaugeDial } from '../components/GaugeDial';
import { TrendChart } from '../components/TrendChart';
import { FixPanel } from './FixPanel';
import type { ID } from '../domain/types';
import './gauges.css';

export const LOOKBACK = 30;
/** Dotted prediction horizon: the presenter's prediction setting, else 20 min. */
export const useHorizon = () => { const c = useControls(); return c.lookaheadMin > 0 ? c.lookaheadMin : 20; };

export function useGauges() {
  const { state, run, scenario } = useOps();
  const lookahead = useHorizon();
  const t = state.t;
  const input = useMemo(() => ({ facility, scenario, run, t, lookaheadMin: lookahead }), [scenario, run, t, lookahead]);
  const gauges = useMemo(() => monitorGauges(input), [input]);
  return { input, gauges, lookahead, t };
}

const STATUS: Record<Gauge['severity'], string> = { normal: 'Normal', advisory: 'Drifting', warning: 'Above normal', critical: 'Alarm' };
const statusWord = (g: Gauge) => (g.severity === 'warning' && g.dir === 'below' ? 'Below normal' : STATUS[g.severity]);

export function Monitor() {
  const { input, gauges, lookahead, t } = useGauges();
  return (
    <div className="gm">
      <StatusStrip gauges={gauges} />
      <div className="gm-grid">
        {gauges.map((g) => <GaugeCard key={g.id} g={g} series={gaugeSeries(input, g.id, { lookback: LOOKBACK, lookahead })} t={t} lookahead={lookahead} />)}
      </div>
      <p className="gm-foot">Readings are simulated for this demo. Dotted lines are the engine's prediction, not measurements. Normal bands and alarm lines follow the standard named on each card.</p>
    </div>
  );
}

function GaugeCard({ g, series, t, lookahead }: { g: Gauge; series: ReturnType<typeof gaugeSeries>; t: number; lookahead: number }) {
  const abnormal = g.severity !== 'normal';
  const src = g.sourceAssetId ? assetById.get(g.sourceAssetId)?.name ?? g.sourceAssetId : null;
  const delta = g.predicted != null && g.value != null ? g.predicted - g.value : null;
  return (
    <article className={`gm-card ${abnormal ? `is-${g.severity}` : ''}`}>
      <header className="gm-card-head">
        <h3>{g.label}</h3>
        <span className={`gm-state ${abnormal ? `is-${g.severity}` : ''}`}>{statusWord(g)}</span>
      </header>
      <div className="gm-card-body">
        <GaugeDial g={g} />
        <dl className="gm-facts">
          <div><dt>Normal</dt><dd className="mono">{g.normal.lo}–{g.normal.hi} {g.unit}</dd></div>
          <div><dt>Alarm</dt><dd className="mono">{g.dir === 'above' ? '>' : '<'} {g.alarm} {g.unit}</dd></div>
          <div>
            <dt>In {lookahead} min</dt>
            <dd className="mono">{g.predicted == null ? '—' : `${round(g.predicted)} ${g.unit}`}{delta != null && Math.abs(delta) >= 0.05 ? <span className="gm-delta"> {delta > 0 ? '▲' : '▼'}</span> : null}</dd>
          </div>
          {src && <div><dt>Source</dt><dd>{src}</dd></div>}
        </dl>
      </div>
      <TrendChart g={g} series={series} t={t} lookback={LOOKBACK} lookahead={lookahead} />
      <footer className="gm-basis" title={g.basis}>{g.basis}</footer>
    </article>
  );
}

const round = (v: number) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10);

/** One strip: calm when normal; otherwise what is wrong, time to impact, and a Fix button. */
function StatusStrip({ gauges }: { gauges: Gauge[] }) {
  const { state, forecast, scenario, visibleIncidents } = useOps();
  const [fixing, setFixing] = useState<string | null>(null);
  const t = state.t;
  // time to impact is a prediction: forecast run, only what is observed by t (audit C1)
  const clocks = useMemo(() => visibleClocks(forecast.clocks, scenario, t), [forecast, scenario, t]);
  const open = visibleIncidents.filter((i) => i.status !== 'resolved')
    .sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || b.openedAt - a.openedAt)
    .slice(0, 3);
  const abnormal = gauges.filter((g) => g.severity !== 'normal');

  if (!open.length && !abnormal.length) {
    return (
      <section className="gm-strip is-ok" aria-live="polite">
        <span className="gm-ok-dot" aria-hidden="true" />
        <b>All systems normal</b>
        <span>{gauges.length} readings inside their normal bands</span>
      </section>
    );
  }

  return (
    <section className="gm-strip" aria-live="polite">
      <div className="gm-strip-head">
        <b>What's wrong</b>
        {abnormal.length > 0 && <span>{abnormal.length} reading{abnormal.length === 1 ? '' : 's'} outside normal: {abnormal.map((g) => g.short).join(', ')}</span>}
      </div>
      <ul className="gm-issues">
        {open.map((inc) => {
          const imp = impactLine(clocksForIncident(inc, clocks), facility, t, scenario.horizonMin);
          const tone = imp.lost || (imp.minutes != null && imp.minutes <= 10) ? 'is-critical' : imp.minutes != null && imp.minutes <= 30 ? 'is-warning' : '';
          const ids: ID[] = [inc.rootAssetId, ...inc.alertAssetIds];
          return (
            <li key={inc.id} className={`gm-issue sev-${inc.severity}`}>
              <div className="gm-issue-row">
                <span className="gm-issue-title">{inc.title}</span>
                <span className="gm-issue-asset mono">{inc.rootAssetId}</span>
                <span className={`gm-issue-time ${tone}`}>{imp.text}</span>
                <button className="gm-fix" aria-expanded={fixing === inc.id} onClick={() => setFixing(fixing === inc.id ? null : inc.id)}>
                  {fixing === inc.id ? 'Close' : 'Fix'}
                </button>
              </div>
              {fixing === inc.id && <div className="gm-fixpanel"><FixPanel assetIds={ids} compact /></div>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const sevRank = (s: string) => (s === 'critical' ? 3 : s === 'warning' ? 2 : s === 'advisory' ? 1 : 0);
