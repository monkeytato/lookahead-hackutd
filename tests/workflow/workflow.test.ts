import { describe, expect, it } from 'vitest';
import { changeWork, emptyWork, reviewWork, type WorkCommand } from '../../src/domain/workflow';
import { createWorkflowHub } from '../../server/workflowHub';
import type { Scan } from '../../src/domain/rig/protocol';
import type { DirectorResult } from '../../server/director/types';

const result: DirectorResult = { provider: 'local_planner', model: null, steps: [], recommendation: { nextScan: null, nextAction: 'Verify first', hypotheses: [], summary: 'Independent evidence needed.' }, runs: {}, warnings: [], elapsedMs: 1 };
function driver() {
  let s = emptyWork(), n = 0;
  return { get state() { return s; }, send(cmd: WorkCommand) { s = changeWork(s, cmd, 'Test operator', new Date().toISOString(), `test-${++n}`); return s; } };
}
function hub(scans: Scan[] = []) { return createWorkflowHub({ save() {}, latest: () => null, scans: () => scans, plan: async () => result }); }
function scan(assetId: string): Scan {
  const now = new Date().toISOString();
  return { id: 'SCAN-1', assetId, point: 'Front inlet temperature', deviceId: 'physical-test', firmware: '1', source: 'live', operator: 'Test', startedAt: now, endedAt: now, durationS: 10, frames: 10, status: 'complete', channels: { ref_c: { n: 10, mean: 22, min: 22, max: 22, sd: 0, slopePerMin: 0, unit: '°C' } }, quality: [] };
}

describe('shared incident lifecycle', () => {
  it('requires owner, evidence, completed steps and an outcome; records provenance', () => {
    const d = driver(); d.send({ type: 'simulate_error', kind: 'sensor' }); const id = d.state.issues[0].id;
    expect(() => d.send({ type: 'resolve', issueId: id, note: 'Nothing done' })).toThrow();
    expect(() => d.send({ type: 'check', issueId: id, stepId: 'act', done: true })).toThrow(/Assign/);
    d.send({ type: 'verify_fixture', issueId: id });
    expect(d.state.issues[0].evidence?.source).toBe('fixture');
    expect(d.state.issues[0].evidence?.verdict).toBe('disagrees');
    d.send({ type: 'assign', issueId: id, employeeId: 'emp-marcus' });
    expect(() => d.send({ type: 'check', issueId: id, stepId: 'verify', done: true })).toThrow();
    for (const stepId of ['locate','act','recheck']) d.send({ type: 'check', issueId: id, stepId, done: true });
    d.send({ type: 'resolve', issueId: id, note: 'Inspected sensor placement. Recheck agrees with reference.' });
    expect(d.state.issues[0].status).toBe('resolved');
    expect(d.state.events.at(-1)?.source).toBe('operator-confirmed outcome');
    expect(reviewWork(d.state)).toEqual([]);
    expect(() => d.send({ type: 'verify_fixture', issueId: id })).toThrow(/closed/);
  });
  it('rejects duplicate active warnings and includes unassigned work in handoff', () => {
    const d = driver(); d.send({ type: 'simulate_error', kind: 'water' });
    expect(() => d.send({ type: 'simulate_error', kind: 'water' })).toThrow(/already active/);
    expect(reviewWork(d.state).join(' ')).toMatch(/evidence.*technician.*checklist/);
    d.send({ type: 'review' }); expect(d.state.events.at(-1)?.source).toBe('rule-based review');
  });
});

describe('bridge contract used by SwiftUI and web', () => {
  it('shares warning and assignment state and rejects unqualified staff', async () => {
    const h = hub();
    await h.command({ type: 'simulate_error', kind: 'vibration' });
    const id = h.snapshot().issues[0].id;
    await expect(h.command({ type: 'assign', issueId: id, employeeId: 'emp-sofia' })).rejects.toThrow(/required skill/);
    await h.command({ type: 'assign', issueId: id, employeeId: 'emp-marcus' });
    expect(h.snapshot().issues[0].ownerId).toBe('emp-marcus');
    expect(h.snapshot().revision).toBe(2);
    await expect(h.command({ type: 'evidence', issueId: id, evidence: { value: 999 } })).rejects.toThrow(/Unknown/);
  });
  it('attaches only complete recent scans at the right equipment and point', async () => {
    const scans: Scan[] = []; const h = hub(scans);
    await h.command({ type: 'simulate_error', kind: 'sensor' }); const id = h.snapshot().issues[0].id;
    scans.push(scan('CRAH-2'));
    await expect(h.command({ type: 'verify_scan', issueId: id, scanId: 'SCAN-1' })).rejects.toThrow(/recent scan/);
    scans[0] = scan('A-11'); scans[0].point = 'Floor / leak';
    await expect(h.command({ type: 'verify_scan', issueId: id, scanId: 'SCAN-1' })).rejects.toThrow(/point/);
    scans[0].point = 'Front inlet temperature';
    await h.command({ type: 'verify_scan', issueId: id, scanId: 'SCAN-1' });
    expect(h.snapshot().issues[0].evidence?.verdict).toBe('disagrees');
    expect(h.snapshot().issues[0].evidence?.source).toBe('live');
    scans[0].quality = ['acoustic_ref_disagree'];
    await h.command({ type: 'verify_scan', issueId: id, scanId: 'SCAN-1' });
    expect(h.snapshot().issues[0].evidence?.verdict).toBe('inconclusive');
  });
  it('keeps simulated sensor evidence labelled and refuses stale scans', async () => {
    const scans: Scan[] = []; const h = hub(scans);
    await h.command({ type: 'simulate_error', kind: 'sensor' }); const id = h.snapshot().issues[0].id;
    scans.push(scan('A-11')); scans[0].source = 'simulated';
    await h.command({ type: 'verify_scan', issueId: id, scanId: 'SCAN-1' });
    expect(h.snapshot().issues[0].evidence?.source).toBe('simulated');
    scans[0].endedAt = '2020-01-01T00:00:00Z';
    await expect(h.command({ type: 'verify_scan', issueId: id, scanId: 'SCAN-1' })).rejects.toThrow();
  });
  it('records the actual evaluation provider rather than labelling fallback Nemotron', async () => {
    const h = hub(); await h.command({ type: 'simulate_error', kind: 'water' });
    await h.command({ type: 'evaluate', issueId: h.snapshot().issues[0].id });
    expect(h.snapshot().analyses[0].provider).toBe('local_planner');
    expect(h.snapshot().events.at(-1)?.source).toBe('local_planner');
  });
});

describe('cross-device evaluation races', () => {
  it('does not attach an old AI result after the presenter starts a new session', async () => {
    let finish!: (r: DirectorResult) => void;
    const pending = new Promise<DirectorResult>(resolve => { finish = resolve; });
    const h = createWorkflowHub({ save() {}, latest: () => null, scans: () => [], plan: () => pending });
    await h.command({ type: 'simulate_error', kind: 'sensor' });
    const evaluation = h.command({ type: 'evaluate', issueId: h.snapshot().issues[0].id });
    await h.command({ type: 'reset' }); finish(result);
    await expect(evaluation).rejects.toThrow(/Session changed/);
    expect(h.snapshot().analyses).toHaveLength(0);
    expect(h.snapshot().analyzing).toBe(false);
  });
});
