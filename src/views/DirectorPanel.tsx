import { useMemo, useState } from 'react';
import type { Incident } from '../domain/types';
import { api, useBridge } from '../state/bridge';
import { makeEvent, useOps } from '../state/store';
import { Btn, Src } from '../components/primitives';
import { SERVICE_LABEL, type DirectorRecordView, type DirectorResultView, type PendingActionView } from './directorTypes';

export type { DirectorResultView } from './directorTypes';

/**
 * NVIDIA Nemotron as the simulation director — an agent, not a chat:
 *  1. reads the situation and the outside world (Rack Monitor, NWS weather),
 *  2. runs counterfactual simulations on the deterministic engine,
 *  3. queues the scan with the highest decision value on technicians' phones,
 *  4. proposes (never executes) hardware commands and tickets — a person approves them here,
 *  5. RE-PLANS ON ITS OWN when the scan it asked for comes back.
 */
export function DirectorPanel({ incident }: { incident: Incident }) {
  const { state, dispatch } = useOps();
  const b = useBridge();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [manualRequested, setManualRequested] = useState<string | null>(null);

  const latest = b.plans.at(-1) ?? null;
  const chain = useMemo(() => (latest ? b.plans.filter((p) => p.chainId === latest.chainId).sort((x, y) => x.generation - y.generation) : []), [b.plans, latest]);
  const prev = chain.length > 1 ? chain[chain.length - 2] : null;
  const res = latest?.result ?? null;

  const run = async () => {
    setBusy(true); setErr(''); setManualRequested(null);
    try {
      const r = await api<DirectorResultView>('/api/director', {
        scenarioId: state.scenarioId, t: state.t,
        incidents: state.incidents.filter((i) => i.openedAt <= state.t && i.status !== 'resolved'),
        scans: b.scans.slice(-20), confirmedEdgeIds: state.confirmedEdgeIds,
        question: `Focus incident: ${incident.id} ${incident.title}`,
      });
      logPlan(r, 'operator');
    } catch (e) {
      setErr(b.online ? (e as Error).message : 'Bridge offline — the director runs on the bridge (npm run dev).');
    } finally { setBusy(false); }
  };

  const logPlan = (r: DirectorResultView, trigger: string) => {
    const ext = r.steps.filter((s) => s.service).map((s) => SERVICE_LABEL[s.service!]);
    dispatch({ type: 'append_event', event: makeEvent(state.t, {
      kind: 'analysis', actor: r.provider === 'nemotron' ? `Nemotron (${r.model})` : 'local planner',
      summary: `Simulation director plan ${r.generation ?? 1}${trigger !== 'operator' ? ` (auto, ${trigger})` : ''}: ${Object.keys(r.runs ?? {}).length} engine runs${ext.length ? `, ${[...new Set(ext)].join(' + ')}` : ''} → ${r.recommendation.nextScan ? `scan ${r.recommendation.nextScan.assetId}` : r.recommendation.nextAction.slice(0, 80)}`,
      links: { incidentId: incident.id }, source: r.provider === 'nemotron' ? 'nemotron' : 'local_rules',
    }) });
  };

  const requestManually = async () => {
    const s = res?.recommendation.nextScan;
    if (!s) return;
    try {
      const q = await api<{ id: string }>('/api/requests', { assetId: s.assetId, point: s.point, reason: s.reason, requestedBy: 'Priya Raman', incidentId: incident.id });
      setManualRequested(q.id);
    } catch (e) { setErr((e as Error).message); }
  };

  const queued = res?.queuedRequests?.find((q) => q.assetId === res.recommendation.nextScan?.assetId) ?? null;
  const queueOpen = queued && b.requests.some((r) => r.id === queued.id);
  const pending = b.actions.filter((a) => a.status === 'pending');
  const decided = b.actions.filter((a) => a.status !== 'pending').slice(-3).reverse();

  return (
    <div className="dir">
      {!res && !busy && (
        <div className="dir-intro">
          <p>The director checks the rig and the weather, runs competing explanations through the cascade engine, queues the scan whose result would most change what to fix first, and re-plans by itself when that scan comes back. The engine computes every number. Hardware commands and tickets wait for your approval.</p>
          <Btn kind="primary" onClick={run}>Run simulation director</Btn>
          <span className="muted small">{b.status?.nemotron.configured ? `Nemotron · ${b.status.nemotron.model}` : 'NVIDIA_API_KEY not set — the deterministic local planner runs the same tools and says so.'}</span>
        </div>
      )}
      {(busy || b.replanning) && (
        <p className="dir-busy mono">{b.replanning ? `Re-planning automatically — plan ${b.replanning.generation} after ${b.replanning.trigger.replace('scan:', 'scan ')}…` : 'Planning simulations…'}</p>
      )}
      {err && <p className="is-warn small">{err}</p>}

      {res && latest && (
        <>
          <div className="dir-head">
            <span className="dir-gen mono">Plan {latest.generation}</span>
            <span className="small">{latest.trigger === 'operator' ? 'requested by operator' : <>automatic re-plan after <span className="mono">{latest.trigger.replace('scan:', '')}</span></>}</span>
            <span className="dir-head-r"><Src s={res.provider === 'nemotron' ? 'nemotron' : 'local_rules'} /> <span className="muted small">{res.provider === 'nemotron' ? res.model : 'local planner'} · {(res.elapsedMs / 1000).toFixed(1)} s</span></span>
          </div>
          {res.fallbackReason && <p className="muted small">{res.fallbackReason}</p>}
          {prev && <PlanDiff prev={prev} cur={latest} />}

          <ol className="dir-steps">
            {res.steps.map((s, i) => (
              <li key={i} className={`${s.service ? 'is-ext' : ''} ${s.ok ? '' : 'is-err'}`}>
                <span className="mono dir-tool">{s.tool}</span>
                {s.service && <span className="dir-svc mono">{SERVICE_LABEL[s.service]}</span>}
                {s.runId && <span className="mono dir-run">{s.runId}</span>}
                <div className="dir-sum">{s.summary}</div>
              </li>
            ))}
          </ol>

          {res.recommendation.hypotheses.length > 0 && (
            <>
              <h4>Hypotheses tested</h4>
              <ul>{res.recommendation.hypotheses.map((h, i) => <li key={i}><strong>{h.label}</strong> — {h.support} {h.runIds.map((r) => <span key={r} className="cite mono">[{r}]</span>)}</li>)}</ul>
            </>
          )}

          <div className="dir-rec">
            <div className="dir-rec-k">Next scan</div>
            {res.recommendation.nextScan ? (
              <>
                <div className="dir-rec-v"><span className="mono">{res.recommendation.nextScan.assetId}</span> · {res.recommendation.nextScan.point} · hold {res.recommendation.nextScan.holdS} s</div>
                <div className="small">{res.recommendation.nextScan.reason}</div>
                <div className="dir-rec-actions">
                  {queued ? (
                    <span className="dir-queued">{queueOpen ? <>Queued on scanner by the director · <span className="mono">{queued.id}</span> · it will re-plan when the result lands</> : <>Scan <span className="mono">{queued.id}</span> done</>}</span>
                  ) : (
                    <Btn kind="primary" disabled={!!manualRequested} onClick={requestManually}>{manualRequested ? 'Requested on scanner' : 'Send to scanner'}</Btn>
                  )}
                </div>
              </>
            ) : <div className="muted small">No scan would change the order right now.</div>}
            <div className="dir-rec-k">Then</div>
            <div className="small">{res.recommendation.nextAction}</div>
          </div>
          <p className="small">{res.recommendation.summary}</p>

          {(pending.length > 0 || decided.length > 0) && <Approvals pending={pending} decided={decided} />}

          {res.warnings && res.warnings.length > 0 && <p className="muted small">Validator: {res.warnings.join('; ')}</p>}
          {chain.length > 1 && (
            <p className="muted small">Chain: {chain.map((p) => `plan ${p.generation}${p.result.recommendation.nextScan ? ` → ${p.result.recommendation.nextScan.assetId}` : ' → no scan'}`).join(' · ')}</p>
          )}
          <Btn kind="ghost" onClick={run} disabled={busy}>Run again</Btn>
        </>
      )}
    </div>
  );
}

function PlanDiff({ prev, cur }: { prev: DirectorRecordView; cur: DirectorRecordView }) {
  const a = prev.result.recommendation, c = cur.result.recommendation;
  const scanA = a.nextScan ? `${a.nextScan.assetId} · ${a.nextScan.point}` : 'no scan';
  const scanC = c.nextScan ? `${c.nextScan.assetId} · ${c.nextScan.point}` : 'no scan';
  return (
    <div className="dir-diff">
      <div className="dir-rec-k">What changed since plan {prev.generation}</div>
      <div className="small">Next scan: <s>{scanA}</s> → <strong>{scanC}</strong></div>
    </div>
  );
}

function Approvals({ pending, decided }: { pending: PendingActionView[]; decided: PendingActionView[] }) {
  const { state, dispatch } = useOps();
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (a: PendingActionView, d: 'approve' | 'reject') => {
    setBusy(a.id);
    try {
      const r = await api<PendingActionView>(`/api/actions/${a.id}/${d}`, { by: 'Priya Raman' });
      dispatch({ type: 'append_event', event: makeEvent(state.t, { kind: 'note', actor: 'Priya Raman', summary: `${d === 'approve' ? 'Approved' : 'Rejected'} ${a.kind === 'rig_command' ? `rig command "${(a.payload as { cmd: string }).cmd}"` : `ticket "${(a.payload as { title: string }).title}"`} proposed by ${a.proposedBy} → ${r.status}${r.result ? ` (${r.result})` : ''}`, links: { incidentId: a.incidentId }, source: 'operator' }) });
    } finally { setBusy(null); }
  };
  return (
    <div className="dir-approvals">
      <div className="dir-rec-k">Awaiting your approval</div>
      {pending.length === 0 && <p className="muted small">Nothing pending.</p>}
      {pending.map((a) => (
        <div key={a.id} className="dir-act">
          <div className="dir-act-h">
            <span className="tag">{a.kind === 'rig_command' ? 'rig command' : 'ticket'}</span>
            <strong className={a.kind === 'rig_command' ? 'mono' : ''}>{a.kind === 'rig_command' ? (a.payload as { cmd: string }).cmd : (a.payload as { title: string }).title}</strong>
          </div>
          <div className="small">{a.reason}</div>
          <div className="muted small">Proposed by {a.proposedBy}{a.incidentId ? ` · ${a.incidentId}` : ''}</div>
          <div className="dir-rec-actions">
            <Btn kind="primary" disabled={busy === a.id} onClick={() => decide(a, 'approve')}>Approve</Btn>
            <Btn kind="ghost" disabled={busy === a.id} onClick={() => decide(a, 'reject')}>Reject</Btn>
          </div>
        </div>
      ))}
      {decided.map((a) => (
        <div key={a.id} className="dir-act is-done small">
          <span className={`st st-${a.status === 'executed' ? 'completed' : a.status === 'failed' ? 'blocked' : 'cancelled'}`}>{a.status}</span>{' '}
          {a.kind === 'rig_command' ? <span className="mono">{(a.payload as { cmd: string }).cmd}</span> : (a.payload as { title: string }).title}
          {a.url ? <> · <a href={a.url} target="_blank" rel="noopener">issue</a></> : a.result ? <span className="muted"> · {a.result}</span> : null}
          {a.decidedBy && <span className="muted"> · {a.decidedBy}</span>}
        </div>
      ))}
    </div>
  );
}
