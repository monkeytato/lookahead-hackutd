/**
 * Trend for one reading: solid line = what was measured up to now, dotted line = where the engine
 * predicts it goes. A shaded normal band with its edge labeled, a dashed alarm line labeled, and a
 * "now" marker, so you can see exactly where the reading leaves normal.
 */
import type { Gauge, GaugeSeries } from '../domain/telemetry';
import { sevVar } from './GaugeDial';

const W = 320, H = 112, PL = 6, PR = 14, PT = 8, PB = 18;

export function TrendChart({ g, series, t, lookback, lookahead }: { g: Gauge; series: GaugeSeries; t: number; lookback: number; lookahead: number }) {
  const t0 = t - lookback, t1 = t + lookahead;
  const vals = [...series.actual, ...series.predicted].map((p) => p.v).filter(Number.isFinite);
  // y range: always include the normal band and the alarm line, then the data, with a little air
  let lo = Math.min(g.normal.lo, g.alarm, g.warn, ...vals);
  let hi = Math.max(g.normal.hi, g.alarm, g.warn, ...vals);
  lo = Math.max(g.min, lo - (hi - lo) * 0.08);
  hi = Math.min(g.max, hi + (hi - lo) * 0.08);
  if (hi - lo < 1e-6) hi = lo + 1;

  const x = (tt: number) => PL + ((tt - t0) / (t1 - t0)) * (W - PL - PR);
  const y = (v: number) => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);
  const path = (pts: { t: number; v: number }[]) =>
    pts.filter((p) => p.t >= t0 - 1e-6 && p.t <= t1 + 1e-6 && Number.isFinite(p.v))
      .map((p, i) => `${i ? 'L' : 'M'} ${x(p.t).toFixed(1)} ${y(Math.min(hi, Math.max(lo, p.v))).toFixed(1)}`).join(' ');

  const abnormal = g.severity !== 'normal';
  const color = abnormal ? sevVar(g.severity) : 'var(--text)';
  const edge = g.dir === 'above' ? g.normal.hi : g.normal.lo;
  const bandTop = y(Math.min(hi, g.normal.hi)), bandBot = y(Math.max(lo, g.normal.lo));
  const xNow = x(t);

  return (
    <svg className="tc" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${g.label} trend: solid measured, dotted predicted`}>
      <rect x={PL} y={bandTop} width={W - PL - PR} height={Math.max(0, bandBot - bandTop)} className="tc-band" />
      <line x1={PL} x2={W - PR} y1={y(edge)} y2={y(edge)} className="tc-normal" />
      <line x1={PL} x2={W - PR} y1={y(g.alarm)} y2={y(g.alarm)} className="tc-alarm" />

      <line x1={xNow} x2={xNow} y1={PT} y2={H - PB} className="tc-now" />
      <text x={xNow} y={H - 4} className="tc-axis" textAnchor="middle">now</text>
      <text x={PL} y={H - 4} className="tc-axis">−{lookback} min</text>
      <text x={W - PR} y={H - 4} className="tc-axis" textAnchor="end">+{lookahead} min</text>

      <path d={path(series.predicted)} className="tc-pred" style={{ stroke: color }} />
      <path d={path(series.actual)} className="tc-actual" style={{ stroke: color }} />
    </svg>
  );
}
