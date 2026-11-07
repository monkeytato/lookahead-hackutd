import { useState } from 'react';
import { facility, referenceFixtures } from '../domain/fixture';
import { findRoute, transition, canComplete } from '../domain/engine';
import type { TaskAction } from '../domain/engine';
import { makeEvent, relMin, useOps, wallClock } from '../state/store';
import { assetById, waypointById } from '../state/selectors';
import { Btn, SevMark } from '../components/primitives';

/** Phone-first technician workspace. Same task record as the desktop — no second database. */
export function FieldView({ taskId }: { taskId?: string }) {
  const { state, dispatch } = useOps();
  const t = state.t;
  const task = state.tasks.find((x) => x.id === taskId) ?? state.tasks.find((x) => x.ownerId && !['completed', 'cancelled'].includes(x.status));
  const [scan, setScan] = useState('');
  const [err, setErr] = useState('');
  const [blocker, setBlocker] = useState('');

  if (!task) return (
    <div className="field"><header className="field-top"><a href="#/app">← Workspace</a></header><p className="field-pad">No task assigned. Ask your supervisor to assign one.</p></div>
  );

  const asset = assetById.get(task.assetId)!;
  const owner = state.employees.find((e) => e.id === task.ownerId);
  const inc = state.incidents.find((i) => i.id === task.incidentId);
  const route = owner?.location ? findRoute(facility, owner.location.waypointId, asset.accessWaypoint, { skills: owner.skills, closedEdgeIds: state.closedWalkEdgeIds, startSource: owner.location ? { source: owner.location.source, t: owner.location.t, now: t } : undefined }) : undefined;
  const actor = owner?.name ?? 'Technician';

  const act = (action: TaskAction) => {
    setErr('');
    const r = transition(task, action, { actor, t, expectedVersion: task.version });
    if (!r.ok) { setErr(r.error === 'asset_mismatch' ? `That is not ${asset.id}. Check the label — do not start work on this unit.` : `Not allowed: ${r.error.replace(/_/g, ' ')}`); return false; }
    dispatch({ type: 'upsert_task', task: r.task, event: { ...r.event, links: { ...r.event.links, incidentId: task.incidentId, assetId: task.assetId, employeeId: owner?.id } } });
    if (action.type === 'arrive' && owner) {
      dispatch({ type: 'checkin', employeeId: owner.id, location: { zoneId: asset.zoneId, waypointId: asset.accessWaypoint, t, source: 'manual' }, event: makeEvent(t, { kind: 'checkin', actor, summary: `${owner.name} checked in at ${waypointById.get(asset.accessWaypoint)?.label}`, links: { employeeId: owner.id }, source: 'operator' }) });
    }
    return true;
  };

  const attachProbe = (stepId: string) => {
    const fx = referenceFixtures[task.assetId];
    if (!fx) return act({ type: 'record_step', stepId, result: 'pass', note: 'Observed' });
    const rid = `RR-${Date.now().toString(36)}`;
    dispatch({ type: 'append_event', event: makeEvent(t, { kind: 'telemetry', actor, summary: `Reference reading ${fx.value} ${fx.unit} at ${fx.point} (${fx.probeId}, fixture)`, links: { assetId: task.assetId, taskId: task.id }, source: 'operator' }) });
    act({ type: 'record_step', stepId, result: 'pass', note: `${fx.value} ${fx.unit} · ${fx.probeId}`, evidenceId: rid });
  };

  const s = task.status;
  const stepIdx = ['assigned', 'accepted', 'en_route', 'at_asset', 'in_progress', 'submitted_for_review', 'completed'].indexOf(s);

  return (
    <div className="field">
      <header className="field-top">
        <a href="#/app">← Workspace</a>
        <span className="mono">{wallClock(t)} · SIM</span>
      </header>

      <section className="field-hero">
        <div className="mono field-kicker">{task.id} · {task.type.toUpperCase()}</div>
        <h1>{task.title}</h1>
        <div className="field-dest">
          <span className="field-asset mono">{asset.id}</span>
          <span>{asset.name}{asset.location.row ? ` · row ${asset.location.row}, slot ${asset.location.slot}` : ''} · {asset.location.serviceSide ?? 'front'} side</span>
        </div>
        {inc && <p className="field-why"><SevMark sev={inc.severity} /> {task.priorityReason}</p>}
        <ol className="field-progress" aria-label="Progress">
          {['Accept', 'Go', 'Arrive', 'Confirm ID', 'Checklist', 'Submit'].map((l, i) => <li key={l} className={i < stepIdx ? 'done' : i === stepIdx ? 'now' : ''}>{l}</li>)}
        </ol>
      </section>

      {err && <div className="field-err" role="alert">{err}</div>}

      {s === 'assigned' && (
        <section className="field-card">
          <p>{owner?.name}, this task is assigned to you. Until you accept, {state.employees.find((e) => e.id === inc?.shiftLeadId)?.name ?? 'the supervisor'} keeps responsibility.</p>
          <div className="field-actions">
            <Btn kind="primary" onClick={() => act({ type: 'accept' })}>Accept</Btn>
            <Btn onClick={() => act({ type: 'decline', reason: 'On another physical task' })}>Decline</Btn>
          </div>
        </section>
      )}

      {(s === 'accepted' || s === 'en_route') && (
        <section className="field-card">
          <h2>Route</h2>
          {route?.ok ? (
            <>
              <p className="mono">{route.distanceM.toFixed(0)} m · ~{route.etaMin.toFixed(1)} min walk</p>
              <ol className="directions">
                {route.path.map((w, i) => <li key={w} className={i === 1 ? 'next' : ''}>{i === 0 ? 'Start: ' : i === route.path.length - 1 ? 'Arrive: ' : ''}{waypointById.get(w)?.label}</li>)}
              </ol>
              <p className="muted small">From your check-in {owner?.location ? relMin(t, owner.location.t) : ''}. {route.assumptions.join(' · ')}</p>
            </>
          ) : <p className="is-warn">{route?.blockedReason ?? 'No check-in to route from — check in first.'}</p>}
          <div className="field-actions">
            {s === 'accepted' && <Btn kind="primary" onClick={() => act({ type: 'depart' })}>Start walking</Btn>}
            {s === 'en_route' && <Btn kind="primary" onClick={() => act({ type: 'arrive' })}>I'm at {asset.id}</Btn>}
          </div>
        </section>
      )}

      {s === 'at_asset' && (
        <section className="field-card">
          <h2>Confirm equipment identity</h2>
          <p>Read the asset label. The right room is not enough: the wrong PDU or rack is the classic handoff error.</p>
          <label className="field-input">Asset ID on the label
            <input value={scan} onChange={(e) => setScan(e.target.value.toUpperCase())} placeholder={`e.g. ${asset.id.replace(/\d$/, '?')}`} autoCapitalize="characters" inputMode="text" />
          </label>
          <div className="field-actions">
            <Btn kind="primary" disabled={!scan} onClick={() => { if (act({ type: 'confirm_asset', scannedId: scan.trim() })) setScan(''); }}>Confirm</Btn>
          </div>
          <p className="muted small">QR scanning is optional; manual entry always works.</p>
        </section>
      )}

      {(s === 'in_progress' || (s === 'at_asset' && task.assetConfirmed)) && (
        <section className="field-card">
          {s === 'at_asset' && <div className="field-actions"><Btn kind="primary" onClick={() => act({ type: 'start' })}>Begin checklist</Btn></div>}
          {s === 'in_progress' && (
            <>
              <h2>Checklist</h2>
              <ol className="checklist">
                {task.checklist.map((c, i) => (
                  <li key={c.id} className={c.result ? `is-${c.result}` : ''}>
                    <div className="cl-text"><span className="mono">{i + 1}</span> {c.text} {!c.required && <span className="muted small">(optional)</span>}</div>
                    {c.note && <div className="cl-note mono">{c.note}</div>}
                    <div className="cl-btns" role="group" aria-label={`Result for step ${i + 1}`}>
                      {(/probe|reading|accelerometer|Capture/i.test(c.text)) && <Btn kind="secondary" onClick={() => attachProbe(c.id)}>Attach probe reading</Btn>}
                      <Btn kind={c.result === 'pass' ? 'primary' : 'secondary'} onClick={() => act({ type: 'record_step', stepId: c.id, result: 'pass' })}>Pass</Btn>
                      <Btn kind={c.result === 'fail' ? 'danger' : 'secondary'} onClick={() => act({ type: 'record_step', stepId: c.id, result: 'fail' })}>Fail</Btn>
                      <Btn kind="ghost" onClick={() => act({ type: 'record_step', stepId: c.id, result: 'not_assessed' })}>N/A</Btn>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="field-actions">
                <Btn kind="primary" disabled={!canComplete(task)} onClick={() => act({ type: 'submit' })}>{task.reviewRequired ? 'Submit for review' : 'Complete'}</Btn>
              </div>
              <p className="muted small">Completing the work does not resolve the incident. A reviewer and the post-action state decide that.</p>
            </>
          )}
        </section>
      )}

      {s === 'blocked' && (
        <section className="field-card"><h2>Blocked</h2><p className="is-warn">{task.blocker}</p><div className="field-actions"><Btn kind="primary" onClick={() => act({ type: 'unblock' })}>Resume</Btn></div></section>
      )}
      {s === 'submitted_for_review' && <section className="field-card"><h2>Submitted</h2><p>Waiting for engineer review. Your submission is preserved even if changes are requested.</p></section>}
      {s === 'completed' && <section className="field-card"><h2>Work completed</h2><p>Logged at {wallClock(t)}. The incident stays open until someone with authority resolves it.</p></section>}

      {['accepted', 'en_route', 'at_asset', 'in_progress'].includes(s) && (
        <section className="field-card field-block">
          <label className="field-input">Can't proceed?
            <input value={blocker} onChange={(e) => setBlocker(e.target.value)} placeholder="Parts, access, unsafe condition…" />
          </label>
          <Btn kind="danger" disabled={!blocker} onClick={() => { if (act({ type: 'block', reason: blocker })) setBlocker(''); }}>Mark blocked</Btn>
        </section>
      )}
    </div>
  );
}
