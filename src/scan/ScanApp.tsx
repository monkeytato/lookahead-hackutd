import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assets } from '../domain/fixture';
import { MIN_HOLD_S, TARGET_HOLD_S, type Scan, type ScanChannel, type ScanRequest, type StampedFrame } from '../domain/rig/protocol';
import { api, deviceLabel, useBridge, useFrameAge } from '../state/bridge';
import './scan.css';

/** Measurement points the rig can take: inlet probe, ultrasonic fan-mount vibration, drip tray. */
const POINTS = [
  { id: 'inlet', label: 'Front inlet', point: 'Front inlet · temperature probe', channels: ['temp_c'] as ScanChannel[] },
  { id: 'fan', label: 'Fan mount', point: 'Fan mount · ultrasonic vibration', channels: ['vib_a_mm_s', 'vib_b_mm_s', 'disp_a_mm', 'disp_b_mm'] as ScanChannel[] },
  { id: 'drip', label: 'Drip tray', point: 'Drip tray · water sensor', channels: ['drip_wet'] as ScanChannel[] },
] as const;
type PointId = (typeof POINTS)[number]['id'];

const TILES: { ch: ScanChannel; label: string; unit: string; get: (f: StampedFrame) => number | null; fan?: 'fan_a' | 'fan_b' }[] = [
  { ch: 'temp_c', label: 'Inlet air', unit: '°C', get: (f) => f.temp_c },
  { ch: 'vib_a_mm_s', label: 'Fan A vibration', unit: 'mm/s', get: (f) => f.vib?.fan_a?.vel_mm_s ?? null, fan: 'fan_a' },
  { ch: 'vib_b_mm_s', label: 'Fan B vibration', unit: 'mm/s', get: (f) => f.vib?.fan_b?.vel_mm_s ?? null, fan: 'fan_b' },
  { ch: 'disp_a_mm', label: 'Fan A wobble', unit: 'µm', get: (f) => (f.vib?.fan_a?.disp_mm == null ? null : f.vib.fan_a.disp_mm * 1000), fan: 'fan_a' },
  { ch: 'disp_b_mm', label: 'Fan B wobble', unit: 'µm', get: (f) => (f.vib?.fan_b?.disp_mm == null ? null : f.vib.fan_b.disp_mm * 1000), fan: 'fan_b' },
  { ch: 'drip_wet', label: 'Drip tray', unit: '', get: (f) => f.drip_raw },
  { ch: 'pack_v', label: 'Rack power', unit: 'V', get: (f) => f.pack_v },
];

const scanTargets = assets.filter((a) => ['rack', 'battery', 'ups', 'crah', 'pdu', 'cdu', 'pipe', 'pump'].includes(a.type));
const defaultPoint = (assetId: string): PointId => (/^(BATT|UPS|PIPE)/.test(assetId) ? 'drip' : /^(CRAH|P-)/.test(assetId) ? 'fan' : 'inlet');

export function ScanApp() {
  const b = useBridge();
  const age = useFrameAge(b.latest);
  const dev = deviceLabel(b.status, b.online);
  const [assetId, setAssetId] = useState(() => new URLSearchParams(location.hash.split('?')[1]).get('asset') ?? 'A-11');
  const [pointId, setPointId] = useState<PointId>(defaultPoint(assetId));
  const [requestId, setRequestId] = useState<string | undefined>();
  const [operator, setOperator] = useState(() => { try { return localStorage.getItem('lookahead.scan.operator') ?? 'Marcus Lee'; } catch { return 'Marcus Lee'; } });
  const point = POINTS.find((p) => p.id === pointId)!;
  const stale = age == null || age > 3;

  const pickRequest = (r: ScanRequest) => {
    setAssetId(r.assetId);
    const pid = POINTS.find((p) => p.point === r.point)?.id ?? defaultPoint(r.assetId);
    setPointId(pid);
    setRequestId(r.id);
  };

  return (
    <div className="sc">
      <header className="sc-top">
        <a href="#/app" className="sc-brand">Lookahead <span>Scan</span></a>
        <span className={`sc-dev sc-dev-${dev.kind}`} title={b.status?.device.firmware ? `firmware ${b.status.device.firmware}` : undefined}>
          <i aria-hidden="true" />{dev.text}{age != null && dev.kind !== 'off' && <em className="mono">{age < 1.5 ? 'now' : `${Math.round(age)} s`}</em>}
        </span>
      </header>

      <main className="sc-main">
        {b.requests.length > 0 && (
          <section className="sc-sec" aria-label="Requested scans">
            <h2>Requested</h2>
            <ul className="sc-reqs">
              {b.requests.map((r) => (
                <li key={r.id}>
                  <button className={`sc-req ${requestId === r.id ? 'is-on' : ''}`} onClick={() => pickRequest(r)}>
                    <span className="mono sc-req-id">{r.assetId}</span>
                    <span className="sc-req-body"><strong>{r.point}</strong><span>{r.reason}</span><small>{r.requestedBy}{r.incidentId ? ` · ${r.incidentId}` : ''}</small></span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="sc-sec" aria-label="Where are you measuring">
          <h2>Where</h2>
          <div className="sc-where">
            <label className="sc-field">
              <span>Asset</span>
              <select value={assetId} onChange={(e) => { setAssetId(e.target.value); setPointId(defaultPoint(e.target.value)); setRequestId(undefined); }}>
                {scanTargets.map((a) => <option key={a.id} value={a.id}>{a.id} — {a.name}</option>)}
              </select>
            </label>
            <div className="sc-seg" role="radiogroup" aria-label="Measurement point">
              {POINTS.map((p) => (
                <button key={p.id} role="radio" aria-checked={pointId === p.id} className={pointId === p.id ? 'is-on' : ''} onClick={() => { setPointId(p.id); setRequestId(undefined); }}>{p.label}</button>
              ))}
            </div>
          </div>
        </section>

        <LiveGrid frames={b.frames} latest={b.latest} focus={point.channels} />

        <HoldToScan
          disabled={!b.online || stale}
          disabledReason={!b.online ? 'Bridge offline — start it with npm run dev' : stale ? 'Waiting for the rig…' : ''}
          assetId={assetId} point={point.point} operator={operator} requestId={requestId}
          focus={point.channels}
          onOperator={(v) => { setOperator(v); try { localStorage.setItem('lookahead.scan.operator', v); } catch { /* ignore */ } }}
        />

        <History scans={b.scans} />
      </main>
    </div>
  );
}

// ------------------------------------------------------------------ live grid

function LiveGrid({ frames, latest, focus }: { frames: StampedFrame[]; latest: StampedFrame | null; focus: ScanChannel[] }) {
  const recent = frames.slice(-60);
  const ordered = [...TILES].sort((a, b) => Number(focus.includes(b.ch)) - Number(focus.includes(a.ch)));
  return (
    <section className="sc-sec" aria-label="Live sensor values">
      <h2>Live <span className="sc-h-note">1 frame / s · vibration over a ~4 s window</span></h2>
      <div className="sc-grid">
        {ordered.map((t) => {
          const v = latest ? t.get(latest) : null;
          const hz = latest && t.fan ? latest.vib?.[t.fan]?.freq_hz ?? null : null;
          const isFocus = focus.includes(t.ch);
          const floor = t.ch === 'drip_wet';
          const wet = floor && v != null && v >= 120;
          const flagged = latest?.flags.some((fl) => t.fan && fl.startsWith(t.fan));
          return (
            <div key={t.ch} className={`sc-tile ${isFocus ? 'is-focus' : ''} ${v == null ? 'is-null' : ''} ${wet ? 'is-wet' : ''}`}>
              <div className="sc-tile-k">{t.label}</div>
              <div className="sc-tile-v mono">
                {v == null ? '—' : floor ? (wet ? 'WET' : 'Dry') : v.toFixed(t.unit === 'µm' ? 0 : 1)}
                {v != null && !floor && <small>{t.unit}</small>}
              </div>
              <Spark values={recent.map((f) => t.get(f))} />
              <div className="sc-tile-sub">
                {v == null ? (t.ch === 'temp_c' ? 'probe missing' : t.ch === 'pack_v' ? 'divider not fitted' : 'no trustworthy value') :
                  floor ? `raw ${v}` : hz ? `${hz.toFixed(0)} Hz` : t.fan ? 'still' : ' '}
                {flagged && <span className="sc-flag">check sensor</span>}
              </div>
            </div>
          );
        })}
      </div>
      {latest && (
        <div className="sc-state mono">
          flap {latest.flap} · valve {latest.valve} · fans {latest.fan_pct.join('/')}% · auto {latest.auto ? 'on' : 'off'}
          {latest.flags.length > 0 && <> · <span className="sc-flags">{latest.flags.join(', ')}</span></>}
        </div>
      )}
    </section>
  );
}

function Spark({ values }: { values: (number | null)[] }) {
  const nums = values.filter((v): v is number => v != null);
  if (nums.length < 2) return <svg className="sc-spark" viewBox="0 0 100 24" aria-hidden="true" />;
  const lo = Math.min(...nums), hi = Math.max(...nums), span = hi - lo || 1;
  const n = values.length;
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v == null) { pen = false; return; } // a gap stays a gap
    const x = (i / (n - 1)) * 100, y = 21 - ((v - lo) / span) * 18;
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `;
    pen = true;
  });
  return (
    <svg className="sc-spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// --------------------------------------------------------------- hold to scan

type Phase = { k: 'idle' } | { k: 'starting' } | { k: 'holding'; id: string; t0: number } | { k: 'finishing' } | { k: 'done'; scan: Scan } | { k: 'error'; msg: string };

function HoldToScan(props: { disabled: boolean; disabledReason: string; assetId: string; point: string; operator: string; requestId?: string; focus: ScanChannel[]; onOperator: (v: string) => void }) {
  const { disabled, disabledReason, assetId, point, operator, requestId, focus } = props;
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [elapsed, setElapsed] = useState(0);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const raf = useRef(0);
  const b = useBridge();

  const stop = useCallback(async () => {
    const p = phaseRef.current;
    if (p.k !== 'holding') return;
    window.clearInterval(raf.current);
    const held = (performance.now() - p.t0) / 1000;
    setPhase({ k: 'finishing' });
    setElapsed(0);
    try {
      const scan = await api<Scan>(`/api/scans/${p.id}/stop`, {});
      if (scan.status === 'too_short' || held < MIN_HOLD_S) {
        setPhase({ k: 'error', msg: `Released at ${held.toFixed(1)} s. Hold for at least ${MIN_HOLD_S} s so every beam refreshes once.` });
      } else {
        try { navigator.vibrate?.([40, 60, 40]); } catch { /* not supported */ }
        setPhase({ k: 'done', scan });
      }
    } catch (e) { setPhase({ k: 'error', msg: (e as Error).message }); }
  }, []);

  const start = useCallback(async () => {
    if (disabled || phaseRef.current.k === 'holding' || phaseRef.current.k === 'starting') return;
    setPhase({ k: 'starting' });
    setElapsed(0);
    try {
      const r = await api<{ id: string }>('/api/scans/start', { assetId, point, operator, requestId });
      const t0 = performance.now();
      setPhase({ k: 'holding', id: r.id, t0 });
      // wall-clock interval, not rAF: rAF pauses in background tabs / dimmed screens, and the scan must still end
      raf.current = window.setInterval(() => {
        const s = (performance.now() - t0) / 1000;
        setElapsed(s);
        if (s >= TARGET_HOLD_S) { window.clearInterval(raf.current); void stop(); }
      }, 100);
    } catch (e) { setPhase({ k: 'error', msg: (e as Error).message }); }
  }, [disabled, assetId, point, operator, requestId, stop]);

  // releasing anywhere (pointer left the button, window blur) ends the hold
  useEffect(() => {
    const up = () => { if (phaseRef.current.k === 'holding') void stop(); };
    window.addEventListener('pointerup', up);
    window.addEventListener('blur', up);
    return () => { window.removeEventListener('pointerup', up); window.removeEventListener('blur', up); window.clearInterval(raf.current); };
  }, [stop]);

  const holding = phase.k === 'holding';
  const pct = Math.min(1, elapsed / TARGET_HOLD_S);
  const framesIn = holding ? b.frames.filter((f) => Date.parse(f.at) >= Date.now() - elapsed * 1000).length : 0;
  const label = phase.k === 'starting' ? 'Starting…'
    : holding ? (elapsed < MIN_HOLD_S ? `Keep holding · ${Math.ceil(MIN_HOLD_S - elapsed)} s to minimum` : `Keep holding · ${Math.ceil(TARGET_HOLD_S - elapsed)} s`)
    : phase.k === 'finishing' ? 'Computing…' : `Hold to scan · ${TARGET_HOLD_S} s`;

  return (
    <section className="sc-sec sc-holdsec" aria-label="Scan">
      <button
        className={`sc-hold ${holding ? 'is-holding' : ''} ${holding && elapsed >= MIN_HOLD_S ? 'is-valid' : ''}`}
        disabled={disabled && !holding}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); void start(); }}
        onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); void start(); } }}
        onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); void stop(); } }}
        onContextMenu={(e) => e.preventDefault()}
        aria-describedby="sc-hold-help"
      >
        <span className="sc-hold-fill" style={{ transform: `scaleX(${pct})` }} aria-hidden="true" />
        <span className="sc-hold-min" style={{ left: `${(MIN_HOLD_S / TARGET_HOLD_S) * 100}%` }} aria-hidden="true"><i>min</i></span>
        <span className="sc-hold-label">{label}</span>
        {holding && <span className="sc-hold-meta mono">{elapsed.toFixed(1)} s · {framesIn} frames · {assetId}</span>}
      </button>
      <p id="sc-hold-help" className="sc-help">
        {disabled && !holding ? disabledReason : <>Place the rig at <strong>{assetId}</strong>, {point.toLowerCase()}. Hold for {TARGET_HOLD_S} s (two full beam cycles); {MIN_HOLD_S} s is the minimum. Space bar works too.</>}
      </p>
      <label className="sc-field sc-operator"><span>Operator</span><input value={operator} onChange={(e) => props.onOperator(e.target.value)} /></label>

      {phase.k === 'error' && <div className="sc-msg sc-msg-err" role="alert">{phase.msg}</div>}
      {phase.k === 'done' && <ScanResult scan={phase.scan} focus={focus} />}
    </section>
  );
}

const CH_LABEL: Record<ScanChannel, string> = {
  temp_c: 'Inlet air', vib_a_mm_s: 'Fan A vibration', vib_b_mm_s: 'Fan B vibration', disp_a_mm: 'Fan A wobble', disp_b_mm: 'Fan B wobble', drip_wet: 'Tray wet', pack_v: 'Rack power',
};
const isDisp = (c: ScanChannel) => c === 'disp_a_mm' || c === 'disp_b_mm';

function ScanResult({ scan, focus }: { scan: Scan; focus: ScanChannel[] }) {
  const chans = (Object.keys(scan.channels) as ScanChannel[]).sort((a, b) => Number(focus.includes(b)) - Number(focus.includes(a)));
  return (
    <div className="sc-result" role="status">
      <div className="sc-result-h">
        <span className="sc-ok">Sent to dashboard</span>
        <span className="mono">{scan.id}</span>
      </div>
      <div className="sc-result-where">{scan.assetId} · {scan.point} · <span className="mono">{scan.durationS.toFixed(1)} s · {scan.frames} frames</span></div>
      <table className="sc-table">
        <tbody>
          {chans.map((c) => {
            const s = scan.channels[c]!;
            const fmt = (v: number) => (c === 'drip_wet' ? `${Math.round(v * 100)} %` : isDisp(c) ? (v * 1000).toFixed(0) : v.toFixed(2));
            return (
              <tr key={c} className={focus.includes(c) ? 'is-focus' : ''}>
                <th>{CH_LABEL[c]}</th>
                <td className="mono">{fmt(s.mean)}<small> {c === 'drip_wet' ? 'of frames' : isDisp(c) ? 'µm' : s.unit}</small></td>
                <td className="mono sc-sd">± {c === 'drip_wet' ? '' : isDisp(c) ? (s.sd * 1000).toFixed(0) : s.sd.toFixed(2)}</td>
                <td className="mono sc-n">n {s.n}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {scan.quality.length > 0 && <div className="sc-quality">{scan.quality.map((q) => <span key={q} className="sc-q">{q.replace(/_/g, ' ')}</span>)}</div>}
    </div>
  );
}

function History({ scans }: { scans: Scan[] }) {
  const list = useMemo(() => [...scans].reverse().slice(0, 6), [scans]);
  if (!list.length) return null;
  return (
    <section className="sc-sec" aria-label="Recent scans">
      <h2>Recent scans</h2>
      <ul className="sc-hist">
        {list.map((s) => {
          const temp = s.channels.temp_c;
          const vibs = [s.channels.vib_a_mm_s?.mean, s.channels.vib_b_mm_s?.mean].filter((v): v is number => v != null);
          const key = s.channels.drip_wet && s.point.startsWith('Drip') ? (s.channels.drip_wet.mean >= 0.5 ? 'WET' : 'dry')
            : s.point.startsWith('Fan') && vibs.length ? `${Math.max(...vibs).toFixed(1)} mm/s`
            : temp ? `${temp.mean.toFixed(1)} °C` : '—';
          return (
            <li key={s.id}>
              <span className="mono">{new Date(s.endedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
              <span><strong>{s.assetId}</strong> {s.point}</span>
              <span className="mono">{key}</span>
              <span className="sc-src">{s.source === 'live' ? 'LIVE' : 'SIM'}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
