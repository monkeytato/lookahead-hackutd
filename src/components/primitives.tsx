import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { Freshness, ImpactClock, Severity, Verdict } from '../domain/types';
import { clockText } from '../app/forecast';

/** ISA-101 redundant alarm marker: shape + number + color. Normal renders nothing. */
export function SevMark({ sev, size = 14, label }: { sev: Severity; size?: number; label?: boolean }) {
  if (sev === 'normal') return label ? <span className="sev-word sev-normal">Normal</span> : null;
  const n = sev === 'critical' ? 1 : sev === 'warning' ? 2 : 3;
  const word = sev === 'critical' ? 'Critical' : sev === 'warning' ? 'Warning' : 'Advisory';
  const s = size;
  return (
    <span className={`sev sev-${sev}`} title={`Priority ${n} — ${word}`}>
      <svg width={s} height={s} viewBox="0 0 16 16" aria-hidden="true">
        {sev === 'critical' && <rect x="1" y="1" width="14" height="14" fill="var(--p1)" />}
        {sev === 'warning' && <path d="M8 1 L15.5 15 H0.5 Z" fill="var(--p2)" />}
        {sev === 'advisory' && <circle cx="8" cy="8" r="7" fill="var(--p3)" />}
        <text x="8" y={sev === 'warning' ? 13.2 : 12} textAnchor="middle" fontSize="10" fontWeight="600" fontFamily="var(--mono)" fill={sev === 'critical' ? '#fff' : '#161616'}>{n}</text>
      </svg>
      {label && <span className="sev-word">{word}</span>}
    </span>
  );
}

export function FreshTag({ f, age }: { f: Freshness; age?: number }) {
  if (f === 'fresh') return null;
  return <span className={`tag tag-${f}`}>{f === 'stale' ? `STALE${age != null ? ` ${Math.round(age)}m` : ''}` : 'NO DATA'}</span>;
}

const verdictText: Record<Verdict | 'unverified', string> = {
  corroborated_abnormal: 'Corroborated',
  measurement_disagreement: 'Measurement disagreement',
  inconclusive: 'Inconclusive',
  not_corroborated_in_session: 'Not reproduced in session',
  unverified: 'Unverified',
};
export function EvidenceTag({ v }: { v: Verdict | 'unverified' }) {
  return <span className={`ev ev-${v}`}>{verdictText[v]}</span>;
}
export const verdictLabel = (v: Verdict | 'unverified') => verdictText[v];

/**
 * Countdown with a range: p50 large, (p10–p90) small, bar with likely band and now tick.
 * Values are absolute scenario minutes; `now` is the scrub time.
 */
export function Countdown({ clock, now, horizon = 60, compact }: { clock: ImpactClock; now: number; horizon?: number; compact?: boolean }) {
  const p50 = clock.p50;
  const txt = clockText(clock, now, horizon);
  const pct = (v: number | null, fallback: number) => `${(Math.min(horizon, Math.max(0, (v ?? fallback) - now)) / horizon) * 100}%`;
  return (
    <div className={`cd ${compact ? 'cd-compact' : ''} ${txt.lost ? 'cd-lost' : ''}`} title={txt.likelihood}>
      <div className="cd-value mono">
        {txt.lost ? <>LOST</> : p50 == null ? <>&gt;{horizon}<small> min</small></> : <>{txt.main.replace(' min', '')}<small> min</small></>}
        {txt.range && <span className="cd-range"> {txt.range}</span>}
      </div>
      {!compact && !txt.lost && (
        <div className="cd-bar" aria-hidden="true">
          <span className="cd-band" style={{ left: pct(clock.p10, horizon), right: `calc(100% - ${pct(clock.p90, now + horizon)})` }} />
          <span className="cd-likely" style={{ left: `calc(${pct(p50, horizon)} - 1px)` }} />
          <span className="cd-now" />
        </div>
      )}
      {!compact && <div className="cd-prob">{txt.lost ? 'Modeled as lost' : txt.likelihood}</div>}
    </div>
  );
}

/** Bar-and-band analog indicator. Normal band shaded neutral; value as a dark tick. */
export function BarBand({ value, min, max, warn, alarm, unit, stale }: { value: number | null; min: number; max: number; warn: number; alarm: number; unit: string; stale?: boolean }) {
  const p = (v: number) => `${((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 100}%`;
  const sev = value == null ? 'normal' : value >= alarm ? 'critical' : value >= warn ? 'warning' : 'normal';
  return (
    <div className={`bb ${stale ? 'is-stale' : ''}`}>
      <div className="bb-track">
        <span className="bb-normal" style={{ left: 0, width: p(warn) }} />
        {sev !== 'normal' && <span className={`bb-exceed bb-${sev}`} style={{ left: p(sev === 'critical' ? alarm : warn), right: 0 }} />}
        <span className="bb-tick" style={{ left: p(warn) }} title={`warn ${warn}`} />
        <span className="bb-tick bb-tick-hh" style={{ left: p(alarm) }} title={`alarm ${alarm}`} />
        {value != null && <span className="bb-val" style={{ left: p(value) }} />}
      </div>
      <span className="bb-num mono">{value == null ? '—' : value.toFixed(1)}<small> {unit}</small></span>
    </div>
  );
}

export function Section({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`sec ${className ?? ''}`}>
      <header className="sec-h"><h3>{title}</h3>{aside}</header>
      {children}
    </section>
  );
}

export function Btn({ kind = 'secondary', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button {...rest} className={`btn btn-${kind} ${rest.className ?? ''}`}>{children}</button>;
}

export function Src({ s }: { s: string }) {
  const map: Record<string, string> = { simulated: 'SIM', replay: 'REPLAY', operator: 'OPERATOR', local_rules: 'LOCAL RULES', nemotron: 'NEMOTRON', live: 'LIVE', installed: 'INSTALLED', reference_probe: 'REF PROBE · FIXTURE', manual: 'MANUAL', model: 'MODEL' };
  return <span className="src mono">{map[s] ?? s.toUpperCase()}</span>;
}
