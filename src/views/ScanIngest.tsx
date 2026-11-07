import { useEffect } from 'react';
import { useBridge } from '../state/bridge';
import { makeEvent, useOps } from '../state/store';
import { scanToEvidence } from '../state/scanMapping';

/** Invisible: turns each new bridge scan into dashboard evidence exactly once. */
export function ScanIngest() {
  const { scans } = useBridge();
  const { state, dispatch, run } = useOps();

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

  return null;
}
