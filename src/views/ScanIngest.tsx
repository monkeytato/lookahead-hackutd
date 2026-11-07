import { useEffect, useRef } from 'react';
import { useBridge } from '../state/bridge';
import { makeEvent, useOps } from '../state/store';
import { scanToEvidence } from '../state/scanMapping';
import { SERVICE_LABEL } from './directorTypes';

/** Invisible: turns each new bridge scan into dashboard evidence exactly once, and logs automatic re-plans. */
export function ScanIngest() {
  const { scans, plans } = useBridge();
  const { state, dispatch, run } = useOps();
  const loggedPlans = useRef(new Set<string>());

  useEffect(() => {
    const fresh = scans.filter((s) => s.status === 'complete' && s.endedAt >= state.sessionStartedAt && !state.ingestedScanIds.includes(s.id));
    if (!fresh.length) return;
    let sessionCount = state.verifications.length;
    for (const scan of fresh) {
      const readings = run.readingsAt(state.t);
      const ev = scanToEvidence(scan, { t: state.t, incidents: state.incidents, readings, sessionCount });
      if (ev.session) sessionCount++;
      dispatch({
        type: 'ingest_scan', scanId: scan.id, reading: ev.reading, session: ev.session, incident: ev.incident,
        event: makeEvent(state.t, { kind: 'verification', actor: scan.operator, summary: ev.summary, links: { assetId: scan.assetId, incidentId: ev.incident?.id }, source: scan.source === 'live' ? 'live' : 'simulated' }),
      });
    }
  }, [scans, state.sessionStartedAt, state.ingestedScanIds, state.t, state.incidents, state.verifications.length, run, dispatch]);

  // automatic re-plans happen on the bridge with no click — record them in the shared log
  useEffect(() => {
    for (const p of plans) {
      if (p.trigger === 'operator' || loggedPlans.current.has(p.id) || p.at < state.sessionStartedAt) continue;
      loggedPlans.current.add(p.id);
      const r = p.result;
      const ext = [...new Set(r.steps.filter((s) => s.service).map((s) => SERVICE_LABEL[s.service!]))];
      dispatch({ type: 'append_event', event: makeEvent(state.t, {
        kind: 'analysis', actor: r.provider === 'nemotron' ? `Nemotron (${r.model})` : 'local planner',
        summary: `Director re-planned automatically (plan ${p.generation}, after ${p.trigger.replace('scan:', 'scan ')}): ${r.recommendation.nextScan ? `next scan ${r.recommendation.nextScan.assetId}` : 'no further scan'}${ext.length ? ` · ${ext.join(' + ')}` : ''}`,
        links: {}, source: r.provider === 'nemotron' ? 'nemotron' : 'local_rules',
      }) });
    }
  }, [plans, state.sessionStartedAt, state.t, dispatch]);

  return null;
}
