import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { changeWork, emptyWork, hasIndependentEvidence, reviewWork, stepDone, uncheckedSteps, type Evidence, type WorkCommand, type WorkState } from '../../src/domain/workflow';
import { facility } from '../../src/domain/fixture';
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
const reading = (verdict: Evidence['verdict'], source: Evidence['source'] = 'live'): Evidence => ({ value: 22, unit: '°C', source, scanId: `S-${verdict}`, at: new Date().toISOString(), verdict, note: 'test reading' });

describe('incomplete-submission flags: one rule for every path', () => {
  function ready(kind: 'sensor' | 'water' = 'water') {
    const d = driver(); d.send({ type: 'simulate_error', kind }); const id = d.state.issues[0].id;
    d.send({ type: 'assign', issueId: id, employeeId: 'emp-marcus' });
    for (const stepId of ['locate', 'act', 'recheck']) d.send({ type: 'check', issueId: id, stepId, done: true });
    return { d, id };
  }

  it('flags a close verified only by the scripted fixture reference (no measurement was taken)', () => {
    const { d, id } = ready();
    d.send({ type: 'verify_fixture', issueId: id });
    const open = d.state.issues[0], verify = open.steps.find(s => s.id === 'verify')!;
    expect(verify.done).toBe(true); // stored as before, so older clients still decode it
    expect(hasIndependentEvidence(open)).toBe(false);
    expect(stepDone(open, verify)).toBe(false);
    expect(uncheckedSteps(open)).toEqual(['Collect independent sensor evidence']);
    expect(reviewWork(d.state)).toContain('PIPE-L2: checklist is incomplete.');
    d.send({ type: 'resolve', issueId: id, note: 'Floor dry on arrival, riser joint tightened.' });
    expect(d.state.issues[0].status).toBe('resolved'); // still allowed, only flagged
    expect(d.state.issues[0].incomplete).toEqual(['Collect independent sensor evidence']);
    expect(d.state.events.at(-1)?.flag).toBe('incomplete');
    expect(d.state.events.at(-1)?.source).toBe('operator-submitted outcome · incomplete');
    expect(reviewWork(d.state)).toEqual(['PIPE-L2: closed with 1 unchecked step: Collect independent sensor evidence.']);
  });

  it('flags a fixture that replaced an earlier conclusive scan', () => {
    const { d, id } = ready();
    d.send({ type: 'evidence', issueId: id, evidence: reading('confirmed') });
    expect(uncheckedSteps(d.state.issues[0])).toEqual([]);
    d.send({ type: 'verify_fixture', issueId: id });
    d.send({ type: 'resolve', issueId: id, note: 'Closed after the demo reference reading.' });
    expect(d.state.issues[0].incomplete).toEqual(['Collect independent sensor evidence']);
  });

  it('completes with a conclusive live or simulated scan, confirming or disagreeing', () => {
    for (const [verdict, source] of [['confirmed', 'live'], ['disagrees', 'simulated']] as const) {
      const { d, id } = ready('sensor');
      d.send({ type: 'evidence', issueId: id, evidence: reading(verdict, source) });
      expect(reviewWork(d.state).some(g => /checklist/.test(g))).toBe(false);
      d.send({ type: 'resolve', issueId: id, note: 'Inspected and rechecked; readings recorded.' });
      expect(d.state.issues[0].incomplete).toBeUndefined();
      expect(d.state.events.at(-1)?.flag).toBeUndefined();
    }
  });

  it('flags a step reopened after evidence, and verification undone by a later inconclusive scan', () => {
    const { d, id } = ready();
    d.send({ type: 'evidence', issueId: id, evidence: reading('confirmed') });
    d.send({ type: 'check', issueId: id, stepId: 'recheck', done: false });
    d.send({ type: 'evidence', issueId: id, evidence: reading('inconclusive') });
    d.send({ type: 'resolve', issueId: id, note: 'Leaving it for the day shift to recheck.' });
    expect(d.state.issues[0].incomplete).toEqual(['Collect independent sensor evidence', 'Recheck equipment and record outcome']);
  });

  it('flags stored sessions whose fixture verification predates this rule', () => {
    const { d, id } = ready();
    const stored = JSON.parse(JSON.stringify(d.send({ type: 'verify_fixture', issueId: id }))) as WorkState;
    const next = changeWork(stored, { type: 'resolve', issueId: id, note: 'Closed from an older saved session.' }, 'Test', new Date().toISOString(), 'x-2');
    expect(next.issues[0].incomplete).toEqual(['Collect independent sensor evidence']);
  });

  it('the bridge hub flags the same submission the reducer does', async () => {
    const h = hub();
    await h.command({ type: 'simulate_error', kind: 'water' }); const id = h.snapshot().issues[0].id;
    await h.command({ type: 'assign', issueId: id, employeeId: 'emp-jordan' });
    await h.command({ type: 'verify_fixture', issueId: id });
    for (const stepId of ['locate', 'act', 'recheck']) await h.command({ type: 'check', issueId: id, stepId, done: true });
    await h.command({ type: 'resolve', issueId: id, note: 'Closed with the demo reference only.' });
    expect(h.snapshot().issues[0].incomplete).toEqual(['Collect independent sensor evidence']);
    expect(h.snapshot().events.at(-1)?.flag).toBe('incomplete');
  });
});

describe('operator-created team responses', () => {
  it('creates a response on any facility asset with the standard checklist, location and provenance', () => {
    const d = driver();
    d.send({ type: 'create_response', kind: 'heat', assetId: 'CRAH-3', title: '  Supply air drifting warm  ' });
    const i = d.state.issues[0];
    expect(i).toMatchObject({ kind: 'heat', assetId: 'CRAH-3', title: 'Supply air drifting warm', location: 'Data Hall A · CRAH 3 (east, north)', status: 'acknowledged', installed: 18, unit: '°C' });
    expect(i.steps.map(s => [s.id, s.done])).toEqual([['locate', false], ['verify', false], ['act', false], ['recheck', false]]);
    expect(d.state.events.at(-1)).toMatchObject({ kind: 'response', source: 'operator-created response', issueId: i.id, assetId: 'CRAH-3' });
    expect(d.state.events.at(-1)?.summary).toBe('CRAH-3: Supply air drifting warm. Team response created by operator (cooling failure).');
    d.send({ type: 'create_response', kind: 'water', assetId: 'DRAIN-1', title: 'Water at drain' });
    expect(d.state.issues[1]).toMatchObject({ installed: 0, unit: 'wet', location: 'East corridor · Corridor floor drain' });
  });

  it('offers the scripted demo reference only on the demo warning equipment', () => {
    const d = driver();
    d.send({ type: 'create_response', kind: 'sensor', assetId: 'A-07', title: 'Hot aisle at A-07' });
    expect(() => d.send({ type: 'verify_fixture', issueId: d.state.issues[0].id })).toThrow(/demo warnings only/);
    d.send({ type: 'create_response', kind: 'sensor', assetId: 'A-11', title: 'Hot aisle at A-11' });
    d.send({ type: 'verify_fixture', issueId: d.state.issues[1].id });
    expect(d.state.issues[1].evidence?.source).toBe('fixture');
  });

  it('validates title, equipment and type, and rejects a duplicate open response for the same equipment and type', () => {
    const d = driver();
    expect(() => d.send({ type: 'create_response', kind: 'sensor', assetId: 'A-07', title: ' ab ' })).toThrow(/at least 3/);
    expect(() => d.send({ type: 'create_response', kind: 'sensor', assetId: 'NOPE', title: 'Hot rack' })).toThrow(/equipment/);
    expect(() => d.send({ type: 'create_response', kind: 'fire' as never, assetId: 'A-07', title: 'Hot rack' })).toThrow(/type/);
    d.send({ type: 'create_response', kind: 'sensor', assetId: 'A-07', title: 'x'.repeat(300) });
    expect(d.state.issues[0].title).toHaveLength(120);
    expect(() => d.send({ type: 'create_response', kind: 'sensor', assetId: 'A-07', title: 'Hot rack again' })).toThrow(/already open/);
    d.send({ type: 'create_response', kind: 'vibration', assetId: 'A-07', title: 'Rattling fan tray' }); // other type, same equipment
    expect(d.state.issues).toHaveLength(2);
  });

  it('does not block the demo warning unless it is the same equipment and type', () => {
    const d = driver();
    d.send({ type: 'create_response', kind: 'water', assetId: 'DRAIN-1', title: 'Water at drain' });
    d.send({ type: 'simulate_error', kind: 'water' }); // the PIPE-L2 demo warning still injects
    expect(d.state.issues.map(i => i.assetId)).toEqual(['DRAIN-1', 'PIPE-L2']);
    expect(() => d.send({ type: 'create_response', kind: 'water', assetId: 'PIPE-L2', title: 'Riser drip' })).toThrow(/already open/);
    expect(() => d.send({ type: 'simulate_error', kind: 'water' })).toThrow(/already active/);
    const e = driver();
    e.send({ type: 'create_response', kind: 'water', assetId: 'PIPE-L2', title: 'Riser drip' });
    expect(() => e.send({ type: 'simulate_error', kind: 'water' })).toThrow(/already active/);
  });

  it('runs through the bridge: assign, checklist, scan verification, incomplete submission, history and handoff', async () => {
    const scans: Scan[] = []; const h = hub(scans);
    await expect(h.command({ type: 'create_response', kind: 'sensor', assetId: 'A-07', title: 7 })).rejects.toThrow(/title/);
    await expect(h.command({ type: 'create_response', kind: 'sensor', assetId: { id: 'A-07' }, title: 'Hot rack' })).rejects.toThrow(/equipment/);
    await expect(h.command({ type: 'create_response', kind: 'smoke', assetId: 'A-07', title: 'Hot rack' })).rejects.toThrow(/type/);
    await h.command({ type: 'create_response', kind: 'sensor', assetId: 'A-07', title: 'Customer reports hot rack', actor: 'Priya Raman' });
    const id = h.snapshot().issues[0].id;
    await expect(h.command({ type: 'assign', issueId: id, employeeId: 'emp-sofia' })).rejects.toThrow(/required skill/);
    await h.command({ type: 'assign', issueId: id, employeeId: 'emp-marcus' });
    await h.command({ type: 'check', issueId: id, stepId: 'locate', done: true });
    scans.push(scan('A-07'));
    await h.command({ type: 'verify_scan', issueId: id, scanId: 'SCAN-1' });
    expect(h.snapshot().issues[0].evidence?.scanId).toBe('SCAN-1');
    await expect(h.command({ type: 'evaluate', issueId: id })).rejects.toThrow(/no incident model/);
    const before = uncheckedSteps(h.snapshot().issues[0]);
    await h.command({ type: 'resolve', issueId: id, note: 'Blanking panel refitted; recheck tomorrow.' });
    const s = h.snapshot(), i = s.issues[0];
    expect(i.status).toBe('resolved');
    expect(i.incomplete).toEqual(before);
    expect(i.incomplete).toContain('Record inspection or response performed');
    expect(s.events.at(-1)).toMatchObject({ kind: 'resolution', flag: 'incomplete', issueId: id, assetId: 'A-07' });
    expect(s.events.find(e => e.kind === 'response')?.actor).toBe('Priya Raman');
    expect(reviewWork(s).some(g => g.startsWith('A-07: closed with'))).toBe(true);
  });

  it('caps the number of issues per session', async () => {
    const h = hub();
    for (let n = 0; n < 60; n++) await h.command({ type: 'create_response', kind: 'sensor', assetId: facility.assets[n].id, title: `Response ${n}` });
    await expect(h.command({ type: 'create_response', kind: 'sensor', assetId: facility.assets[60].id, title: 'One too many' })).rejects.toThrow(/new demo session/);
  });
});

describe('static artifact bridge mirrors the laptop bridge', () => {
  beforeAll(() => {
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } });
    vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {} });
  });
  afterAll(() => { vi.unstubAllGlobals(); });

  it('creates a response and flags a fixture-only submission exactly as the server hub does', async () => {
    // Path in a variable: the test tsconfig has no DOM lib, so the browser module is loaded at runtime only.
    const modulePath = '../../src/state/localBridge';
    const { createLocalBridge } = await import(/* @vite-ignore */ modulePath) as { createLocalBridge(): { request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> } };
    const local = createLocalBridge(), server = hub();
    const send = async (cmd: Record<string, unknown>) => {
      const r = await local.request('POST', '/api/workflow', cmd);
      await server.command(cmd);
      return r;
    };
    expect((await local.request('POST', '/api/workflow', { type: 'create_response', kind: 'water', assetId: 'PIPE-L2', title: 'no' })).status).toBe(400);
    await send({ type: 'create_response', kind: 'water', assetId: 'PIPE-L2', title: 'Drip under the riser' });
    const localId = ((await local.request('GET', '/api/workflow')).body as WorkState).issues[0].id;
    const serverId = server.snapshot().issues[0].id;
    for (const [cmd, ids] of [['assign', { employeeId: 'emp-jordan' }], ['verify_fixture', {}], ['check', { stepId: 'locate', done: true }], ['resolve', { note: 'Drain cleared, floor mopped.' }]] as const) {
      expect((await local.request('POST', '/api/workflow', { type: cmd, issueId: localId, ...ids })).status).toBe(200);
      await server.command({ type: cmd, issueId: serverId, ...ids });
    }
    const a = ((await local.request('GET', '/api/workflow')).body as WorkState), b = server.snapshot();
    expect(a.issues[0].incomplete).toEqual(['Collect independent sensor evidence', 'Record inspection or response performed', 'Recheck equipment and record outcome']);
    expect(a.issues[0].incomplete).toEqual(b.issues[0].incomplete);
    expect(a.events.map(e => [e.kind, e.flag, e.source])).toEqual(b.events.map(e => [e.kind, e.flag, e.source]));
  });
});
