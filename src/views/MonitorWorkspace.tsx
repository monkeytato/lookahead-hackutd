import { SimulationFeedback, type SimulationPhase } from '../components/SimulationFeedback';
import { EnsembleCompare } from './EnsembleCompare';
import { useIncidentReplay } from './IncidentReplay';
import { useEffect, useMemo, useRef, useState } from 'react';
import { employees, facility } from '../domain/fixture';
import { sensorBaseline } from '../domain/sensors';
import { CATALOG, ERROR_CHOICES, assetLocation, reviewWork, stepDone, uncheckedSteps, type ErrorKind, type WorkIssue } from '../domain/workflow';
import type { AssetVisualState } from '../domain/types';
import { findRoute } from '../domain/engine';
import { Twin } from '../twin/Twin';
import { useWorkflow } from '../state/workflow';
import { api, useBridge, useFrameAge } from '../state/bridge';
import { METRIC_LABEL } from '../state/selectors';
import './monitor.css';

const time = (s: string) => new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const verdict = (i: WorkIssue) => i.evidence?.verdict === 'disagrees' ? 'Readings disagree' : i.evidence?.verdict === 'confirmed' ? 'Warning corroborated' : i.evidence?.verdict === 'inconclusive' ? 'Repeat measurement' : 'Needs verification';
const priority = (i: WorkIssue) => i.status === 'resolved' ? 9 : i.evidence?.verdict === 'disagrees' ? 3 : i.kind === 'water' ? 0 : i.kind === 'heat' ? 1 : 2;

export function MonitorWorkspace({ view = 'operations' }: { view?: 'operations' | 'tasks' | 'log' | 'handoff' }) {
  const w = useWorkflow();
  const b = useBridge();
  const age = useFrameAge(w.data.prototype);
  const [selected, setSelected] = useState<string | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);
  const [note, setNote] = useState('');
  /** Issue id whose incomplete submission is armed and waiting for a second, confirming click. */
  const [confirmIncomplete, setConfirmIncomplete] = useState<string | null>(null);
  /** Incident id armed for deletion from the handoff. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [filter, setFilter] = useState('');
  const [contextNote, setContextNote] = useState('');
  /** Draft of an operator-created team response (Team response view). */
  const [draft, setDraft] = useState<{ title: string; assetId: string; kind: ErrorKind }>({ title: '', assetId: '', kind: 'sensor' });
  const [evaluation, setEvaluation] = useState<{ issueId: string; assetId: string; phase: SimulationPhase } | null>(null);
  const evaluationLock = useRef(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState('');
  const [scanId, setScanId] = useState<string | null>(null);
  const [scanIssueId, setScanIssueId] = useState<string | null>(null);
  const detail = useRef<HTMLElement>(null);
  const attached = useRef(new Set<string>());
  const issues = [...w.data.issues].sort((a, c) => priority(a) - priority(c));
  const tasks = w.data.tasks ?? [];
  const open = issues.filter(i => i.status !== 'resolved');
  const issue = issues.find(i => i.id === selected) ?? open[0];
  const focus = assetId ?? issue?.assetId ?? null;
  const frame = w.data.prototype;
  const fresh = frame && age !== null && age < 6;
  const live = fresh && frame.source === 'live';
  const pick = (i: WorkIssue) => { setSelected(i.id); setAssetId(null); setNote(''); setConfirmIncomplete(null); if (window.innerWidth < 1100) detail.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  // Attach only the scan explicitly initiated here; never silently associate a probe with the whole hall.
  useEffect(() => {
    const scan = b.scans.find(s => s.id === scanId);
    const target = w.data.issues.find(i => i.id === scanIssueId);
    if (!scan || attached.current.has(scan.id) || !target || scan.assetId !== target.assetId) return;
    attached.current.add(scan.id); setScanBusy(false);
    // If the command could not be sent (another one was in flight), forget it so the next run retries.
    void w.command({ type: 'verify_scan', issueId: target.id, scanId: scan.id }).then(ok => { if (!ok) attached.current.delete(scan.id); });
  }, [b.scans, scanId, scanIssueId, w.busy]);
  useEffect(() => {
    if (!scanBusy) return;
    const timer = window.setTimeout(() => { setScanBusy(false); setScanError('Scan did not complete. Check the bridge and take another measurement.'); }, 16_000);
    return () => window.clearTimeout(timer);
  }, [scanBusy]);
  const measure = async () => {
    if (!issue) return; setScanBusy(true); setScanError('');
    try {
      const r = await api<{ id: string }>('/api/scans/start', { assetId: issue.assetId, point: issue.kind === 'water' ? 'Floor / leak' : issue.kind === 'vibration' ? 'Vibration / fan housing' : 'Front inlet temperature', operator: 'CenterGuard operator' });
      setScanId(r.id); setScanIssueId(issue.id);
    } catch (e) { setScanBusy(false); setScanError((e as Error).message); }
  };

  const visual = useMemo(() => {
    const out: Record<string, AssetVisualState> = Object.fromEntries(facility.assets.map(a => [a.id, { severity: 'normal', freshness: 'fresh', heat: 0.15 }]));
    for (const i of w.data.issues) out[i.assetId] = { severity: i.status === 'resolved' ? 'normal' : i.evidence?.verdict === 'disagrees' ? 'advisory' : i.kind === 'water' || i.kind === 'heat' ? 'critical' : 'warning', freshness: 'fresh', heat: i.kind === 'heat' && i.status !== 'resolved' ? 0.95 : 0.2 };
    return out;
  }, [w.data.revision]);
  const owner = employees.find(e => e.id === issue?.ownerId);
  const asset = facility.assets.find(a => a.id === focus);
  const route = useMemo(() => {
    if (!owner?.location || !asset) return undefined;
    const r = findRoute(facility, owner.location.waypointId, asset.accessWaypoint, { skills: owner.skills, closedEdgeIds: [] });
    return r.ok ? r.path.map(id => facility.waypoints.find(x => x.id === id)!).filter(Boolean) : undefined;
  }, [owner?.id, asset?.id]);
  const analysis = w.data.analyses.filter(a => a.issueId === issue?.id).at(-1);
  const replay = useIncidentReplay(issue, analysis);
  const gaps = reviewWork(w.data);
  const evaluationPhase: SimulationPhase = evaluation && evaluation.issueId === issue?.id ? evaluation.phase : 'idle';
  const evaluate = async () => {
    if (!issue || evaluationLock.current || w.busy || w.data.analyzing) return;
    evaluationLock.current = true;
    const target = { issueId: issue.id, assetId: issue.assetId };
    setEvaluation({ ...target, phase: 'running' });
    try {
      const ok = await w.command({ type: 'evaluate', issueId: target.issueId });
      setEvaluation({ ...target, phase: ok ? 'complete' : 'error' });
    } finally { evaluationLock.current = false; }
  };
  const chooseOwner = (i: WorkIssue) => <label className="mw-owner">Assigned technician<select aria-label="Assigned technician" value={i.ownerId ?? ''} disabled={w.busy || i.status === 'resolved'} onChange={e => void w.command({ type: 'assign', issueId: i.id, employeeId: e.target.value })}>
    <option value="">Choose a technician…</option>{employees.filter(e => e.availability !== 'off_shift' && e.skills.includes(i.kind === 'water' ? 'leak_response' : i.kind === 'vibration' ? 'vibration' : 'cooling') && e.zones.includes(i.kind === 'heat' ? 'Z-YARD' : i.kind === 'water' ? 'Z-CORR' : 'Z-HALL')).map(e => <option key={e.id} value={e.id}>{e.name} · {e.team}</option>)}
  </select></label>;
  const evidenceNote = (i: WorkIssue) => i.evidence
    ? ` · ${i.evidence.value} ${i.evidence.unit} attached${i.evidence.verdict === 'inconclusive' ? ' · repeat measurement' : ''}`
    : ' · attach a measurement';
  const checklist = (i: WorkIssue) => <div className="mw-checks">{i.steps.map(s => <label key={s.id}><input type="checkbox" checked={stepDone(i, s)} disabled={w.busy || !i.ownerId || i.status === 'resolved' || s.id === 'verify'} onChange={e => void w.command({ type: 'check', issueId: i.id, stepId: s.id, done: e.target.checked })}/><span>{s.label}{s.id === 'verify' ? evidenceNote(i) : ''}</span></label>)}</div>;
  const activity = <ol className="mw-events">{[...w.data.events].reverse().filter(e => !filter || `${e.summary} ${e.actor} ${e.assetId}`.toLowerCase().includes(filter.toLowerCase())).map(e => <li key={e.id} className={e.flag === 'incomplete' ? 'is-incomplete' : undefined}><time dateTime={e.at}>{time(e.at)}</time><div>{e.flag === 'incomplete' && <span className="mw-flag">Incomplete submission</span>}<strong>{e.summary}</strong><small>{e.actor} · {e.source}{e.issueId ? ` · ${e.issueId}` : ''}</small></div></li>)}{!w.data.events.length && <li>Actions and evidence appear here as your team works.</li>}</ol>;
  const incompleteIssues = issues.filter(i => i.status === 'resolved' && i.incomplete?.length);
  const incompleteList = incompleteIssues.length > 0 && <section className="mw-incomplete" aria-label="Incomplete submissions"><h3>Incomplete submissions · {incompleteIssues.length}</h3><p>These outcomes were submitted with checklist steps unchecked. Follow up on the open steps.</p><ul>{incompleteIssues.map(i => <li key={i.id}><strong>{i.assetId} · {i.title}</strong><small>{i.id} · owner: {employees.find(e => e.id === i.ownerId)?.name ?? 'unassigned'}</small><ul>{i.incomplete!.map(s => <li key={s}>☐ {s}</li>)}</ul></li>)}</ul></section>;
  // No window.confirm(): embedded browsers and claude.ai artifacts return false without showing a
  // dialog, which silently cancelled every incomplete submission. The first click arms an in-page
  // confirmation instead; the second click submits.
  const submit = async (i: WorkIssue) => {
    const missing = uncheckedSteps(i);
    if (missing.length && confirmIncomplete !== i.id) { setConfirmIncomplete(i.id); return; }
    setConfirmIncomplete(null);
    if (await w.command({ type: 'resolve', issueId: i.id, note })) setNote('');
  };

  return <div className="mw">
    <header className="mw-heading"><div><span className="mw-eyebrow">DAL-1 / Hall A</span><h1>{view === 'operations' ? 'Facility overview' : view === 'tasks' ? 'Team response' : view === 'handoff' ? 'Shift handoff' : 'Incident history'}</h1></div><div className="mw-heading-actions"><span className={w.online ? 'mw-source' : 'mw-offline'}>{w.online ? 'Shared session connected' : 'Bridge offline · last known state'}</span><button onClick={() => setDemo(!demo)} aria-expanded={demo}>Demo controls</button></div></header>
    {demo && <section className="mw-demo"><div><strong>Presenter controls</strong><p>Inject a labelled warning. No physical equipment is changed.</p></div>{ERROR_CHOICES.map(k => <button key={k.id} disabled={!w.online || w.busy} title={k.hint} onClick={() => void w.command({ type: 'simulate_error', kind: k.id })}>{k.title}</button>)}<button onClick={() => { if (!confirmReset) { setConfirmReset(true); return; } setConfirmReset(false); void w.command({ type: 'reset' }); }} onBlur={() => setConfirmReset(false)}>{confirmReset ? 'Click again to clear the session and its history' : 'New session'}</button><a href="#/app/lab">Scenario lab ↗</a></section>}
    {(w.error || scanError) && <div role="alert" className="mw-error">{w.error || scanError}</div>}
    {view === 'operations' && <>
      {open.find(i => i.status === 'new') && (() => { const next = open.find(i => i.status === 'new')!; return <div className="mw-notification" role="alert"><div><strong>New warning · {next.assetId}</strong><p>{next.title}</p></div><button onClick={() => { pick(next); void w.command({ type: 'acknowledge', issueId: next.id }); }}>Review warning →</button></div>; })()}
      <section className="mw-summary" aria-label="Facility status"><div><b>{!w.online ? 'Status unavailable' : open.length ? 'Attention needed' : 'No active warnings'}</b><span>{open.length ? `${open.length} open issue${open.length === 1 ? '' : 's'} · ${open.filter(i => !i.evidence).length} to verify` : 'All readings inside normal bands'}</span></div></section>
      <div className="mw-grid">
        <aside className="mw-issues"><div className="mw-pane-heading"><h2>Needs attention</h2></div>{open.map(i => <button key={i.id} className={`mw-issue ${i.id === issue?.id ? 'selected' : ''}`} onClick={() => pick(i)}><small>{i.assetId} · {i.evidence?.verdict === 'disagrees' ? 'Inspect sensor' : i.kind === 'water' || i.kind === 'heat' ? 'High priority' : 'Verify first'}</small><strong>{i.title}</strong><span>{verdict(i)}</span><span>{employees.find(e => e.id === i.ownerId)?.name ?? 'No owner yet'}</span></button>)}{!open.length && <div className="mw-quiet"><h3>The hall is quiet.</h3><p>Select equipment to inspect its readings. New warnings from the iPhone controller appear here.</p><button onClick={() => setDemo(true)}>Open demo controls</button></div>}
        </aside>
        <section className={`mw-map ${evaluation?.phase === 'running' ? 'is-evaluating' : ''}`}><div className="mw-pane-heading"><h2>Facility map</h2><span>Selected: {focus ?? 'Overview'}</span></div>{evaluation?.phase === 'running' && <div className="mw-map-request" role="status"><span className="cg-request-spinner" aria-hidden="true"/>Evaluating {evaluation.assetId} · current sensor readings stay visible</div>}<div className="mw-map-canvas"><Twin facility={facility} visual={replay.view?.visual ?? visual} water={replay.view?.water} run={replay.view?.run} t={replay.view?.t ?? 0} now={replay.view?.t ?? 0} buildKey="workspace" selectedId={focus} onSelect={id => { setAssetId(id); const found = open.find(i => i.assetId === id); if (found) setSelected(found.id); }} employees={owner ? [owner] : []} route={route} layers={{ heat: false, water: !!replay.view?.water, deps: false, people: !!owner }} lookaheadMin={0} />{replay.bar}</div></section>
        <aside className="mw-detail" ref={detail}>{issue && (!assetId || assetId === issue.assetId) ? <>
          <div className="mw-detail-header"><small>{issue.id} · {issue.location}</small><h2>{issue.title}</h2><p>{issue.status === 'resolved' ? 'Closed with an operator-recorded outcome.' : 'Verify the warning before changing equipment.'}</p></div>
          <section className="mw-section"><h3>1. Verify what is happening</h3><div className="mw-comparison"><div><small>Installed · demo</small><b>{issue.installed} {issue.unit}</b></div><div><small>Portable · {issue.evidence?.source ?? 'not measured'}</small><b>{issue.evidence ? `${issue.evidence.value} ${issue.evidence.unit}` : 'Awaiting scan'}</b></div></div>{issue.evidence && <p className="mw-verdict"><strong>{verdict(issue)}</strong><br/>{issue.evidence.note}</p>}
          {issue.status !== 'resolved' && <><button className="mw-primary" disabled={w.busy || scanBusy || !fresh || (issue.kind === 'vibration' && typeof frame?.vibrating !== 'boolean')} onClick={() => void measure()}>{scanBusy ? 'Collecting independent readings…' : fresh && !live ? 'Take simulated sensor scan' : 'Take portable sensor scan'}</button>{issue.assetId === CATALOG[issue.kind].assetId && <details><summary>No compatible hardware? Use a demo reference</summary><p>This records a scripted value, clearly labelled fixture.</p><button disabled={w.busy} onClick={() => void w.command({ type: 'verify_fixture', issueId: issue.id })}>Attach labelled demo reference</button></details>}</>}
          </section>
          <section className="mw-section"><h3>2. Evaluate a response</h3>{issue.evidence?.verdict === 'disagrees' && <p>Readings disagree: check the sensor first.</p>}<button className="cg-simulation-button" disabled={w.busy || w.data.analyzing || evaluationPhase === 'running' || !w.online} aria-busy={evaluationPhase === 'running'} onClick={() => void evaluate()}>{evaluationPhase === 'running' ? <><span className="cg-request-spinner" aria-hidden="true"/>Running response simulation…</> : evaluationPhase === 'error' ? 'Retry response simulation' : evaluationPhase === 'complete' ? 'Run simulation again' : b.status?.nemotron.configured ? 'Simulate response with Nemotron' : 'Simulate response with local planner'}</button><SimulationFeedback phase={evaluationPhase} subject={issue.assetId} message={w.error}/>{w.data.analyzing && evaluationPhase !== 'running' && <small role="status">A response evaluation is running on another screen.</small>}{analysis && <div className="mw-analysis">{analysis.comparison?.ensemble && <EnsembleCompare action={analysis.comparison.action} e={analysis.comparison.ensemble} onWatch={replay.view ? replay.play : undefined} why={<><small>{analysis.provider === 'nemotron' ? 'NVIDIA Nemotron' : 'Deterministic local planner'} · {analysis.runs} model runs</small><p>{analysis.summary}</p><p><strong>{analysis.nextAction}</strong></p></>}/>}{!analysis.comparison?.ensemble && <><small>{analysis.provider === 'nemotron' ? 'NVIDIA Nemotron' : 'Deterministic local planner'} · {analysis.runs} model runs</small><p>{analysis.summary}</p><strong>{analysis.nextAction}</strong></>}{analysis.comparison && !analysis.comparison.ensemble && <div className="mw-model-compare"><strong>{analysis.comparison.action}</strong><div><span>Without response<b>{analysis.comparison.without} racks at risk</b></span><span>With response<b>{analysis.comparison.with} racks at risk</b></span></div><small>{analysis.comparison.assumptions}</small></div>}{analysis.warnings.length > 0 && <details><summary>Analysis limitations</summary>{analysis.warnings.map((s,i) => <p key={i}>{s}</p>)}</details>}</div>}</section>
          <section className="mw-section"><h3>3. Assign and follow through</h3>{chooseOwner(issue)}{owner && <p>{issue.location}</p>}{checklist(issue)}<a href="#/app/tasks">Open team checklist ↗</a></section>
          <details className="mw-section"><summary>Recent actions on this equipment</summary>{w.data.events.filter(e => e.assetId === issue.assetId).slice(-5).reverse().map(e => <p key={e.id}><small>{time(e.at)} · {e.actor}</small><br/>{e.summary}</p>)}</details>
          <section className="mw-section"><h3>4. Record the outcome</h3>{issue.status === 'resolved' ? <>{issue.incomplete?.length ? <div className="mw-incomplete-note"><strong>Submitted incomplete · {issue.incomplete.length} unchecked</strong><ul>{issue.incomplete.map(s => <li key={s}>☐ {s}</li>)}</ul></div> : null}<p>{issue.resolution}</p></> : (() => { const missing = uncheckedSteps(issue); return <><textarea aria-label="Outcome and follow-up" value={note} onChange={e => setNote(e.target.value)} placeholder="What did you inspect or change, and what did the recheck show?"/>{missing.length > 0 && <div className="mw-incomplete-note"><strong>{missing.length} checklist step{missing.length === 1 ? '' : 's'} unchecked</strong><ul>{missing.map(s => <li key={s}>☐ {s}</li>)}</ul><small>You can still submit; it will be flagged incomplete in History.</small></div>}{missing.length > 0 && confirmIncomplete === issue.id && <div className="mw-incomplete-note" role="alert"><strong>Submit with {missing.length} unchecked step{missing.length === 1 ? '' : 's'}?</strong><small>Click the red button again to confirm. The outcome is closed and flagged incomplete in History and the handoff.</small><button className="mw-cancel" onClick={() => setConfirmIncomplete(null)}>Cancel</button></div>}<button className={`mw-primary ${missing.length ? 'is-incomplete' : ''}`} disabled={w.busy || !issue.ownerId || note.trim().length < 8} onClick={() => void submit(issue)}>{missing.length ? (confirmIncomplete === issue.id ? `Confirm: submit incomplete (${missing.length} unchecked)` : `Submit incomplete (${missing.length} unchecked)`) : 'Close with evidence'}</button><small>{!issue.ownerId ? 'Assign a technician first (section 3).' : note.trim().length < 8 ? 'Write the outcome note above (at least 8 characters).' : ''}</small></>; })()}</section>
        </> : <div className="mw-section"><h2>{asset?.name ?? 'Equipment details'}</h2><p>{asset ? `${facility.zones.find(z => z.id === asset.zoneId)?.name} · ${asset.id}` : 'Select equipment on the map.'}</p>{asset && <dl className="mw-readings">{sensorBaseline(facility).filter(r => r.assetId === asset.id).map(r => <div key={r.id}><dt>{METRIC_LABEL[r.metric]}</dt><dd>{r.value} {r.unit} <small>demo</small></dd></div>)}</dl>}</div>}</aside>
      </div>
    </>}
    {view === 'tasks' && <div className="mw-task-grid"><article className="mw-task"><details><summary>Create a team response</summary><p>Open a response for equipment that needs the team. It gets the standard checklist and is recorded in History as operator-created.</p><label className="mw-owner">Title<input aria-label="Response title" maxLength={120} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} placeholder="What needs a response?"/></label><label className="mw-owner">Equipment<select aria-label="Equipment" value={draft.assetId} onChange={e => setDraft({ ...draft, assetId: e.target.value })}><option value="">Choose equipment…</option>{facility.zones.map(z => <optgroup key={z.id} label={z.name}>{facility.assets.filter(a => a.zoneId === z.id).map(a => <option key={a.id} value={a.id}>{a.name.includes(a.id) ? a.name : `${a.id} · ${a.name}`}</option>)}</optgroup>)}</select></label><label className="mw-owner">Type<select aria-label="Response type" value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as ErrorKind })}>{ERROR_CHOICES.map(k => <option key={k.id} value={k.id}>{k.title}</option>)}</select></label>{draft.assetId && <p>Location: {assetLocation(draft.assetId)}</p>}<button disabled={w.busy || !w.online || draft.title.trim().length < 3 || !draft.assetId} onClick={async () => { if (await w.command({ type: 'create_response', ...draft })) setDraft({ ...draft, title: '' }); }}>Create response</button></details></article>{tasks.map(t => <article className={`mw-task ${t.status === 'complete' ? 'is-complete' : ''}`} key={t.id}><small>{t.assetId} · follow-up task · {t.status}</small><h2>{t.title}</h2><p>{t.location} · from {t.issueId}</p><div className="mw-checks">{t.steps.map(s => <label key={s.id}><input type="checkbox" checked={s.done} disabled={w.busy} onChange={e => void w.command({ type: 'check_task', taskId: t.id, stepId: s.id, done: e.target.checked })}/><span>{s.label}</span></label>)}</div><p>{t.steps.filter(s => !s.done).length ? `${t.steps.filter(s => !s.done).length} open step${t.steps.filter(s => !s.done).length === 1 ? '' : 's'}` : 'All follow-up steps complete.'}</p></article>)}{issues.map(i => <article className={`mw-task ${i.incomplete?.length ? 'is-incomplete' : ''}`} key={i.id}><small>{i.assetId} · {i.status}{i.incomplete?.length ? ' · incomplete' : ''}</small><h2>{i.title}</h2><p>{i.location}</p>{chooseOwner(i)}{checklist(i)}{i.incomplete?.length ? <div className="mw-incomplete-note"><strong>Submitted incomplete · {i.incomplete.length} unchecked</strong><ul>{i.incomplete.map(s => <li key={s}>☐ {s}</li>)}</ul></div> : null}<p>{i.resolution ?? 'Close the incident from Operations once the outcome is recorded.'}</p><a href="#/app">Return to facility map ↗</a></article>)}{!issues.length && <p className="mw-quiet">No response tasks yet. A warning creates its own shared checklist.</p>}</div>}
    {view === 'log' && <section className="mw-history"><div className="mw-pane-heading"><h2>Every decision, with its evidence</h2><input aria-label="Search incident history" placeholder="Search equipment, people or action…" value={filter} onChange={e => setFilter(e.target.value)}/></div><p>Times show when the action was recorded. Nearby changes help investigation; they do not prove causation.</p><details className="mw-context-note"><summary>Add maintenance or investigation context</summary><p>Describe a change or observation. It is recorded as an unverified operator note.</p><textarea value={contextNote} onChange={e => setContextNote(e.target.value)} aria-label="Maintenance or investigation note"/><button disabled={w.busy || !w.online || contextNote.trim().length < 8} onClick={async () => { if (await w.command({ type: 'note', text: contextNote })) setContextNote(''); }}>Record context</button></details>{incompleteList}{activity}</section>}
    {view === 'handoff' && <section className="mw-handoff"><div className="mw-pane-heading"><h2>Nothing left between shifts</h2><button disabled={w.busy || !w.online} onClick={() => void w.command({ type: 'review' })}>Review handoff gaps</button><button onClick={() => { const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...w.data, prototype: undefined, handoffGaps: gaps }, null, 2)], { type: 'application/json' }); const u = URL.createObjectURL(blob); const a = Object.assign(document.createElement('a'), { href: u, download: 'lookahead-handoff.json' }); a.click(); URL.revokeObjectURL(u); }}>Export record</button></div><div className="mw-handoff-grid"><article><h3>Needs attention</h3>{gaps.length ? <ul>{gaps.map(s => <li key={s}>{s}</li>)}</ul> : <p>No evidence, ownership or checklist gaps in the current session.</p>}<small>Automatic rule-based checks, not an AI guarantee of completeness.</small></article><article><h3>Decisions and outcomes</h3><p className="mw-handoff-lead">Carry open steps into a follow-up task, or delete an incident from this handoff.</p>{!issues.length && <p>No incidents recorded.</p>}{issues.map(i => { const openSteps = i.steps.filter(step => !stepDone(i, step)); const linkedTasks = tasks.filter(t => t.issueId === i.id); return <div key={i.id} className={i.incomplete?.length ? 'is-incomplete' : undefined}><h4>{i.assetId} · {i.title}{i.incomplete?.length ? ' · submitted incomplete' : ''}</h4><p>{i.resolution ?? `${verdict(i)} · owner: ${employees.find(e => e.id === i.ownerId)?.name ?? 'unassigned'}`}</p>{openSteps.length > 0 && !linkedTasks.length && <p className="mw-handoff-open"><strong>{openSteps.length} open step{openSteps.length === 1 ? '' : 's'}:</strong> {openSteps.map(s => s.label).join(' · ')}</p>}<div className="mw-handoff-actions">{openSteps.length > 0 && !linkedTasks.length && <button disabled={w.busy || !w.online} onClick={() => void w.command({ type: 'create_task', issueId: i.id })}>Create task ({openSteps.length})</button>}{confirmDelete === i.id ? <><button className="mw-danger" disabled={w.busy || !w.online} onClick={async () => { if (await w.command({ type: 'delete_issue', issueId: i.id })) setConfirmDelete(null); }}>Confirm delete</button><button className="mw-cancel" onClick={() => setConfirmDelete(null)}>Cancel</button></> : <button disabled={w.busy || !w.online} onClick={() => setConfirmDelete(i.id)}>Delete incident</button>}</div>{linkedTasks.map(t => <div className="mw-handoff-task" key={t.id}><strong>Follow-up task · {t.id} · {t.status}</strong><ul>{t.steps.map(s => <li key={s.id}>{s.done ? '☑' : '☐'} {s.label}</li>)}</ul></div>)}</div>; })}</article></div>{incompleteList}{activity}</section>}
  </div>;
}
