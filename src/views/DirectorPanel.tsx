import { useState } from 'react';
import type { Incident } from '../domain/types';
import { api, useBridge } from '../state/bridge';
import { makeEvent, useOps } from '../state/store';
import { Btn, Src } from '../components/primitives';

/** Client mirror of server/director DirectorResult (kept structural so the web bundle has no server imports). */
export interface DirectorResultView {
  provider: 'nemotron' | 'local_planner';
  model: string | null;
  steps: { tool: string; args: unknown; summary: string; runId?: string }[];
  recommendation: {
    nextScan: { assetId: string; point: string; reason: string; holdS: number } | null;
    nextAction: string;
    hypotheses: { label: string; support: string; runIds: string[] }[];
    summary: string;
  };
  runs?: Record<string, unknown>;
  warnings?: string[];
  fallbackReason?: string;
  elapsedMs: number;
}

/**
 * Nemotron as the simulation director: it chooses which what-if runs to execute on the deterministic
 * engine, compares them, and picks the physical scan that would most change what the team does first.
 */
export function DirectorPanel({ incident }: { incident: Incident }) {
  const { state, dispatch } = useOps();
  const b = useBridge();
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<DirectorResultView | null>(null);
  const [err, setErr] = useState('');
  const [requested, setRequested] = useState(false);

  const run = async () => {
    setBusy(true); setErr(''); setRequested(false);
    try {
      const r = await api<DirectorResultView>('/api/director', {
        scenarioId: state.scenarioId, t: state.t,
        incidents: state.incidents.filter((i) => i.openedAt <= state.t && i.status !== 'resolved'),
        scans: b.scans.slice(-20), confirmedEdgeIds: state.confirmedEdgeIds,
        question: `Focus incident: ${incident.id} ${incident.title}`,
      });
      setRes(r);
      dispatch({ type: 'append_event', event: makeEvent(state.t, { kind: 'analysis', actor: r.provider === 'nemotron' ? `Nemotron (${r.model})` : 'local planner', summary: `Simulation director: ${Object.keys(r.runs ?? {}).length} engine runs → ${r.recommendation.nextScan ? `scan ${r.recommendation.nextScan.assetId} (${r.recommendation.nextScan.point})` : r.recommendation.nextAction}`, links: { incidentId: incident.id }, source: r.provider === 'nemotron' ? 'nemotron' : 'local_rules' }) });
    } catch (e) {
      setErr(b.online ? (e as Error).message : 'Bridge offline — the director runs on the bridge (npm run dev).');
    } finally { setBusy(false); }
  };

  const request = async () => {
    const s = res?.recommendation.nextScan;
    if (!s) return;
    try {
      await api('/api/requests', { assetId: s.assetId, point: s.point, reason: s.reason, requestedBy: res!.provider === 'nemotron' ? 'Nemotron director' : 'Local planner', incidentId: incident.id });
      setRequested(true);
      dispatch({ type: 'append_event', event: makeEvent(state.t, { kind: 'task', actor: 'Priya Raman', summary: `Scan requested: ${s.assetId} — ${s.point}`, links: { assetId: s.assetId, incidentId: incident.id }, source: 'operator' }) });
    } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="dir">
      {!res && !busy && (
        <div className="dir-intro">
          <p>The director forms competing explanations, runs each one through the cascade engine, and recommends the single scan whose result would most change what to fix first. The engine computes every number; the director chooses and explains.</p>
          <Btn kind="primary" onClick={run}>Run simulation director</Btn>
          <span className="muted small">{b.status?.nemotron.configured ? `Nemotron · ${b.status.nemotron.model}` : 'NVIDIA_API_KEY not set — the deterministic local planner will run instead and say so.'}</span>
        </div>
      )}
      {busy && <p className="dir-busy mono">Planning simulations…</p>}
      {err && <p className="is-warn small">{err}</p>}
      {res && (
        <>
          <div className="an-provider">
            <Src s={res.provider === 'nemotron' ? 'nemotron' : 'local_rules'} />
            <span className="muted small">{res.provider === 'nemotron' ? res.model : `local planner${res.fallbackReason ? ` — ${res.fallbackReason}` : ''}`} · {(res.elapsedMs / 1000).toFixed(1)} s</span>
          </div>
          <ol className="dir-steps">
            {res.steps.map((s, i) => (
              <li key={i}>
                <span className="mono dir-tool">{s.tool}</span>{s.runId && <span className="mono dir-run">{s.runId}</span>}
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
                  <Btn kind="primary" disabled={requested} onClick={request}>{requested ? 'Requested on scanner' : 'Send to scanner'}</Btn>
                  <a className="btn btn-ghost" href={`#/scan?asset=${res.recommendation.nextScan.assetId}`} target="_blank" rel="noopener">Open scanner</a>
                </div>
              </>
            ) : <div className="muted small">No scan would change the order right now.</div>}
            <div className="dir-rec-k">Then</div>
            <div className="small">{res.recommendation.nextAction}</div>
          </div>
          <p className="small">{res.recommendation.summary}</p>
          {res.warnings && res.warnings.length > 0 && <p className="muted small">Validator: {res.warnings.join('; ')}</p>}
          <Btn kind="ghost" onClick={run}>Run again</Btn>
        </>
      )}
    </div>
  );
}
