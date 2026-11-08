/**
 * Phone dashboard (#/m) — the supervisor's pocket view of the same shared record the desktop
 * workspace (#/app) uses. Read-mostly: it ranks, counts and shows; the only writes are the same
 * ones the desktop already makes (scenario play/pause, director run, approve/reject).
 * Facility data is simulated and labeled so; rig numbers come straight from bridge frames.
 */
import { useMemo, useState } from 'react';
import { facility } from '../domain/fixture';
import { rankIncidents } from '../domain/engine';
import type { Incident, PriorityResult } from '../domain/types';
import { makeEvent, useOps, wallClock } from '../state/store';
import { api, deviceLabel, useBridge, useFrameAge } from '../state/bridge';
import { assetById, checkinState, clocksForIncident, groupClocks, ROLE_LABEL, visibleClocks, zoneById } from '../state/selectors';
import { EvidenceTag, SevMark, Src } from '../components/primitives';
import { ScanIngest } from '../views/ScanIngest';
import { SERVICE_LABEL, type DirectorResultView, type PendingActionView } from '../views/directorTypes';
import { ageText, clockSeverity, clockText, deltaT, nextClock, openIncidents, rigTiles, sortTasks, sparkRange, sparkSegments, statusText, taskBucket, taskCounts } from './derive';
import './mobile.css';

type Tab = 'now' | 'rig' | 'director' | 'team';
const TABS: { id: Tab; label: string }[] = [
  { id: 'now', label: 'Now' },
  { id: 'rig', label: 'Rig' },
  { id: 'director', label: 'Director' },
  { id: 'team', label: 'Team' },
];

export function MobileApp({ route }: { route: string }) {
  const tab: Tab = (TABS.find((t) => t.id === route)?.id) ?? 'now';
  const { state, dispatch, run, scenario, visibleIncidents } = useOps();
  const b = useBridge();
  const age = useFrameAge(b.latest);
  const dev = deviceLabel(b.status, b.online);
  const t = state.t;

  const clocks = useMemo(() => visibleClocks(run.clocks, scenario, t), [run, scenario, t]);
  const open = useMemo(() => openIncidents(visibleIncidents), [visibleIncidents]);
  const ranked = useMemo(
    () => rankIncidents(open, { facility, clocks: Object.fromEntries(clocks.map((c) => [c.assetId, c])), now: t, tasks: state.tasks, employees: state.employees }),
    [open, clocks, t, state.tasks, state.employees],
  );
  const pending = b.actions.filter((a) => a.status === 'pending');
  const dirKind = !b.online ? 'off' : b.status?.nemotron.configured ? 'nemotron' : 'local';

  const badge: Partial<Record<Tab, number>> = { now: ranked.length, director: pending.length, rig: b.requests.length };

  return (
    <div className="m-root">
      <ScanIngest />
      <header className="m-top">
        <div className="m-top-row">
          <a className="m-brand" href="#/">Lookahead</a>
          <span className="m-site mono">DAL-1 · Hall A</span>
          <span className="m-sim" title={scenario.basis}>SIMULATED</span>
        </div>
        <div className="m-top-row m-top-meta">
          <span className="m-clock mono" aria-label="Scenario clock">{wallClock(t)}<small> T+{Math.floor(t)}</small></span>
          <a className={`m-pill m-pill-${dev.kind}`} href="#/m/rig" title={dev.text}>
            <i aria-hidden="true" />{dev.kind === 'live' ? 'Rig live' : dev.kind === 'sim' ? 'Rig sim' : 'Rig offline'}
            {age != null && dev.kind !== 'off' && age > 3 ? <em> {Math.round(age)}s</em> : null}
          </a>
          <a className={`m-pill m-pill-dir-${dirKind}`} href="#/m/director" title={b.status?.nemotron.model}>
            <i aria-hidden="true" />{dirKind === 'nemotron' ? 'Nemotron' : dirKind === 'local' ? 'Local planner' : 'Director offline'}
          </a>
        </div>
      </header>

      <main className="m-main" key={tab}>
        {tab === 'now' && <NowTab ranked={ranked} incidents={open} clocks={clocks} />}
        {tab === 'rig' && <RigTab />}
        {tab === 'director' && <DirectorTab top={open.find((i) => i.id === ranked[0]?.incidentId) ?? null} />}
        {tab === 'team' && <TeamTab />}
        <footer className="m-foot">
          <a href="#/app">Open desktop workspace</a>
          <a href="#/scan">Scanner</a>
          <a href="#/app/handoff">Handoff</a>
        </footer>
      </main>

      <nav className="m-tabs" aria-label="Phone dashboard">
        {TABS.map((x) => (
          <a key={x.id} href={`#/m${x.id === 'now' ? '' : '/' + x.id}`} className={tab === x.id ? 'is-active' : ''} aria-current={tab === x.id ? 'page' : undefined}>
            <TabIcon id={x.id} />
            <span>{x.label}</span>
            {!!badge[x.id] && <b className="m-badge mono" aria-label={`${badge[x.id]} items`}>{badge[x.id]}</b>}
          </a>
        ))}
      </nav>
      {/* scenario playback rides above the tab bar: it is the demo's shared clock */}
      <div className="m-play">
        <button className="m-play-btn" onClick={() => dispatch({ type: 'play', playing: !state.playing })} aria-label={state.playing ? 'Pause scenario' : 'Play scenario'}>
          {state.playing ? <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" fill="currentColor" /><rect x="9.5" y="2" width="3.5" height="12" fill="currentColor" /></svg>
            : <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 2 L14 8 L4 14 Z" fill="currentColor" /></svg>}
        </button>
        <div className="m-play-track" aria-hidden="true"><span style={{ width: `${(t / scenario.horizonMin) * 100}%` }} /></div>
        <span className="mono m-play-t">{scenario.name}</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- Now

function NowTab({ ranked, incidents, clocks }: { ranked: PriorityResult[]; incidents: Incident[]; clocks: ReturnType<typeof visibleClocks> }) {
  const { state, scenario } = useOps();
  const t = state.t;
  const groups = useMemo(() => groupClocks(clocks, t), [clocks, t]);
  const [openId, setOpenId] = useState<string | null>(null);
  const { requests } = useBridge();

  return (
    <>
      <section className="m-sec" aria-label="Impact clocks">
        <h2 className="m-h">Time to impact <span className="m-h-sub">engine · p50 (p10–p90) min</span></h2>
        {groups.length === 0 ? (
          <div className="m-quiet">No running clocks. Every fresh reading is within limits{t === 0 ? ' — press play to run the scenario.' : '.'}</div>
        ) : (
          <div className="m-clocks">
            {groups.slice(0, 4).map((g) => {
              const ct = clockText(g.clock, t, scenario.horizonMin);
              return (
                <div key={g.key} className={`m-clock-tile ${ct.lost ? 'is-lost' : ''}`}>
                  <div className="m-clock-h"><SevMark sev={clockSeverity(g.clock, t)} /><span>{g.label}</span>{g.count > 1 && <span className="mono m-muted">×{g.count}</span>}</div>
                  <div className="m-clock-v mono">{ct.main}{!ct.lost && <small> min</small>}</div>
                  <div className="m-clock-r mono">{ct.range ? `(${ct.range})` : ' '}</div>
                  <div className="m-clock-d">{g.detail}</div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="m-sec" aria-label="Ranked response queue">
        <h2 className="m-h">Response queue <span className="m-h-sub">policy P-demo · illustrative weights</span></h2>
        {ranked.length === 0 && <div className="m-quiet">Nothing needs attention.</div>}
        <ol className="m-list">
          {ranked.map((p, i) => {
            const inc = incidents.find((x) => x.id === p.incidentId)!;
            const first = nextClock(clocksForIncident(inc, clocks), t);
            const ct = first ? clockText(first, t, scenario.horizonMin) : null;
            const task = state.tasks.find((x) => x.incidentId === inc.id && x.status !== 'completed' && x.status !== 'cancelled');
            const owner = state.employees.find((e) => e.id === inc.ownerId);
            const lead = state.employees.find((e) => e.id === inc.shiftLeadId);
            const expanded = openId === inc.id;
            // only offer a scan the dashboard or director actually asked for (the rig can't verify everything, e.g. vibration)
            const req = requests.find((r) => r.incidentId === inc.id || inc.alertAssetIds.includes(r.assetId) || r.assetId === inc.rootAssetId);
            const factors = [...p.factors].sort((a, b) => b.score * b.weight - a.score * a.weight);
            return (
              <li key={inc.id} className={`m-inc m-inc-${inc.severity} ${expanded ? 'is-open' : ''}`}>
                <button className="m-inc-btn" onClick={() => setOpenId(expanded ? null : inc.id)} aria-expanded={expanded}>
                  <span className="m-inc-rank mono">{i + 1}</span>
                  <span className="m-inc-body">
                    <span className="m-inc-title"><SevMark sev={inc.severity} /> <span>{inc.title}</span></span>
                    <span className="m-inc-meta">
                      <EvidenceTag v={inc.evidence} />
                      {ct && first && <span className={`mono m-inc-clock ${ct.lost ? 'is-lost' : ''}`}>{ct.lost ? 'impact' : ct.main}{ct.range ? ` (${ct.range})` : ''} · {assetById.get(first.assetId)?.id}</span>}
                    </span>
                    <span className="m-inc-next"><span className="m-k">Next</span>{task ? `${task.title} — ${statusText(task.status)}` : p.resolvingCheck ?? 'Create a task on the desktop'}</span>
                  </span>
                  <span className="m-inc-score mono" title="Priority total (illustrative weights)">{Math.round(p.total * 100)}</span>
                </button>
                {expanded && (
                  <div className="m-inc-more">
                    <p>{inc.summary}</p>
                    <dl className="m-factors">
                      {factors.map((f) => (
                        <div key={f.key}>
                          <dt>{f.label}<span className="mono"> {Math.round(f.score * f.weight * 100)}</span></dt>
                          <dd><span className="m-bar" aria-hidden="true"><span style={{ width: `${Math.round(f.score * 100)}%` }} /></span>{f.note}</dd>
                        </div>
                      ))}
                    </dl>
                    <p className="m-small">Owner {owner ? owner.name : <>unassigned — {lead?.name ?? 'shift lead'} (shift lead) holds it</>}</p>
                    <div className="m-actions">
                      {task?.ownerId && <a className="m-btn m-btn-primary" href={`#/app/field/${task.id}`}>Technician view</a>}
                      {req && <a className="m-btn m-btn-primary" href={`#/scan?asset=${req.assetId}`}>Scan {req.assetId} · requested</a>}
                      <a className="m-btn m-btn-ghost" href="#/app">Open on desktop</a>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </section>
    </>
  );
}

// ------------------------------------------------------------------- Rig

function RigTab() {
  const b = useBridge();
  const age = useFrameAge(b.latest);
  const dev = deviceLabel(b.status, b.online);
  const f = b.latest;
  const recent = b.frames.slice(-90);
  // the check that matters: acoustic inlet beams vs the DS18B20 reference beside them
  const series = [
    { key: 'inlet_top', label: 'Inlet top', vals: recent.map((x) => x.inlet_top_c), cls: 'b' },
    { key: 'inlet_bottom', label: 'Inlet bottom', vals: recent.map((x) => x.inlet_bottom_c), cls: 'a' },
    { key: 'ref', label: 'Reference', vals: recent.map((x) => x.ref_c), cls: 'c' },
  ];
  const W = 320, H = 96;
  const scale = sparkRange(series.flatMap((s) => s.vals)); // one shared axis for all series
  const events = [...b.events].reverse().slice(0, 5);

  if (!b.online) {
    return (
      <section className="m-sec">
        <h2 className="m-h">Rack Monitor</h2>
        <div className="m-quiet">The bridge isn't reachable. Start it on the laptop with <code>npm run dev:lan</code> and open this page on the same Wi-Fi.</div>
      </section>
    );
  }

  return (
    <>
      <section className="m-sec">
        <h2 className="m-h">Rack Monitor <span className={`m-src m-src-${dev.kind}`}>{dev.kind === 'live' ? 'LIVE' : dev.kind === 'sim' ? 'SIMULATED' : 'NO DEVICE'}</span></h2>
        <div className="m-kv">
          <span>Link</span><span className="mono">{dev.text}</span>
          <span>Last frame</span><span className="mono">{ageText(age)}</span>
          <span>Firmware</span><span className="mono">{b.status?.device.firmware ?? '—'}</span>
        </div>
        {f && (
          <div className="m-tiles">
            {rigTiles(f).map((x) => (
              <div key={x.key} className={`m-tile ${x.abnormal ? 'is-abnormal' : ''} ${x.missing ? 'is-missing' : ''}`}>
                <div className="m-tile-k">{x.abnormal && <SevMark sev="warning" size={12} />}{x.label}</div>
                <div className="m-tile-v mono">{x.value}<small>{x.unit ? ` ${x.unit}` : ''}</small></div>
                <div className="m-tile-s mono">{x.sub}</div>
              </div>
            ))}
          </div>
        )}
        {f && (
          <div className="m-kv m-kv-tight">
            <span>ΔT outlet−inlet</span><span className="mono">{deltaT(f) == null ? '—' : `${deltaT(f)} °C`}</span>
            <span>Actuators</span><span className="mono">flap {f.flap} · valve {f.valve} · fans {f.fan_pct.join('/')}% · auto {f.auto ? 'on' : 'off'}</span>
            {f.flags.length > 0 && <><span>Flags</span><span className="mono m-warn">{f.flags.join(', ')}</span></>}
          </div>
        )}
      </section>

      {scale && (
        <section className="m-sec">
          <h2 className="m-h">Inlet air <span className="m-h-sub">last {recent.length} frames · acoustic beams vs reference probe</span></h2>
          <svg className="m-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Temperature trend">
            {series.map((s) => {
              const seg = sparkSegments(s.vals, W, H, scale)?.segments ?? [];
              return seg.map((pts, i) => <polyline key={`${s.key}-${i}`} className={`m-spark-${s.cls}`} points={pts} fill="none" vectorEffect="non-scaling-stroke" />);
            })}
          </svg>
          <div className="m-legend">
            {series.map((s) => <span key={s.key}><i className={`m-spark-${s.cls}`} />{s.label}</span>)}
            <span className="mono m-muted">{scale.min.toFixed(1)}–{scale.max.toFixed(1)} °C</span>
          </div>
        </section>
      )}

      <section className="m-sec">
        <h2 className="m-h">Scan requests <span className="m-h-sub">{b.requests.length} open</span></h2>
        {b.requests.length === 0 && <div className="m-quiet">No open requests.</div>}
        <ul className="m-rows">
          {b.requests.map((r) => (
            <li key={r.id}>
              <a className="m-row" href={`#/scan?asset=${r.assetId}`}>
                <span className="m-row-main"><strong className="mono">{r.assetId}</strong><span>{r.point}</span><span className="m-row-sub">{r.reason}</span><span className="m-row-sub mono">{r.id} · by {r.requestedBy}</span></span>
                <span className="m-chev" aria-hidden="true">›</span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section className="m-sec">
        <h2 className="m-h">Rig events <span className="m-h-sub">rules, not a model</span></h2>
        {events.length === 0 && <div className="m-quiet">No root-cause events.</div>}
        <ul className="m-rows">
          {events.map((e) => (
            <li key={e.id} className="m-row m-row-static">
              <span className="m-row-main"><span><strong>{e.kind.replace(/_/g, ' ')}</strong> <span className="m-muted m-small">{e.confidence} confidence · {new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></span><span className="m-row-sub">{e.rootCause}</span>{e.action && <span className="m-row-sub mono">{e.action}{e.actionConfirmed ? ' · confirmed' : ''}</span>}</span>
              <Src s={e.source} />
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

// ------------------------------------------------------------------- Director

function DirectorTab({ top }: { top: Incident | null }) {
  const { state, dispatch } = useOps();
  const b = useBridge();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const latest = b.plans.at(-1) ?? null;
  const res = latest?.result ?? null;
  const pending = b.actions.filter((a) => a.status === 'pending');
  const decided = b.actions.filter((a) => a.status !== 'pending').slice(-3).reverse();

  const run = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api<DirectorResultView>('/api/director', {
        scenarioId: state.scenarioId, t: state.t,
        incidents: state.incidents.filter((i) => i.openedAt <= state.t && i.status !== 'resolved'),
        scans: b.scans.slice(-20), confirmedEdgeIds: state.confirmedEdgeIds,
        question: top ? `Focus incident: ${top.id} ${top.title}` : undefined,
      });
      const ext = r.steps.filter((s) => s.service).map((s) => SERVICE_LABEL[s.service!]);
      dispatch({ type: 'append_event', event: makeEvent(state.t, {
        kind: 'analysis', actor: r.provider === 'nemotron' ? `Nemotron (${r.model})` : 'local planner',
        summary: `Simulation director plan ${r.generation ?? 1} (from phone): ${Object.keys(r.runs ?? {}).length} engine runs${ext.length ? `, ${[...new Set(ext)].join(' + ')}` : ''} → ${r.recommendation.nextScan ? `scan ${r.recommendation.nextScan.assetId}` : r.recommendation.nextAction.slice(0, 80)}`,
        links: { incidentId: top?.id }, source: r.provider === 'nemotron' ? 'nemotron' : 'local_rules',
      }) });
    } catch (e) {
      setErr(b.online ? (e as Error).message : 'Bridge offline — the director runs on the bridge.');
    } finally { setBusy(false); }
  };

  return (
    <>
      <section className="m-sec">
        <h2 className="m-h">Simulation director <span className="m-h-sub">{b.status?.nemotron.configured ? b.status.nemotron.model : 'local planner (no key)'}</span></h2>
        {(busy || b.replanning) && <div className="m-busy mono">{b.replanning ? `Re-planning automatically — plan ${b.replanning.generation}…` : 'Planning simulations…'}</div>}
        {err && <p className="m-warn m-small">{err}</p>}
        {!res && !busy && <p className="m-small m-muted">Nemotron picks which what-if simulations to run and which scan would most change the plan. The engine computes every number; hardware commands and tickets wait for a person.</p>}
        {res && latest && (
          <div className="m-plan">
            <div className="m-plan-h">
              <span className="mono m-plan-gen">Plan {latest.generation}</span>
              <span className="m-small">{latest.trigger === 'operator' ? 'requested by operator' : `auto re-plan after ${latest.trigger.replace('scan:', '')}`}</span>
              <span className="m-plan-src"><Src s={res.provider === 'nemotron' ? 'nemotron' : 'local_rules'} /> <span className="mono m-muted">{(res.elapsedMs / 1000).toFixed(1)} s</span></span>
            </div>
            {res.fallbackReason && <p className="m-small m-muted">{res.fallbackReason}</p>}
            <div className="m-rec">
              <div className="m-k">Next scan</div>
              {res.recommendation.nextScan ? (
                <>
                  <div className="m-rec-v"><strong className="mono">{res.recommendation.nextScan.assetId}</strong> · {res.recommendation.nextScan.point} · hold {res.recommendation.nextScan.holdS} s</div>
                  <div className="m-small">{res.recommendation.nextScan.reason}</div>
                  <a className="m-btn m-btn-primary" href={`#/scan?asset=${res.recommendation.nextScan.assetId}`}>Open scanner</a>
                </>
              ) : <div className="m-small m-muted">No scan would change the order right now.</div>}
              <div className="m-k">Then</div>
              <div className="m-small">{res.recommendation.nextAction}</div>
            </div>
            <p className="m-small">{res.recommendation.summary}</p>
            <details className="m-steps">
              <summary>{res.steps.length} tool calls · {Object.keys(res.runs ?? {}).length} engine runs</summary>
              <ol>
                {res.steps.map((s, i) => (
                  <li key={i} className={s.ok ? '' : 'is-err'}>
                    <span className="mono">{s.tool}</span>{s.service && <span className="m-svc mono">{SERVICE_LABEL[s.service]}</span>}
                    <div className="m-small m-muted">{s.summary}</div>
                  </li>
                ))}
              </ol>
            </details>
          </div>
        )}
        <button className="m-btn m-btn-secondary m-btn-block" onClick={run} disabled={busy || !b.online}>{res ? 'Run again' : 'Run simulation director'}</button>
      </section>

      <section className="m-sec">
        <h2 className="m-h">Awaiting approval <span className="m-h-sub">{pending.length} pending</span></h2>
        {pending.length === 0 && <div className="m-quiet">Nothing pending.</div>}
        {pending.map((a) => <ApprovalCard key={a.id} a={a} />)}
        {decided.length > 0 && (
          <ul className="m-rows">
            {decided.map((a) => (
              <li key={a.id} className="m-row m-row-static">
                <span className="m-row-main">
                  <span className={`m-status m-status-${a.status}`}>{a.status}</span>{' '}
                  {a.kind === 'rig_command' ? <span className="mono">{(a.payload as { cmd: string }).cmd}</span> : (a.payload as { title: string }).title}
                  <span className="m-row-sub">{a.url ? <a href={a.url} target="_blank" rel="noopener">GitHub issue</a> : a.result}{a.decidedBy ? ` · ${a.decidedBy}` : ''}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function ApprovalCard({ a }: { a: PendingActionView }) {
  const { state, dispatch } = useOps();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const label = a.kind === 'rig_command' ? (a.payload as { cmd: string }).cmd : (a.payload as { title: string }).title;
  const decide = async (d: 'approve' | 'reject') => {
    setBusy(true); setErr('');
    try {
      const r = await api<PendingActionView>(`/api/actions/${a.id}/${d}`, { by: 'Priya Raman' });
      dispatch({ type: 'append_event', event: makeEvent(state.t, { kind: 'note', actor: 'Priya Raman', summary: `${d === 'approve' ? 'Approved' : 'Rejected'} (phone) ${a.kind === 'rig_command' ? `rig command "${label}"` : `ticket "${label}"`} proposed by ${a.proposedBy} → ${r.status}${r.result ? ` (${r.result})` : ''}`, links: { incidentId: a.incidentId }, source: 'operator' }) });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="m-approve">
      <div className="m-approve-h"><span className="m-tag">{a.kind === 'rig_command' ? 'rig command' : 'ticket'}</span><strong className={a.kind === 'rig_command' ? 'mono' : ''}>{label}</strong></div>
      <div className="m-small">{a.reason}</div>
      <div className="m-small m-muted">Proposed by {a.proposedBy}{a.incidentId ? ` · ${a.incidentId}` : ''}</div>
      {err && <div className="m-small m-warn">{err}</div>}
      <div className="m-actions m-actions-split">
        <button className="m-btn m-btn-primary" disabled={busy} onClick={() => decide('approve')}>Approve</button>
        <button className="m-btn m-btn-ghost" disabled={busy} onClick={() => decide('reject')}>Reject</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- Team

function TeamTab() {
  const { state } = useOps();
  const t = state.t;
  const counts = taskCounts(state.tasks);
  const tasks = sortTasks(state.tasks);
  return (
    <>
      <section className="m-sec">
        <h2 className="m-h">Tasks</h2>
        <div className="m-counts">
          {([['open', 'Open'], ['field', 'In field'], ['blocked', 'Blocked'], ['review', 'Review'], ['done', 'Done']] as const).map(([k, l]) => (
            <div key={k} className={`m-count ${k === 'blocked' && counts.blocked ? 'is-warn' : ''}`}><span className="mono">{counts[k]}</span>{l}</div>
          ))}
        </div>
        {tasks.length === 0 && <div className="m-quiet">No tasks yet.</div>}
        <ul className="m-rows">
          {tasks.map((x) => {
            const owner = state.employees.find((e) => e.id === x.ownerId);
            const missing = x.checklist.filter((s) => s.required && !s.result).length;
            const bucket = taskBucket(x.status);
            const body = (
              <>
                <span className="m-row-main">
                  <span className="m-row-top"><span className={`m-status m-status-${bucket}`}>{statusText(x.status)}</span><span className="mono m-muted">{x.id}</span></span>
                  <strong>{x.title}</strong>
                  <span className="m-row-sub"><span className="mono">{assetById.get(x.assetId)?.id ?? x.assetId}</span> · {owner?.name ?? 'unowned — shift lead holds it'}</span>
                  {x.blocker && <span className="m-row-sub m-warn">Blocked: {x.blocker}</span>}
                  <span className="m-row-sub">{missing ? `${missing} required step${missing > 1 ? 's' : ''} without evidence` : 'Checklist evidence complete'}{x.reviewRequired ? ' · review' : ''}</span>
                </span>
                {x.ownerId && <span className="m-chev" aria-hidden="true">›</span>}
              </>
            );
            return <li key={x.id}>{x.ownerId ? <a className="m-row" href={`#/app/field/${x.id}`}>{body}</a> : <div className="m-row m-row-static">{body}</div>}</li>;
          })}
        </ul>
      </section>

      <section className="m-sec">
        <h2 className="m-h">On shift <span className="m-h-sub">check-ins are manual or QR — not tracking</span></h2>
        <ul className="m-rows">
          {state.employees.map((e) => {
            const ci = checkinState(e, t);
            return (
              <li key={e.id} className="m-row m-row-static">
                <span className="m-avatar mono" aria-hidden="true">{e.initials}</span>
                <span className="m-row-main">
                  <strong>{e.name}</strong>
                  <span className="m-row-sub">{ROLE_LABEL[e.role]} · {e.skills.join(', ')}</span>
                  <span className="m-row-sub">
                    {e.location ? <>{zoneById.get(e.location.zoneId)?.name ?? e.location.zoneId} · {ci === 'stale' ? <span className="m-stale mono">STALE</span> : 'checked in'} {Math.max(0, Math.round(t - e.location.t))} min ago</> : 'no check-in'}
                  </span>
                </span>
                <span className={`m-avail m-avail-${e.availability}`}>{e.availability.replace('_', ' ')}</span>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

// ------------------------------------------------------------------- icons

function TabIcon({ id }: { id: Tab }) {
  const p = { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true } as const;
  if (id === 'now') return <svg {...p}><circle cx="10" cy="10" r="7.25" /><path d="M10 5.5V10l3 2" /></svg>;
  if (id === 'rig') return <svg {...p}><rect x="4" y="2.75" width="12" height="14.5" /><path d="M7 6.5h6M7 10h6M7 13.5h3" /></svg>;
  if (id === 'director') return <svg {...p}><path d="M3 15.5 8 9l3.5 3.5L17 4.5" /><path d="M13 4.5h4v4" /></svg>;
  return <svg {...p}><circle cx="7" cy="7" r="2.75" /><circle cx="14" cy="8" r="2.25" /><path d="M2.5 16.5c.6-2.8 2.4-4.25 4.5-4.25s3.9 1.45 4.5 4.25M12 12.6c.6-.25 1.3-.35 2-.35 1.8 0 3.2 1.2 3.6 3.75" /></svg>;
}
