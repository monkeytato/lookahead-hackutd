import { useMemo, useState } from 'react';
import type { RigEvent, StampedFrame } from '../domain/rig/protocol';
import { api, deviceLabel, useBridge, useFrameAge } from '../state/bridge';
import { Btn } from '../components/primitives';
import { PhoneView } from './Phone';

/** The physical Rack Monitor: live channels, its own root-cause events, staging controls, scans. */
export function RigView() {
  const b = useBridge();
  const age = useFrameAge(b.latest);
  const dev = deviceLabel(b.status, b.online);
  const [reply, setReply] = useState('');
  const sim = b.status?.device.mode === 'simulated';
  const f = b.latest;

  const cmd = async (c: string) => {
    try { const r = await api<{ reply: string }>('/api/rig/command', { cmd: c }); setReply(r.reply); }
    catch (e) { setReply((e as Error).message); }
  };

  return (
    <div className="page rig">
      <header className="page-h">
        <div>
          <h1>Rack node</h1>
          <p className="muted">
            One Rack Monitor, placed at one rack at a time. Every scan is tagged with the asset and point it was taken at.
          </p>
        </div>
        <div className="page-h-actions">
          <a className="btn btn-primary" href="#/scan" target="_blank" rel="noopener">Open scanner</a>
        </div>
      </header>

      <PhoneView />

      <section className="rig-status">
        <div><span className="meta-k">Link</span><span className={`rig-dev rig-dev-${dev.kind}`}>{dev.text}</span></div>
        <div><span className="meta-k">Firmware</span><span className="mono">{b.status?.device.firmware ?? '—'}</span></div>
        <div><span className="meta-k">Last frame</span><span className="mono">{age == null ? '—' : age < 1.5 ? 'now' : `${Math.round(age)} s ago`}</span></div>
        <div><span className="meta-k">Frames</span><span className="mono">{b.status?.device.framesReceived ?? 0}</span></div>
        <div><span className="meta-k">Nemotron</span><span>{b.status?.nemotron.configured ? <span className="mono">{b.status.nemotron.model}</span> : 'not configured → local planner'}</span></div>
      </section>

      {!b.online && <p className="rig-off">The bridge isn't running. Start everything with <code>npm run dev</code> (web + bridge), or just the bridge with <code>npm run bridge</code>.</p>}

      {f && (
        <div className="rig-grid">
          <section className="rig-card rig-chart-card">
            <h2>Air temperature from sound <span className="muted small">acoustic beams vs DS18B20 reference · last 3 min</span></h2>
            <TempChart frames={b.frames} />
          </section>
          <section className="rig-card">
            <h2>Now</h2>
            <table className="readings">
              <tbody>
                <Row k="Inlet top" v={f.inlet_top_c} u="°C" sub={`beam ${Math.round(f.beam_age_s.inlet_top)} s · ${f.echo_us.inlet_top?.toFixed(0) ?? '—'} µs`} />
                <Row k="Inlet bottom" v={f.inlet_bottom_c} u="°C" sub={`beam ${Math.round(f.beam_age_s.inlet_bottom)} s · ${f.echo_us.inlet_bottom?.toFixed(0) ?? '—'} µs`} />
                <Row k="Outlet" v={f.outlet_c} u="°C" sub={`beam ${Math.round(f.beam_age_s.outlet)} s · ${f.echo_us.outlet?.toFixed(0) ?? '—'} µs`} />
                <Row k="Reference" v={f.ref_c} u="°C" sub={f.ref_c == null ? 'not fitted' : 'DS18B20'} />
                <Row k="Reservoir" v={f.reservoir_raw} u="raw" sub="A0" digits={0} />
                <Row k="Floor" v={f.floor_raw} u="raw" sub={f.floor_raw >= 120 ? 'WET' : 'dry'} digits={0} />
                <Row k="Rack power" v={f.pack_v} u="V" sub={f.pack_v == null ? 'divider not fitted' : '6×AA'} />
                <tr><th>Actuators</th><td colSpan={2} className="mono">flap {f.flap} · valve {f.valve} · fans {f.fan_pct.join('/')}% · auto {f.auto ? 'on' : 'off'}</td></tr>
                {f.flags.length > 0 && <tr><th>Flags</th><td colSpan={2} className="is-warn mono">{f.flags.join(', ')}</td></tr>}
              </tbody>
            </table>
          </section>
          <section className="rig-card">
            <h2>Rig root-cause events <span className="muted small">rules, not a model</span></h2>
            <Events events={b.events} />
          </section>
          <section className="rig-card">
            <h2>Stage a failure</h2>
            <div className="rig-cmds">
              <span className="rig-cmd-k">Rig</span>
              {['flap open', 'flap close', 'valve open', 'valve close', 'auto off', 'auto on', 'cal'].map((c) => <Btn key={c} kind="secondary" onClick={() => cmd(c)}>{c}</Btn>)}
            </div>
            <div className="rig-cmds">
              <span className="rig-cmd-k">Simulated only</span>
              {['sim power off', 'sim power on', 'sim fault inlet_top', 'sim fault clear', 'sim heat high', 'sim heat normal', 'sim fan_a fail', 'sim fan_a ok', 'sim supply loss', 'sim supply ok', 'sim leak remote', 'sim leak stop', 'sim spill', 'sim dry', 'sim block outlet', 'sim unblock'].map((c) => <Btn key={c} kind="ghost" disabled={!sim} onClick={() => cmd(c)}>{c.replace('sim ', '')}</Btn>)}
            </div>
            {reply && <p className="mono small muted">{reply}</p>}
            <p className="muted small">With auto on, the rig closes the flap and the valve itself — on the Arduino, so it still works if the laptop dies.</p>
          </section>
        </div>
      )}

      <h2 className="page-h2">Scans</h2>
      <table className="table">
        <thead><tr><th>Time</th><th>Asset · point</th><th>Hold</th><th>Key value</th><th>Quality</th><th>Source</th></tr></thead>
        <tbody>
          {[...b.scans].reverse().slice(0, 20).map((s) => {
            const c = s.channels;
            const key = s.point.startsWith('Floor') && c.floor_wet ? (c.floor_wet.mean >= 0.5 ? 'WET' : 'dry')
              : c.inlet_bottom_c ? `${(((c.inlet_top_c?.mean ?? c.inlet_bottom_c.mean) + c.inlet_bottom_c.mean) / 2).toFixed(2)} °C inlet`
              : c.outlet_c ? `${c.outlet_c.mean.toFixed(2)} °C outlet` : '—';
            return (
              <tr key={s.id}>
                <td className="mono">{new Date(s.endedAt).toLocaleTimeString()}</td>
                <td><span className="mono">{s.assetId}</span> · {s.point}</td>
                <td className="mono">{s.durationS.toFixed(1)} s · {s.frames} fr</td>
                <td className="mono">{key}</td>
                <td className="small">{s.quality.join(', ') || '—'}</td>
                <td><span className="src mono">{s.source === 'live' ? 'LIVE' : 'SIM'}</span></td>
              </tr>
            );
          })}
          {b.scans.length === 0 && <tr><td colSpan={6} className="muted">No scans yet. Open the scanner and hold to scan.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function Row({ k, v, u, sub, digits = 2 }: { k: string; v: number | null; u: string; sub: string; digits?: number }) {
  return <tr><th>{k}</th><td className="mono">{v == null ? '—' : v.toFixed(digits)} <span className="muted">{u}</span></td><td className="muted small">{sub}</td></tr>;
}

function Events({ events }: { events: RigEvent[] }) {
  const list = [...events].reverse().slice(0, 8);
  if (!list.length) return <p className="muted">No events. Stage one on the right, or let the rig run.</p>;
  return (
    <ol className="rig-events">
      {list.map((e) => (
        <li key={e.id}>
          <div className="rig-ev-h">
            <strong>{e.kind.replace(/_/g, ' ')}</strong>
            <span className={`tag rig-conf-${e.confidence}`}>{e.confidence}</span>
            <span className="tag">{e.route === 'none' ? 'no page' : `page ${e.route}`}</span>
            <span className="mono muted small">{new Date(e.at).toLocaleTimeString()}</span>
          </div>
          <div>{e.rootCause}</div>
          {e.action && <div className="small">Action: {e.action}{e.actionConfirmed === true ? ' — confirmed' : e.actionConfirmed === false ? ' — not confirmed' : ''}</div>}
          {e.timeToLimitMin != null && <div className="mono small">time to limit ≈ {e.timeToLimitMin.toFixed(1)} min at current slope</div>}
          <div className="muted small">{e.evidence.join(' · ')}</div>
        </li>
      ))}
    </ol>
  );
}

/** Monochrome line chart: solid = acoustic beams, dashed blue = reference. Direct labels, no legend box. */
function TempChart({ frames }: { frames: StampedFrame[] }) {
  const data = frames.slice(-180);
  const series = useMemo(() => [
    { key: 'Outlet', get: (f: StampedFrame) => f.outlet_c, cls: 'ln-out' },
    { key: 'Inlet top', get: (f: StampedFrame) => f.inlet_top_c, cls: 'ln-top' },
    { key: 'Inlet bottom', get: (f: StampedFrame) => f.inlet_bottom_c, cls: 'ln-bot' },
    { key: 'Reference', get: (f: StampedFrame) => f.ref_c, cls: 'ln-ref' },
  ], []);
  const W = 640, H = 220, L = 36, R = 96, T = 10, B = 22;
  const vals = data.flatMap((f) => series.map((s) => s.get(f))).filter((v): v is number => v != null);
  if (data.length < 2 || !vals.length) return <p className="muted">Collecting frames…</p>;
  const lo = Math.floor(Math.min(...vals) - 0.5), hi = Math.ceil(Math.max(...vals) + 0.5);
  const x = (i: number) => L + (i / (data.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
  // direct end-labels, nudged apart so lines that sit together stay readable
  const labels = series.flatMap((s) => {
    const lastI = data.map(s.get).findLastIndex((v) => v != null);
    const v = lastI >= 0 ? s.get(data[lastI]) : null;
    return v == null ? [] : [{ key: s.key, cls: s.cls, v, y: y(v) }];
  }).sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 13);
  return (
    <svg className="rig-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Acoustic beam temperatures and reference probe over the last three minutes">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="grid" />
          <text x={L - 6} y={y(v) + 4} textAnchor="end" className="axis">{v.toFixed(0)}</text>
        </g>
      ))}
      <text x={L} y={H - 4} className="axis">−{Math.round((Date.parse(data.at(-1)!.at) - Date.parse(data[0].at)) / 1000)} s</text>
      <text x={W - R} y={H - 4} textAnchor="end" className="axis">now</text>
      {series.map((s) => {
        let d = '', pen = false;
        data.forEach((f, i) => { const v = s.get(f); if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`; pen = true; });
        return (
          <g key={s.key}>
            <path d={d} className={`ln ${s.cls}`} />
          </g>
        );
      })}
      {labels.map((l) => <text key={l.key} x={W - R + 8} y={l.y + 4} className={`lbl ${l.cls}`}>{l.key} {l.v.toFixed(1)}</text>)}
    </svg>
  );
}
