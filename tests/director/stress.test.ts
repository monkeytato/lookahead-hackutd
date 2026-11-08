/** Red-team loop, structured context and the extended validator (PREDICTION-SCIENCE.md §6 Steps 4–6). */
import { describe, expect, it } from 'vitest';
import { runDirector } from '../../server/director';
import { createSession, dispatchTool } from '../../server/director/tools';
import { validateRecommendation } from '../../server/director/validate';
import type { DirectorInput } from '../../server/director/types';
import { KEY_ENV, leakInput, scriptedFetch } from './helpers';

const inc = (assetId: string) => ({ id: 'INC-T', title: `Test warning at ${assetId}`, rootAssetId: assetId, alertAssetIds: [assetId], severity: 'warning' as const, status: 'open' as const, evidence: 'unverified' as const, openedAt: 0, shiftLeadId: 'emp-priya', summary: 'injected', recentChanges: [] });
const evalInput = (kind: 'heat' | 'water', over: Partial<DirectorInput> = {}): DirectorInput => ({
  scenarioId: kind === 'heat' ? 'incident-chiller-trip' : 'incident-riser-leak', t: kind === 'heat' ? 2 : 12, incidents: [inc(kind === 'heat' ? 'CH-1' : 'PIPE-L2')], scans: [], confirmedEdgeIds: [],
  question: 'Evaluate the response.', context: { events: [{ id: 'ev-1', at: '02:10', summary: 'Warning injected from demo controller.' }, { id: 'ev-2', at: '02:11', summary: 'Operator note: valve V-7 serviced yesterday.' }], notes: [] },
  evaluation: { kind, pReal: kind === 'heat' ? 0.5 : 0.98 }, ...over,
});

describe('structured log context (audit C6)', () => {
  it('passes events as a structured field (capped) instead of truncated prose', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, at: 't', summary: `event ${i} ${'x'.repeat(300)}` }));
    const s = createSession(evalInput('water', { context: { events: many, notes: ['n'.repeat(400)] } }));
    expect(s.context.events).toHaveLength(20);
    expect(s.context.events[0].id).toBe('e10');
    expect(s.context.events.every((e) => e.summary.length <= 200)).toBe(true);
    expect(s.context.notes[0].length).toBe(200);
    const out = dispatchTool(s, 'get_context', {});
    expect(out.ok).toBe(true);
    expect((out.content as { events: unknown[] }).events).toHaveLength(20);
  });

  it('stress tools are refused outside an evaluation session', () => {
    const s = createSession(leakInput());
    expect(dispatchTool(s, 'stress_digest', {}).ok).toBe(false);
  });
});

describe('local planner evaluation (cross-entropy fallback)', () => {
  it('water: ensemble, CE stress round and EVSI next scan, every number validated', async () => {
    const t0 = Date.now();
    const r = await runDirector(evalInput('water'), { env: {} });
    expect(Date.now() - t0).toBeLessThan(3000); // dossier: ≤ 3 s for the local fallback
    expect(r.provider).toBe('local_planner');
    expect(r.warnings).toEqual([]);
    const e = r.evaluation!;
    expect(e.trials).toBe(2048);
    expect(e.options[0].id).toBe('none');
    expect(e.withOptionId).toBe('isolate_valve:PIPE-L2');
    expect(e.options[0].pServiceDown).toBeGreaterThan(e.options.find((o) => o.id === e.withOptionId)!.pServiceDown);
    expect(e.stress?.by).toBe('cross_entropy');
    expect(e.nextScan?.metric).toBe('leak');
    expect(r.recommendation.summary).toMatch(/stress-1/);
    expect(r.steps.map((s) => s.tool)).toEqual(expect.arrayContaining(['get_context', 'stress_digest', 'stress_test', 'recommend']));
  });
});

describe('Nemotron red-team loop (mocked endpoint)', () => {
  it('Nemotron proposes regions in the closed grammar; invalid terms are rejected; numbers come from the engine', async () => {
    const proposals = [
      { label: 'CH-2 also trips and the restart is slow', rationale: 'compound', terms: [{ family: 'h:ch2', op: 'force', value: 1 }, { family: 'chiller_restart_min', op: 'quantile_window', lo: 0.8, hi: 1 }] },
      { label: 'restart fails', terms: [{ family: 'chiller_restart_fail', op: 'set_p', p: 0.9 }] }, // set_p > 0.5: rejected
      { label: 'made-up family', terms: [{ family: 'meteor_strike', op: 'force', value: 1 }] }, // rejected
    ];
    const { fetchImpl, requests } = scriptedFetch([
      { toolCalls: [{ name: 'get_context', arguments: '{}' }, { name: 'stress_digest', arguments: '{}' }] },
      { toolCalls: [{ name: 'stress_test', arguments: JSON.stringify({ option: 'restart_chiller:CH-1', proposals }) }] },
      { toolCalls: [{ name: 'recommend', arguments: JSON.stringify({ nextScan: null, nextAction: 'Restart CH-1 per runbook (stress-1).', summary: 'The dominant remaining failure is CH-2 also tripping with a slow restart (stress-2): 3.2 % of incidents. The rig is trustworthy.', hypotheses: [{ label: 'CH-2 also trips', support: 'stress-2', runIds: ['stress-2'] }] }) }] },
    ]);
    const r = await runDirector(evalInput('heat'), { env: KEY_ENV, fetchImpl });
    expect(r.provider).toBe('nemotron');
    const names = (requests[0].body.tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['get_context', 'stress_digest', 'stress_test']));
    expect(requests[0].body.messages[0].content).toMatch(/closed grammar/);
    const e = r.evaluation!;
    expect(e.stress?.by).toBe('nemotron');
    expect(e.stress?.rejected.join(' ')).toMatch(/set_p needs|unknown family/);
    expect(e.stress?.regions[0].label).toMatch(/CH-2 also trips/);
    expect(e.stress!.maxWeight).toBeLessThanOrEqual(1 / 0.3 + 1e-9);
    // fabricated "3.2 %" and the provenance claim are stripped
    expect(r.recommendation.summary).not.toMatch(/3\.2 %/);
    expect(r.recommendation.summary).not.toMatch(/trustworthy/);
    expect(r.warnings.some((w) => /unsupported_number: "3\.2 %"/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /provenance_claim/.test(w))).toBe(true);
  });
});

describe('validator: counts, odds, direction', () => {
  it('flags "later" next to a negative signed shift and strips an unsupported count / 1-in-N', () => {
    const s = createSession(leakInput());
    dispatchTool(s, 'get_situation', {});
    const v = dispatchTool(s, 'scan_value', { assetId: 'BATT-B', metric: 'leak' }).content as { runIfAbnormal: string; runIfNormal: string; firstRackShiftMin: number; firstRackDirection: string };
    const sh = s.shifts.find((x) => x.what === 'first rack loss' && x.value !== 0)!;
    expect(sh).toBeDefined();
    expect(v.firstRackDirection).toBe(sh.value > 0 ? 'later' : 'earlier');
    const wrongWord = sh.value < 0 ? 'later, which buys time' : 'earlier, so there is less time';
    const rec = { nextScan: null, nextAction: 'x', hypotheses: [{ label: 'h', support: 's', runIds: [sh.a, sh.b] }],
      summary: `A normal reading moves the first rack loss ${Math.abs(sh.value)} min ${wrongWord} (${sh.a} vs ${sh.b}). About 1 in 400 incidents lose 37 racks.` };
    const out = validateRecommendation(rec, s);
    expect(out.warnings.some((w) => /direction_mismatch/.test(w))).toBe(true);
    expect(out.recommendation.summary).toMatch(/^Engine: the first rack loss is/);
    expect(out.warnings.some((w) => /"1 in 400"/.test(w))).toBe(true);
    expect(out.warnings.some((w) => /"37 racks"/.test(w))).toBe(true);
  });
});
