/**
 * A quiet 270° dial for one reading: gray track, shaded normal band, warning and alarm ticks,
 * a value arc + needle (gray when normal, severity color only when abnormal — ISA-101), and a
 * hollow marker where the engine predicts the reading will be.
 */
import type { Gauge } from '../domain/telemetry';

const START = 135;
const SWEEP = 270;
const C = 100;
const R = 78;

const frac = (g: Gauge, v: number) => Math.min(1, Math.max(0, (v - g.min) / (g.max - g.min || 1)));
const ang = (f: number) => ((START + SWEEP * f) * Math.PI) / 180;
const pt = (f: number, r = R) => [C + r * Math.cos(ang(f)), C + r * Math.sin(ang(f))] as const;

function arc(f0: number, f1: number, r = R): string {
  const a = Math.min(f0, f1), b = Math.max(f0, f1);
  if (b - a < 0.0005) return '';
  const [x0, y0] = pt(a, r), [x1, y1] = pt(b, r);
  const large = SWEEP * (b - a) > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function tick(f: number, inner: number, outer: number) {
  const [x0, y0] = pt(f, inner), [x1, y1] = pt(f, outer);
  return { x1: x0, y1: y0, x2: x1, y2: y1 };
}

export const sevVar = (s: Gauge['severity']) =>
  s === 'critical' ? 'var(--p1)' : s === 'warning' ? 'var(--p2)' : s === 'advisory' ? 'var(--p3)' : 'var(--text)';

export function fmtValue(v: number | null, unit: string): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const digits = Math.abs(v) >= 100 || unit === 'min' || unit === '%RH' ? 0 : 1;
  return v.toFixed(digits);
}

export function GaugeDial({ g, size = 132 }: { g: Gauge; size?: number }) {
  const abnormal = g.severity !== 'normal';
  const color = abnormal ? sevVar(g.severity) : 'var(--text-2)';
  const vf = g.value == null ? null : frac(g, g.value);
  const pf = g.predicted == null ? null : frac(g, g.predicted);
  const bandLo = frac(g, g.normal.lo), bandHi = frac(g, g.normal.hi);
  const warnF = frac(g, g.warn), alarmF = frac(g, g.alarm);
  const needle = vf == null ? null : pt(vf, R - 22);

  return (
    <svg className="gd" viewBox="0 0 200 200" width={size} height={size} role="img"
      aria-label={`${g.label}: ${fmtValue(g.value, g.unit)} ${g.unit}, normal ${g.normal.lo}–${g.normal.hi} ${g.unit}`}>
      {/* track + normal band */}
      <path d={arc(0, 1)} className="gd-track" />
      <path d={arc(bandLo, bandHi)} className="gd-band" />
      {/* value arc from the scale start (or from the top for "below is bad" gauges) */}
      {vf != null && <path d={g.dir === 'below' ? arc(vf, 1) : arc(0, vf)} className="gd-value" style={{ stroke: color }} />}
      {/* prediction: dotted from now to the predicted value, hollow end marker */}
      {vf != null && pf != null && Math.abs(pf - vf) > 0.004 && <path d={arc(vf, pf, R + 13)} className="gd-pred" />}
      {pf != null && (() => { const [x, y] = pt(pf, R + 13); return <circle cx={x} cy={y} r={4.5} className="gd-pred-dot" />; })()}
      {/* thresholds */}
      <line {...tick(warnF, R - 12, R + 9)} className="gd-tick gd-tick-warn" />
      <line {...tick(alarmF, R - 12, R + 9)} className="gd-tick gd-tick-alarm" />
      {/* needle */}
      {needle && <line x1={C} y1={C} x2={needle[0]} y2={needle[1]} className="gd-needle" style={{ stroke: color }} />}
      <circle cx={C} cy={C} r={4} className="gd-hub" style={{ fill: color }} />
      {/* scale ends */}
      <text x={pt(0, R + 4)[0] + 6} y={pt(0, R + 4)[1] + 16} className="gd-scale" textAnchor="middle">{g.min}</text>
      <text x={pt(1, R + 4)[0] - 6} y={pt(1, R + 4)[1] + 16} className="gd-scale" textAnchor="middle">{g.max}</text>
      {/* readout */}
      <text x={C} y={C + 44} className="gd-num" textAnchor="middle" style={{ fill: abnormal ? color : 'var(--text)' }}>{fmtValue(g.value, g.unit)}</text>
      <text x={C} y={C + 62} className="gd-unit" textAnchor="middle">{g.unit}</text>
    </svg>
  );
}
