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
  it('requires owner and an outcome; a complete close records provenance without an incomplete flag', () => {
    const d = driver(); d.send({ type: 'simulate_error', kind: 'sensor' }); const id = d.state.issues[0].id;
    expect(() => d.send({ type: 'resolve', issueId: id, note: 'Nothing done' })).toThrow(/Assign/);
    expect(() => d.send({ type: 'check', issueId: id, stepId: 'act', done: true })).toThrow(/Assign/);
    d.send({ type: 'verify_fixture', issueId: id });
    expect(d.state.issues[0].evidence?.source).toBe('fixture');
    expect(d.state.issues[0].evidence?.verdict).toBe('disagrees');
    d.send({ type: 'assign', issueId: id, employeeId: 'emp-marcus' });
    expect(() => d.send({ type: 'check', issueId: id, stepId: 'verify', done: true })).toThrow();
    for (const stepId of ['locate','act','recheck']) d.send({ type: 'check', issueId: id, stepId, done: true });
    // A disagreeing portable reading is conclusive (it points at the installed sensor), so it completes verification.
    d.send({ type: 'evidence', issueId: id, evidence: { value: 22.1, unit: '°C', source: 'simulated', scanId: 'S-1', at: new Date().toISOString(), verdict: 'disagrees', note: 'portable reads normal' } });
    d.send({ type: 'resolve', issueId: id, note: 'Inspected sensor placement. Recheck agrees with reference.' });
    expect(d.state.issues[0].status).toBe('resolved');
    expect(d.state.events.at(-1)?.source).toBe('operator-confirmed outcome');
    expect(d.state.events.at(-1)?.flag).toBeUndefined();
    expect(d.state.issues[0].incomplete).toBeUndefined();
    expect(reviewWork(d.state)).toEqual([]);
    expect(() => d.send({ type: 'verify_fixture', issueId: id })).toThrow(/closed/);
  });
  it('accepts an incomplete submission, flags it, and lists the unchecked steps as a handoff gap', () => {
    const d = driver(); d.send({ type: 'simulate_error', kind: 'water' }); const id = d.state.issues[0].id;
    d.send({ type: 'assign', issueId: id, employeeId: 'emp-marcus' });
    expect(() => d.send({ type: 'resolve', issueId: id, note: 'short' })).toThrow(/8 characters/);
    d.send({ type: 'check', issueId: id, stepId: 'locate', done: true });
    d.send({ type: 'resolve', issueId: id, note: 'Mopped floor, valve closed by facilities.' });
    const issue = d.state.issues[0];
    expect(issue.status).toBe('resolved');
    expect(issue.incomplete).toEqual(['Collect independent sensor evidence', 'Record inspection or response performed', 'Recheck equipment and record outcome']);
    const ev = d.state.events.at(-1)!;
    expect(ev.flag).toBe('incomplete');
    expect(ev.summary).toMatch(/INCOMPLETE.*3 unchecked steps.*Collect independent sensor evidence/);
    expect(reviewWork(d.state)).toEqual([`${issue.assetId}: closed with 3 unchecked steps: Collect independent sensor evidence; Record inspection or response performed; Recheck equipment and record outcome.`]);
    d.send({ type: 'review' }); expect(d.state.events.at(-1)?.summary).toMatch(/closed with 3 unchecked steps/);
  });
  it('treats inconclusive evidence as an unchecked verification step', () => {
    const d = driver(); d.send({ type: 'simulate_error', kind: 'sensor' }); const id = d.state.issues[0].id;
    d.send({ type: 'assign', issueId: id, employeeId: 'emp-marcus' });
    d.send({ type: 'evidence', issueId: id, evidence: { value: 30, unit: '°C', source: 'simulated', scanId: 'S-1', at: new Date().toISOString(), verdict: 'inconclusive', note: 'noisy' } });
    for (const stepId of ['locate','act','recheck']) d.send({ type: 'check', issueId: id, stepId, done: true });
    d.send({ type: 'resolve', issueId: id, note: 'Closed pending a better scan tomorrow.' });
    expect(d.state.issues[0].incomplete).toEqual(['Collect independent sensor evidence']);
    expect(d.state.events.at(-1)?.summary).toMatch(/1 unchecked step \(/);
  });
  it('loads stored state written before the incomplete fields existed', () => {
    const legacy = JSON.parse(JSON.stringify(driver().send({ type: 'simulate_error', kind: 'heat' })));
    const next = changeWork(legacy, { type: 'review' }, 'Test', new Date().toISOString(), 'x-1');
    expect(next.issues[0].incomplete).toBeUndefined();
    expect(next.events.every(e => e.flag === undefined)).toBe(true);
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

describe('Bayesian scan verdicts (audit C3/C4)', () => {
  it('refuses the chiller supply-water alert (air probe cannot measure it) and corroborates a wet floor', async () => {
    const scans: Scan[] = []; const h = hub(scans);
    await h.command({ type: 'simulate_error', kind: 'heat' });
    const heat = h.snapshot().issues[0].id;
    scans.push({ ...scan('CH-1'), point: 'Supply temperature', channels: { ref_c: { n: 10, mean: 31, min: 31, max: 31, sd: 0, slopePerMin: 0, unit: '°C' } } });
    await h.command({ type: 'verify_scan', issueId: heat, scanId: 'SCAN-1' });
    const ev = h.snapshot().issues.find((i) => i.id === heat)!.evidence!;
    expect(ev.verdict).toBe('inconclusive');
    expect(ev.note).toMatch(/Not measurable by the portable rig/);
    await h.command({ type: 'simulate_error', kind: 'water' });
    const water = h.snapshot().issues.find((i) => i.kind === 'water')!.id;
    expect(h.simulatedTruth('PIPE-L2')?.before).toEqual(['sim spill']);
    expect(h.simulatedTruth('A-99')).toBeNull();
    scans[0] = { ...scan('PIPE-L2'), point: 'Floor / leak', channels: { floor_wet: { n: 10, mean: 1, min: 1, max: 1, sd: 0, slopePerMin: 0, unit: 'fraction' } } };
    await h.command({ type: 'verify_scan', issueId: water, scanId: 'SCAN-1' });
    const wet = h.snapshot().issues.find((i) => i.id === water)!.evidence!;
    expect(wet.verdict).toBe('confirmed');
    expect(wet.note).toMatch(/P ≈ 0\.98/);
  });
});

describe('evaluate: each incident in its own scenario, moved by the evidence (audit C2)', () => {
  it('A-11 is evaluated in incident-rack-inlet, and a disagreeing portable reading lowers the risk', async () => {
    const inputs: { scenarioId: string; question?: string; context?: { events: unknown[] }; evaluation?: { pReal: number } }[] = [];
    const h = createWorkflowHub({ save() {}, latest: () => null, scans: () => [], plan: async (input) => { inputs.push(input); return result; } });
    await h.command({ type: 'simulate_error', kind: 'sensor' });
    const id = h.snapshot().issues[0].id;
    await h.command({ type: 'evaluate', issueId: id });
    const before = h.snapshot().analyses[0].comparison!.ensemble!;
    await h.command({ type: 'verify_fixture', issueId: id }); // labelled reference 22.4 °C vs installed 34.2 °C
    await h.command({ type: 'evaluate', issueId: id });
    const after = h.snapshot().analyses[1].comparison!.ensemble!;
    expect(inputs[0].scenarioId).toBe('incident-rack-inlet');
    expect(inputs[0].question!.length).toBeLessThanOrEqual(500);
    expect(inputs[0].context!.events.length).toBeGreaterThan(0);
    expect(before.pReal).toBe(0.5);
    expect(after.pReal).toBeLessThan(0.05);
    expect(after.without.racksMean).toBeLessThan(before.without.racksMean);
    expect(after.coverageNote).toMatch(/Model range/);
    expect(after.trials).toBe(2048);
  });

  it('the chiller alert is not given a free CH-2 trip: risk comes only from the prior-weighted hypothesis', async () => {
    const h = hub(); await h.command({ type: 'simulate_error', kind: 'heat' });
    await h.command({ type: 'evaluate', issueId: h.snapshot().issues[0].id });
    const c = h.snapshot().analyses[0].comparison!;
    expect(c.action).toMatch(/Restart CH-1/);
    expect(c.without).toBe(0); // was 48 racks with the scripted CH-2 trip
    expect(c.ensemble!.without.pServiceDown).toBeLessThan(1e-3);
    expect(c.ensemble!.hypotheses.some((x) => /CH-2 also trips/.test(x.label) && x.basisKind === 'published')).toBe(true);
  });
});
