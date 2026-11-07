import { useMemo, useState } from 'react';
import { facility, referenceFixtures, runbooks, changeLog } from '../domain/fixture';
import { compareReadings, findRoute, suggestAssignees, transition } from '../domain/engine';
import type { ImpactClock, Incident, PriorityResult, Reading, Task, VerificationSession } from '../domain/types';
import { makeEvent, relMin, useOps, wallClock, type Selection } from '../state/store';
import { assetById, checkinState, clocksForIncident, latestFor, METRIC_LABEL, ROLE_LABEL, serviceById, waypointById, zoneById } from '../state/selectors';
import { BarBand, Btn, Countdown, EvidenceTag, FreshTag, Section, SevMark, Src, verdictLabel } from '../components/primitives';
import { analyzeIncident } from './analysis';
import { DirectorPanel } from './DirectorPanel';
import { api, useBridge } from '../state/bridge';

interface Props { sel: Selection; setSel: (s: Selection) => void; clocks: ImpactClock[]; ranked: PriorityResult[] }

export function Inspector({ sel, setSel, clocks, ranked }: Props) {
  if (!sel) return <div className="insp-empty">Select an incident, asset, person or task.</div>;
  if (sel.kind === 'incident') return <IncidentPanel id={sel.id} setSel={setSel} clocks={clocks} ranked={ranked} />;
  if (sel.kind === 'asset') return <AssetPanel id={sel.id} setSel={setSel} />;
  if (sel.kind === 'task') return <TaskPanel id={sel.id} setSel={setSel} />;
  return <EmployeePanel id={sel.id} setSel={setSel} />;
}

// ------------------------------------------------------------------ incident

function IncidentPanel({ id, setSel, clocks, ranked }: { id: string; setSel: Props['setSel']; clocks: ImpactClock[]; ranked: PriorityResult[] }) {
  const { state, dispatch, run } = useOps();
  const t = state.t;
  const inc = state.incidents.find((i) => i.id === id);
  const pr = ranked.find((r) => r.incidentId === id);
  const [showAnalysis, setShowAnalysis] = useState(false);
  if (!inc) return null;
  const incClocks = clocksForIncident(inc, clocks);
  const critical = incClocks.filter((c) => c.p50 == null || c.p50 > t - 1).slice(0, 4);
  const why = incClocks.sort((a, b) => b.path.length - a.path.length)[0];
  const tasks = state.tasks.filter((x) => x.incidentId === inc.id);
  const lead = state.employees.find((e) => e.id === inc.shiftLeadId);
  const owner = state.employees.find((e) => e.id === inc.ownerId);
  const sessions = state.verifications.filter((v) => v.incidentId === inc.id);
  const asset = assetById.get(inc.rootAssetId)!;
  const readings = run.readingsAt(t).concat(state.capturedReadings.filter((r) => r.t <= t));

  const createTask = () => {
    const rb = runbooks.find((r) => r.id === inc.runbookId);
    const nid = `TSK-${200 + state.tasks.length + 1}`;
    const task: Task = {
      id: nid, type: inc.rootAssetId === 'PIPE-L2' || inc.id === 'INC-1045' ? 'inspect' : 'verify',
      title: rb ? rb.title : `Inspect ${inc.rootAssetId}`, incidentId: inc.id, assetId: inc.id === 'INC-1044' ? 'PIPE-L2' : inc.rootAssetId,
      requiredSkills: inc.id === 'INC-1045' ? ['battery'] : inc.id === 'INC-1044' ? ['leak_response'] : ['cooling'],
      status: 'unassigned', estimateMin: 12,
      checklist: (rb?.steps ?? ['Confirm asset ID', 'Inspect and record findings']).map((text, i) => ({ id: `${nid}-${i + 1}`, text, required: i < 3, evidenceIds: [] })),
      reviewRequired: true, assetConfirmed: false, prerequisites: [], priorityReason: pr?.factors.slice().sort((a, b) => b.score * b.weight - a.score * a.weight)[0]?.note ?? inc.summary, version: 1,
    };
    dispatch({ type: 'upsert_task', task, event: makeEvent(t, { kind: 'task', actor: 'Priya Raman', summary: `Task created: ${task.title} (${rb ? `${rb.id} ${rb.version}` : 'no runbook'})`, links: { taskId: nid, incidentId: inc.id, assetId: task.assetId }, source: 'operator' }) });
    setSel({ kind: 'task', id: nid });
  };

  const setStatus = (status: Incident['status']) => {
    dispatch({ type: 'upsert_incident', incident: { ...inc, status }, event: makeEvent(t, { kind: 'incident', actor: 'Priya Raman', summary: `${inc.id} marked ${status}${status === 'resolved' ? ' (authorized decision)' : ''}`, links: { incidentId: inc.id }, source: 'operator' }) });
  };

  return (
    <div className="insp">
      <header className="insp-h insp-h-inverse">
        <div className="insp-kicker mono">{inc.id} · opened {wallClock(inc.openedAt)} · {Math.max(0, Math.round(t - inc.openedAt))} min</div>
        <h2><SevMark sev={inc.severity} label /> {inc.title}</h2>
        <div className="insp-tags">
          <EvidenceTag v={inc.evidence} />
          <span className="tag">{inc.status}</span>
          <span className="insp-owner">Owner: {owner?.name ?? 'unassigned'} · Lead: {lead?.name}</span>
        </div>
      </header>

      <p className="insp-summary">{inc.summary}</p>

      {critical.length > 0 && (
        <Section title="How long do we have" aside={<span className="pane-sub">Monte Carlo · 400 runs · ranges</span>}>
          <div className="clock-list">
            {critical.map((c) => (
              <button key={c.assetId} className="clock-row" onClick={() => setSel({ kind: 'asset', id: c.assetId })}>
                <span className="clock-row-id mono">{c.assetId}</span>
                <Countdown clock={c} now={t} compact />
              </button>
            ))}
          </div>
        </Section>
      )}

      {why && (
        <Section title="Why — the chain behind the clock">
          <ol className="chain">
            {why.path.map((aid, i) => {
              const next = why.path[i + 1];
              const edge = next ? [...facility.edges, ...run.derivedEdges].find((e) => e.from === aid && e.to === next) : undefined;
              return (
                <li key={aid + i}>
                  <button className="chain-node" onClick={() => setSel({ kind: 'asset', id: aid })}><span className="mono">{aid}</span> {assetById.get(aid)?.name}</button>
                  {edge && (
                    <div className="chain-edge">
                      <span className="mono">{edge.kind.replace('_', ' ')} · {edge.delay.min}–{edge.delay.max} min</span>
                      <span className={`basis basis-${edge.basisKind}`}>{edge.basisKind}</span>
                      <span className="chain-basis">{edge.basis}</span>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          {why.weakestAssumption && <p className="weak"><strong>Most likely to be wrong:</strong> {why.weakestAssumption}</p>}
        </Section>
      )}

      {pr && (
        <Section title="Priority breakdown" aside={<span className="pane-sub mono">{pr.policyVersion}</span>}>
          <table className="factors">
            <tbody>
              {pr.factors.map((f) => (
                <tr key={f.key}>
                  <th>{f.label}</th>
                  <td className="f-bar"><span style={{ width: `${f.score * 100}%` }} /></td>
                  <td className="mono f-w">×{f.weight.toFixed(2)}</td>
                  <td className="f-note">{f.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {pr.resolvingCheck && <p className="resolve"><strong>Check that would settle it:</strong> {pr.resolvingCheck}</p>}
        </Section>
      )}

      <Section title="Evidence">
        <EvidenceBlock incident={inc} readings={readings} sessions={sessions} />
      </Section>

      {inc.recentChanges.length > 0 && (
        <Section title="Recent changes nearby">
          <ul className="changes">{inc.recentChanges.map((c) => <li key={c}>{c}</li>)}</ul>
        </Section>
      )}

      <Section title="Tasks" aside={<Btn kind="ghost" onClick={createTask}>+ Task from runbook</Btn>}>
        {tasks.length === 0 && <p className="muted">No task yet. Every alert needs an action — create one.</p>}
        <ul className="task-mini">
          {tasks.map((x) => (
            <li key={x.id}>
              <button onClick={() => setSel({ kind: 'task', id: x.id })}>
                <span className="mono">{x.id}</span> {x.title}
                <span className={`st st-${x.status}`}>{x.status.replace(/_/g, ' ')}</span>
                <span className="muted">{state.employees.find((e) => e.id === x.ownerId)?.name ?? 'unassigned'}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Simulation director" aside={<span className="pane-sub">NVIDIA Nemotron · engine tools</span>}>
        <DirectorPanel incident={inc} />
      </Section>

      <Section title="Evidence summary" aside={<Btn kind="ghost" onClick={() => setShowAnalysis((v) => !v)}>{showAnalysis ? 'Hide' : 'Show'}</Btn>}>
        {showAnalysis ? <AnalysisBlock incident={inc} readings={readings} sessions={sessions} clocks={incClocks} /> : <p className="muted">Cited observations and competing explanations from stored records (local rules).</p>}
      </Section>

      <div className="insp-actions">
        {inc.status === 'open' && <Btn onClick={() => setStatus('monitoring')}>Move to monitoring</Btn>}
        {inc.status !== 'resolved' && (
          <Btn kind="ghost" disabled={inc.evidence === 'unverified' || tasks.some((x) => x.status !== 'completed' && x.status !== 'cancelled')} title="Resolution needs verified evidence and no open tasks" onClick={() => setStatus('resolved')}>Resolve…</Btn>
        )}
        <span className="muted small">{asset.name} · {zoneById.get(asset.zoneId)?.name}</span>
      </div>
    </div>
  );
}

function EvidenceBlock({ incident, readings, sessions }: { incident: Incident; readings: Reading[]; sessions: VerificationSession[] }) {
  const { state, dispatch } = useOps();
  const t = state.t;
  const assetId = incident.rootAssetId;
  const fixture = referenceFixtures[assetId] ?? (incident.id === 'INC-1045' ? referenceFixtures['BATT-B'] : undefined);
  const metric = fixture?.metric ?? (assetId.startsWith('CRAH') ? 'vibration_mm_s' : 'inlet_temp_c');
  const installed = latestFor(readings.filter((r) => r.source === 'installed' || r.source === 'simulated'), fixture?.assetId ?? assetId, metric);
  const th = facility.thresholds.find((x) => x.metric === metric);

  const bridge = useBridge();
  const [reqState, setReqState] = useState<string>('');
  // what the Rack Monitor can honestly measure for this incident (no accelerometer on this build)
  const rigPoint = metric === 'inlet_temp_c' ? { assetId: fixture?.assetId ?? assetId, point: 'Front inlet · both beams' }
    : metric === 'leak' || incident.rootAssetId === 'PIPE-L2' ? { assetId: fixture?.assetId ?? assetId, point: 'Floor · leak probe' } : null;
  const requestScan = async () => {
    if (!rigPoint) return;
    try {
      await api('/api/requests', { ...rigPoint, reason: `${incident.id}: ${incident.title}`, requestedBy: 'Priya Raman', incidentId: incident.id });
      setReqState('sent');
      dispatch({ type: 'append_event', event: makeEvent(t, { kind: 'task', actor: 'Priya Raman', summary: `Scan requested: ${rigPoint.assetId} — ${rigPoint.point}`, links: { assetId: rigPoint.assetId, incidentId: incident.id }, source: 'operator' }) });
    } catch (e) { setReqState((e as Error).message); }
  };

  const verify = () => {
    if (!fixture) return;
    const ref: Reading = { ...fixture, id: `RR-${Date.now().toString(36)}`, t };
    const inst = installed ?? { id: 'none', assetId: fixture.assetId, metric, value: NaN, unit: fixture.unit, t: -999, source: 'installed' as const, expectedIntervalMin: 5 };
    const cmp = compareReadings(inst, [ref], { now: t, thresholds: facility.thresholds });
    const session: VerificationSession = {
      id: `VS-${state.verifications.length + 1}`, assetId: fixture.assetId, incidentId: incident.id, operatorId: 'emp-marcus', probeId: fixture.probeId!, point: fixture.point!, metric,
      installedReadingId: inst.id, referenceReadingIds: [ref.id], t, qualityFlags: cmp.qualityFlags, verdict: cmp.verdict, rationale: cmp.rationale,
    };
    dispatch({ type: 'add_verification', session, readings: [ref], event: makeEvent(t, { kind: 'verification', actor: 'Marcus Lee', summary: `${session.id} ${fixture.assetId}: ${verdictLabel(cmp.verdict)} — ${cmp.rationale}`, links: { assetId: fixture.assetId, incidentId: incident.id }, source: 'operator' }) });
    dispatch({ type: 'upsert_incident', incident: { ...incident, evidence: cmp.verdict, severity: cmp.verdict === 'measurement_disagreement' ? 'advisory' : incident.severity } });
  };

  return (
    <div className="evidence">
      {installed && th && (
        <div className="ev-row">
          <span className="ev-k">{METRIC_LABEL[metric]} <Src s={installed.source} /></span>
          <BarBand value={installed.value} min={metric === 'vibration_mm_s' ? 0 : 15} max={metric === 'vibration_mm_s' ? 10 : 36} warn={th.warn} alarm={th.alarm} unit={installed.unit} />
          <span className="muted small mono">{wallClock(installed.t)} · {installed.assetId}</span>
        </div>
      )}
      {sessions.map((s) => {
        const ref = state.capturedReadings.find((r) => r.id === s.referenceReadingIds[0]);
        return (
          <div key={s.id} className="ev-session">
            <div className="ev-row">
              <span className="ev-k">{s.qualityFlags.includes('live_rig') ? <>Rack Monitor <Src s="live" /></> : s.qualityFlags.includes('simulated_rig') ? <>Rack Monitor <Src s="simulated" /></> : <>Reference probe <Src s="reference_probe" /></>}</span>
              {ref && th ? <BarBand value={ref.value} min={metric === 'vibration_mm_s' ? 0 : 15} max={metric === 'vibration_mm_s' ? 10 : 36} warn={th.warn} alarm={th.alarm} unit={ref.unit} /> : <span className="mono">{ref?.value} {ref?.unit}</span>}
              <span className="muted small mono">{s.probeId} · {s.point}</span>
            </div>
            <p className="ev-verdict"><EvidenceTag v={s.verdict} /> {s.rationale}</p>
            {s.qualityFlags.length > 0 && <p className="muted small">Quality: {s.qualityFlags.join(', ')}</p>}
          </div>
        );
      })}
      {rigPoint && (
        <div className="ev-cta">
          <Btn kind={sessions.length ? 'secondary' : 'primary'} disabled={!bridge.online || reqState === 'sent'} onClick={requestScan}>
            {reqState === 'sent' ? 'Scan requested' : sessions.length ? 'Request another scan' : 'Request scan'}
          </Btn>
          <span className="muted small">
            {bridge.online ? <>Queues <span className="mono">{rigPoint.assetId}</span> · {rigPoint.point} on the scanner. The result lands here automatically.</> : 'Bridge offline — start it with npm run dev to scan with the Rack Monitor.'}
            {reqState && reqState !== 'sent' && <span className="is-warn"> {reqState}</span>}
          </span>
        </div>
      )}
      {!rigPoint && metric === 'vibration_mm_s' && <p className="muted small">The Rack Monitor build has no accelerometer, so vibration can't be checked with the rig.</p>}
      {fixture && sessions.length === 0 && (
        <div className="ev-cta">
          <Btn kind="ghost" onClick={verify}>Use fixture reading instead</Btn>
          <span className="muted small">Labeled fixture value for probe {fixture.probeId}, for demos without the rig.</span>
        </div>
      )}
    </div>
  );
}

function AnalysisBlock({ incident, readings, sessions, clocks }: { incident: Incident; readings: Reading[]; sessions: VerificationSession[]; clocks: ImpactClock[] }) {
  const { state } = useOps();
  const a = useMemo(() => analyzeIncident({ incident, readings, sessions, clocks, now: state.t, changes: changeLog }), [incident, readings, sessions, clocks, state.t]);
  return (
    <div className="analysis">
      <div className="an-provider"><Src s="local_rules" /> <span className="muted small">Provider: local rules (NVIDIA_API_KEY not set). Numbers come from the engine, not the model.</span></div>
      <h4>Observations</h4>
      <ul>{a.observations.map((o, i) => <li key={i}>{o.text} <span className="cite mono">[{o.cite}]</span></li>)}</ul>
      <h4>Competing explanations</h4>
      <ul>{a.hypotheses.map((h, i) => <li key={i}><strong>{h.label}</strong> — {h.support}</li>)}</ul>
      <h4>Recommended next step</h4>
      <p>{a.next}</p>
      {a.open.length > 0 && <><h4>Still unknown</h4><ul>{a.open.map((o, i) => <li key={i}>{o}</li>)}</ul></>}
    </div>
  );
}

// --------------------------------------------------------------------- asset

function AssetPanel({ id, setSel }: { id: string; setSel: Props['setSel'] }) {
  const { state, run } = useOps();
  const t = state.t;
  const a = assetById.get(id);
  if (!a) return null;
  const vis = run.visualAt(t)[id];
  const clock = run.clocks[id];
  const readings = run.readingsAt(t).concat(state.capturedReadings.filter((r) => r.t <= t)).filter((r) => r.assetId === id);
  const byMetric = new Map<string, Reading>();
  for (const r of readings) { const k = `${r.metric}|${r.source}`; const p = byMetric.get(k); if (!p || r.t >= p.t) byMetric.set(k, r); }
  const ups = facility.edges.filter((e) => e.to === id && e.confirmed);
  const downs = facility.edges.filter((e) => e.from === id && e.confirmed);
  const incidents = state.incidents.filter((i) => i.rootAssetId === id || i.alertAssetIds.includes(id));
  const changes = changeLog.filter((c) => c.assetId === id);
  const age = a.installedYear ? 2026 - a.installedYear : undefined;
  return (
    <div className="insp">
      <header className="insp-h">
        <div className="insp-kicker mono">{a.id} · {a.type.toUpperCase()} · {zoneById.get(a.zoneId)?.name}{a.location.row ? ` · row ${a.location.row} slot ${a.location.slot}` : ''}</div>
        <h2>{vis && <SevMark sev={vis.severity} label />} {a.name}</h2>
        <div className="insp-tags">
          {vis && <FreshTag f={vis.freshness} />}
          {vis?.wet && <span className="tag tag-water">WET · model</span>}
          {a.services?.map((s) => <span key={s} className="tag">{serviceById.get(s)?.name} · C{serviceById.get(s)?.criticality}</span>)}
        </div>
      </header>
      {clock && (
        <Section title="Time to impact">
          <Countdown clock={clock} now={t} />
          <p className="muted small">Via {clock.path.join(' → ')}</p>
        </Section>
      )}
      <Section title="Readings">
        {byMetric.size === 0 && <p className="muted">No readings for this asset. Missing is shown as missing, never as zero.</p>}
        <table className="readings">
          <tbody>
            {[...byMetric.values()].map((r) => {
              const stale = t - r.t > 2 * r.expectedIntervalMin;
              return (
                <tr key={r.id} className={stale ? 'is-stale' : ''}>
                  <th>{METRIC_LABEL[r.metric]}</th>
                  <td className="mono">{r.value}{' '}{r.unit}</td>
                  <td><Src s={r.source} /></td>
                  <td className="mono muted">{relMin(t, r.t)}{stale && <FreshTag f="stale" age={t - r.t} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
      <Section title="Depends on">
        <ul className="deps">{ups.map((e) => <li key={e.id}><button onClick={() => setSel({ kind: 'asset', id: e.from })}><span className="mono">{e.from}</span> {e.kind}{e.redundancyGroup ? ' · redundant' : ' · single path'}</button></li>)}
          {ups.length === 0 && <li className="muted">Top of chain</li>}</ul>
      </Section>
      {downs.length > 0 && (
        <Section title={`Feeds ${downs.length}`}>
          <p className="muted small">{downs.slice(0, 14).map((e) => e.to).join(', ')}{downs.length > 14 ? ` +${downs.length - 14}` : ''}</p>
        </Section>
      )}
      {(changes.length > 0 || age != null) && (
        <Section title="History">
          <ul className="changes">
            {age != null && <li>Installed {a.installedYear} ({age} y){a.serviceLifeYears && age > a.serviceLifeYears ? <strong> — past {a.serviceLifeYears}-year service life</strong> : ''}</li>}
            {changes.map((c) => <li key={c.text}><span className="mono">{c.t > -1440 ? relMin(0, c.t) : `${Math.round(-c.t / 1440)} d ago`}</span> {c.text}</li>)}
          </ul>
        </Section>
      )}
      {incidents.length > 0 && (
        <Section title="Incidents">
          <ul className="task-mini">{incidents.map((i) => <li key={i.id}><button onClick={() => setSel({ kind: 'incident', id: i.id })}><SevMark sev={i.severity} /> {i.title}</button></li>)}</ul>
        </Section>
      )}
      <p className="muted small">Service access: {waypointById.get(a.accessWaypoint)?.label} ({a.accessWaypoint}){a.location.serviceSide ? `, ${a.location.serviceSide} side` : ''}</p>
    </div>
  );
}

// ---------------------------------------------------------------------- task

function TaskPanel({ id, setSel }: { id: string; setSel: Props['setSel'] }) {
  const { state, dispatch } = useOps();
  const t = state.t;
  const task = state.tasks.find((x) => x.id === id);
  const [override, setOverride] = useState<string>('');
  if (!task) return null;
  const asset = assetById.get(task.assetId)!;
  const sugg = suggestAssignees(task, state.employees, facility, t);
  const owner = state.employees.find((e) => e.id === task.ownerId);
  const route = owner?.location ? findRoute(facility, owner.location.waypointId, asset.accessWaypoint, { skills: owner.skills, closedEdgeIds: state.closedWalkEdgeIds, startSource: owner.location ? { source: owner.location.source, t: owner.location.t, now: t } : undefined }) : undefined;

  const act = (action: Parameters<typeof transition>[1], actor = 'Priya Raman') => {
    const r = transition(task, action, { actor, t, expectedVersion: task.version });
    if (!r.ok) { alert(`Not allowed: ${r.error}`); return; }
    dispatch({ type: 'upsert_task', task: r.task, event: { ...r.event, links: { ...r.event.links, incidentId: task.incidentId, assetId: task.assetId } } });
    if (action.type === 'assign' && task.incidentId) {
      const inc = state.incidents.find((i) => i.id === task.incidentId);
      if (inc && !inc.ownerId) dispatch({ type: 'upsert_incident', incident: { ...inc, ownerId: action.ownerId } });
    }
  };

  return (
    <div className="insp">
      <header className="insp-h">
        <div className="insp-kicker mono">{task.id} · {task.type.toUpperCase()} · v{task.version}</div>
        <h2>{task.title}</h2>
        <div className="insp-tags">
          <span className={`st st-${task.status}`}>{task.status.replace(/_/g, ' ')}</span>
          {task.reviewRequired && <span className="tag">review required</span>}
          {task.incidentId && <button className="link" onClick={() => setSel({ kind: 'incident', id: task.incidentId! })}>{task.incidentId}</button>}
        </div>
      </header>
      <dl className="kv">
        <dt>Destination</dt><dd><span className="mono">{asset.id}</span> {asset.name}{asset.location.row ? ` · row ${asset.location.row}, slot ${asset.location.slot}` : ''} · {asset.location.serviceSide ?? 'front'} side</dd>
        <dt>Why now</dt><dd>{task.priorityReason}</dd>
        <dt>Skills</dt><dd>{task.requiredSkills.join(', ')}</dd>
        <dt>Estimate</dt><dd className="mono">{task.estimateMin} min</dd>
        {task.blocker && <><dt>Blocked</dt><dd className="is-warn">{task.blocker}</dd></>}
      </dl>

      {(task.status === 'unassigned' || task.status === 'reopened' || task.status === 'assigned') && (
        <Section title="Suggested assignees" aside={<span className="pane-sub">supervisor confirms</span>}>
          <ol className="sugg">
            {sugg.map((s) => {
              const e = state.employees.find((x) => x.id === s.employeeId)!;
              return (
                <li key={s.employeeId} className={s.eligible ? '' : 'is-ineligible'}>
                  <span className="avatar mono">{e.initials}</span>
                  <span className="sugg-body">
                    <span className="sugg-name">{e.name} <span className="muted">· {ROLE_LABEL[e.role]}</span>{s.route?.ok && <span className="mono sugg-eta"> {s.route.etaMin.toFixed(1)} min walk</span>}</span>
                    <span className="sugg-why">{s.reasons.join(' · ')}</span>
                  </span>
                  {s.eligible && task.ownerId !== e.id && <Btn kind={s === sugg[0] ? 'primary' : 'secondary'} onClick={() => act({ type: 'assign', ownerId: e.id })}>Assign</Btn>}
                  {task.ownerId === e.id && <span className="tag">assigned</span>}
                </li>
              );
            })}
          </ol>
          {sugg[0] && !sugg[0].eligible && <p className="is-warn small">No eligible person. Escalate to the shift lead or reassign skills.</p>}
          <label className="override">Reason when not taking the top suggestion
            <input value={override} onChange={(e) => setOverride(e.target.value)} placeholder="e.g. continuity with INC-1043" />
          </label>
        </Section>
      )}

      {owner && (
        <Section title="Route" aside={<span className="pane-sub">from last check-in, not live tracking</span>}>
          {route?.ok ? (
            <>
              <p className="mono">{route.distanceM.toFixed(0)} m · ~{route.etaMin.toFixed(1)} min</p>
              <ol className="route">{route.path.map((w) => <li key={w}>{waypointById.get(w)?.label ?? w}</li>)}</ol>
              <p className="muted small">{route.assumptions.join(' · ')}</p>
            </>
          ) : <p className="is-warn">{route?.blockedReason ?? 'No valid check-in to route from.'}</p>}
          <p className="muted small">{owner.name} last checked in at {owner.location ? `${waypointById.get(owner.location.waypointId)?.label}, ${relMin(t, owner.location.t)} (${owner.location.source})` : 'unknown'}{checkinState(owner, t) === 'stale' ? ' — STALE' : ''}</p>
        </Section>
      )}

      <Section title={`Checklist ${task.checklist.filter((c) => c.result).length}/${task.checklist.length}`}>
        <ol className="checklist-ro">
          {task.checklist.map((c) => <li key={c.id} className={c.result ? `is-${c.result}` : ''}><span className="mono">{c.result ? c.result.replace('_', ' ').toUpperCase() : c.required ? 'REQ' : 'OPT'}</span> {c.text}</li>)}
        </ol>
        <p className="muted small">Asset identity {task.assetConfirmed ? 'confirmed' : 'not yet confirmed'} · checking a box is not proof of repair.</p>
      </Section>

      <div className="insp-actions">
        {task.ownerId && <a className="btn btn-secondary" href={`#/app/field/${task.id}`}>Open technician view</a>}
        {task.status === 'submitted_for_review' && (
          <>
            <Btn kind="primary" onClick={() => act({ type: 'approve' }, 'Amara Singh')}>Approve completion</Btn>
            <Btn onClick={() => act({ type: 'request_changes', reason: 'More evidence needed' }, 'Amara Singh')}>Request evidence</Btn>
          </>
        )}
        {task.status === 'completed' && <Btn onClick={() => act({ type: 'reopen', reason: 'Condition recurred' })}>Reopen</Btn>}
        {!['completed', 'cancelled'].includes(task.status) && <Btn kind="ghost" onClick={() => act({ type: 'cancel', reason: 'Superseded' })}>Cancel</Btn>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ employee

function EmployeePanel({ id, setSel }: { id: string; setSel: Props['setSel'] }) {
  const { state } = useOps();
  const e = state.employees.find((x) => x.id === id);
  if (!e) return null;
  const tasks = state.tasks.filter((x) => x.ownerId === id);
  return (
    <div className="insp">
      <header className="insp-h">
        <div className="insp-kicker mono">{e.team} · {e.shift} shift</div>
        <h2>{e.name}</h2>
        <div className="insp-tags"><span className="tag">{ROLE_LABEL[e.role]}</span><span className="tag">{e.availability.replace('_', ' ')}</span></div>
      </header>
      <dl className="kv">
        <dt>Last check-in</dt><dd>{e.location ? `${waypointById.get(e.location.waypointId)?.label} · ${relMin(state.t, e.location.t)} · ${e.location.source}` : 'unknown'}{checkinState(e, state.t) === 'stale' && <FreshTag f="stale" />}</dd>
        <dt>Skills</dt><dd>{e.skills.join(', ')}</dd>
        <dt>Zones</dt><dd>{e.zones.map((z) => zoneById.get(z)?.name).join(', ')}</dd>
      </dl>
      <Section title="Work">
        {tasks.length === 0 && <p className="muted">No assigned work.</p>}
        <ul className="task-mini">{tasks.map((x) => <li key={x.id}><button onClick={() => setSel({ kind: 'task', id: x.id })}><span className="mono">{x.id}</span> {x.title} <span className={`st st-${x.status}`}>{x.status.replace(/_/g, ' ')}</span></button></li>)}</ul>
      </Section>
      <p className="muted small">Positions come from manual or QR check-ins only. There is no indoor tracking.</p>
    </div>
  );
}


