import { describe, expect, it } from 'vitest';
import { MAX_RUNS_PER_SESSION, createSession, dispatchTool } from '../../server/director';
import { leakInput } from './helpers';

const err = (o: { content: unknown }) => (o.content as { error: string }).error;

describe('director tools', () => {
  it('rejects unknown asset / incident / edge / tool ids with a message for the model', () => {
    const s = createSession(leakInput());
    const a = dispatchTool(s, 'scan_value', JSON.stringify({ assetId: 'BATT-Z', metric: 'leak' }));
    expect(a.ok).toBe(false);
    expect(err(a)).toMatch(/unknown asset id "BATT-Z"/);
    expect(err(dispatchTool(s, 'run_scenario', { label: 'x', assumeEvidence: [{ incidentId: 'INC-9', verdict: 'corroborated_abnormal' }] }))).toMatch(/unknown incident id/);
    expect(err(dispatchTool(s, 'run_scenario', { label: 'x', confirmEdges: ['E-99999'] }))).toMatch(/unknown edge id/);
    expect(err(dispatchTool(s, 'run_scenario', { label: 'x', extraFaults: [{ assetId: 'CRAH-2', t: 999 }] }))).toMatch(/within 0/);
    expect(dispatchTool(s, 'rm_rf', {}).ok).toBe(false);
    expect(s.runs.size).toBe(0);
  });

  it('flags malformed JSON arguments without throwing', () => {
    const s = createSession(leakInput());
    const r = dispatchTool(s, 'run_scenario', '{"label": "oops", ');
    expect(r.ok).toBe(false);
    expect(r.invalidJson).toBe(true);
  });

  it('run_scenario covers "CRAH-2 trips in 10 min" and "leak also reaches BATT-B" (candidate edge)', () => {
    const s = createSession(leakInput());
    dispatchTool(s, 'get_situation', {});
    const trip = dispatchTool(s, 'run_scenario', { label: 'CRAH-2 trips in 10 min', extraFaults: [{ assetId: 'CRAH-2', inMin: 10 }] });
    expect(trip.ok).toBe(true);
    expect(trip.runId).toBe('run-2');
    expect(dispatchTool(s, 'run_scenario', { label: 'riser drains to battery room', confirmEdges: ['E-223'] }).ok).toBe(true);
    const again = dispatchTool(s, 'run_scenario', { label: 'same thing, new label', extraFaults: [{ assetId: 'CRAH-2', t: 35 }] });
    expect((again.content as { reused: boolean }).reused).toBe(true);
    expect(dispatchTool(s, 'compare_runs', { a: 'run-1', b: 'run-2' }).ok).toBe(true);
    expect(dispatchTool(s, 'compare_runs', { a: 'run-1', b: 'run-42' }).ok).toBe(false);
  });

  it('suppressing the leaking pipe removes the whole water layer', () => {
    const s = createSession(leakInput());
    dispatchTool(s, 'get_situation', {});
    const r = dispatchTool(s, 'run_scenario', { label: 'no leak — meter fault', suppressFaults: ['PIPE-L2'] });
    const run = s.runs.get(r.runId!)!;
    expect(run.wetArrivals).toEqual([]);
    expect(run.firstRackLoss).toBeNull();
  });

  it('caps engine runs per session', () => {
    const s = createSession(leakInput());
    let last = dispatchTool(s, 'get_situation', {});
    for (let i = 0; i < MAX_RUNS_PER_SESSION + 2; i++) last = dispatchTool(s, 'run_scenario', { label: `f${i}`, extraFaults: [{ assetId: 'CRAH-1', t: i }] });
    expect(s.runs.size).toBe(MAX_RUNS_PER_SESSION);
    expect(err(last)).toMatch(/run cap/);
  });

  it('recommend requires runs and known run / asset ids', () => {
    const s = createSession(leakInput());
    const rec = { nextScan: null, nextAction: 'x', summary: 'y', hypotheses: [{ label: 'h', support: 's', runIds: ['run-1'] }] };
    expect(dispatchTool(s, 'recommend', rec).ok).toBe(false);
    dispatchTool(s, 'get_situation', {});
    expect(dispatchTool(s, 'recommend', { ...rec, hypotheses: [{ label: 'h', support: 's', runIds: ['run-7'] }] }).ok).toBe(false);
    expect(dispatchTool(s, 'recommend', { ...rec, nextScan: { assetId: 'NOPE', point: 'p', reason: 'r' } }).ok).toBe(false);
    const ok = dispatchTool(s, 'recommend', rec);
    expect(ok.ok).toBe(true);
    expect(ok.terminal).toBe(true);
  });

  it('drops malformed incidents from untrusted input', () => {
    const s = createSession({ ...leakInput(), incidents: [{ id: 'X', rootAssetId: 'NOT-AN-ASSET' } as never, ...leakInput().incidents] });
    expect(s.incidents.map((i) => i.id)).not.toContain('X');
    expect(s.incidents).toHaveLength(4);
  });
});
