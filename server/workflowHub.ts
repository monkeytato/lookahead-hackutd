import { changeWork, emptyWork, type WorkState, type WorkCommand, type WorkIssue, type Evidence } from '../src/domain/workflow';
import type { Scan, StampedFrame } from '../src/domain/rig/protocol';
import type { Incident } from '../src/domain/types';
import type { DirectorInput, DirectorResult } from './director/types';
import { employees, facility, seedReadings } from '../src/domain/fixture';
import { getScenario } from '../src/domain/scenarios';
import { fixOptionsFor, predictFix } from '../src/domain/engine/fixes';

interface Deps {
  initial?: WorkState; save(s: WorkState): void; latest(): StampedFrame | null; scans(): Scan[];
  plan(input: DirectorInput): Promise<DirectorResult>;
}
export function createWorkflowHub(d: Deps) {
  let state = d.initial?.version === 1 ? d.initial : emptyWork();
  let analyzing = false;
  const apply = (cmd: WorkCommand, actor: string) => {
    state = changeWork(state, cmd, actor.slice(0,80), new Date().toISOString(), globalThis.crypto.randomUUID());
    d.save(state); return state;
  };
  const find = (id: string): WorkIssue => { const i = state.issues.find(x => x.id === id); if (!i) throw new Error('Incident not found'); return i; };
  return {
    snapshot: () => ({ ...state, prototype: d.latest(), analyzing }),
    async command(body: Record<string, unknown>) {
      const actor = typeof body.actor === 'string' ? body.actor : 'Lookahead operator';
      const issueId = typeof body.issueId === 'string' ? body.issueId : '';
      switch (body.type) {
        case 'simulate_error':
          if (!['sensor','heat','water','vibration'].includes(String(body.kind))) throw new Error('Unknown error type');
          if (state.issues.length >= 60) throw new Error('Start a new demo session before adding more warnings');
          return apply({ type: 'simulate_error', kind: body.kind as 'sensor' | 'heat' | 'water' | 'vibration' }, actor);
        case 'reset': return apply({ type: 'reset' }, actor);
        case 'note': return apply({ type: 'note', issueId: issueId || undefined, text: typeof body.text === 'string' ? body.text : '' }, actor);
        case 'review': return apply({ type: 'review' }, actor);
        case 'acknowledge': return apply({ type: 'acknowledge', issueId }, actor);
        case 'verify_fixture': return apply({ type: 'verify_fixture', issueId }, actor);
        case 'assign': {
          const i = find(issueId), person = employees.find(e => e.id === body.employeeId);
          const needed = i.kind === 'water' ? 'leak_response' : i.kind === 'vibration' ? 'vibration' : 'cooling';
          if (!person || person.availability === 'off_shift' || !person.skills.includes(needed)) throw new Error('Choose an on-shift technician with the required skill');
          const zone = i.kind === 'heat' ? 'Z-YARD' : i.kind === 'water' ? 'Z-CORR' : 'Z-HALL';
          if (!person.zones.includes(zone)) throw new Error('Technician lacks access to this area');
          if (state.issues.some(x => x.id !== issueId && x.ownerId === person.id && x.status !== 'resolved')) throw new Error('Technician already owns another open response');
          return apply({ type: 'assign', issueId, employeeId: person.id }, actor);
        }
        case 'check':
          if (typeof body.done !== 'boolean' || typeof body.stepId !== 'string') throw new Error('Step and boolean result required');
          return apply({ type: 'check', issueId, stepId: body.stepId, done: body.done }, actor);
        case 'resolve':
          return apply({ type: 'resolve', issueId, note: typeof body.note === 'string' ? body.note : '' }, actor);
        case 'verify_scan': {
          const i = find(issueId), scan = d.scans().find(x => x.id === body.scanId);
          if (!scan || scan.assetId !== i.assetId || scan.status !== 'complete' || Date.now() - Date.parse(scan.endedAt) > 120_000 || Date.parse(scan.startedAt) < Date.parse(i.createdAt)) throw new Error('Take a complete recent scan at this equipment after the warning');
          const floor = i.kind === 'water', vibration = i.kind === 'vibration';
          if (floor && !/floor|leak/i.test(scan.point) || vibration && !/vibration|housing/i.test(scan.point) || !floor && !vibration && !/inlet|temperature|supply/i.test(scan.point)) throw new Error('Scan measurement point does not match the alert');
          const channel = floor ? scan.channels.floor_wet : vibration ? scan.channels.vibration_detected : scan.channels.ref_c ?? scan.channels.inlet_bottom_c;
          if (!channel || channel.n < 2 || !Number.isFinite(channel.mean)) throw new Error('Scan has insufficient independent readings');
          const bad = !floor && !vibration && scan.quality.some(q => /disagree|unsettled|timeout|noisy|obstructed|fewer_than_two/.test(q));
          const high = floor || vibration ? channel.mean > 0.5 : channel.mean >= 28;
          const evidence: Evidence = { value: +channel.mean.toFixed(2), unit: floor || vibration ? 'detection fraction' : '°C', source: scan.source, at: scan.endedAt, scanId: scan.id,
            verdict: bad ? 'inconclusive' : high ? 'confirmed' : 'disagrees',
            note: vibration ? 'Qualitative vibration detector only: fraction of frames detecting motion. Not a calibrated mm/s measurement or proof of bearing damage.' : bad ? `Quality flags: ${scan.quality.join(', ')}. Repeat the measurement.` : high ? 'Independent measurement supports the warning. This does not establish root cause.' : 'Independent reading does not support the warning at this point. Inspect placement, timing and calibration; disagreement alone does not prove sensor failure.' };
          return apply({ type: 'evidence', issueId, evidence }, actor);
        }
        case 'evaluate': {
          const i = find(issueId);
          if (analyzing) throw new Error('A response evaluation is already running');
          if (i.status === 'resolved') throw new Error('Evaluate an open incident');
          const generation = state.events.find(e => e.kind === 'session')?.id;
          analyzing = true;
          try {
            const inc: Incident = { id: i.id, title: i.title, rootAssetId: i.assetId, alertAssetIds: [i.assetId], severity: i.kind === 'water' || i.kind === 'heat' ? 'critical' : 'warning', status: 'open', evidence: i.evidence?.verdict === 'confirmed' ? 'corroborated_abnormal' : i.evidence?.verdict === 'disagrees' ? 'measurement_disagreement' : 'unverified', openedAt: 0, shiftLeadId: 'emp-priya', summary: `${i.title}. Installed reading is a demo fixture: ${i.installed} ${i.unit}. Independent evidence: ${i.evidence ? JSON.stringify(i.evidence) : 'not collected'}.`, recentChanges: [] };
            const result = await d.plan({ scenarioId: i.kind === 'heat' ? 'scn-chiller-trip' : 'scn-riser-leak', t: i.kind === 'water' ? 12 : i.kind === 'heat' ? 2 : 0,
              incidents: [inc], scans: d.scans().filter(x => x.assetId === i.assetId).slice(-4), confirmedEdgeIds: [],
              question: `Evaluate ${i.id}: ${inc.summary} Prioritize the open incidents: ${state.issues.filter(x => x.status !== 'resolved').map(x => `${x.id}: ${x.title}, evidence ${x.evidence?.verdict ?? 'missing'}`).join('; ')}. Clearly separate model assumptions and observations. Never execute equipment actions. No causal proof from temporal proximity. Recent recorded actions (cite ids, do not invent causation): ${state.events.slice(-8).map(e => `[${e.id}] ${e.summary}`).join('; ')}.` });
            if (generation !== state.events.find(e => e.kind === 'session')?.id || !state.issues.some(x => x.id === issueId && x.status !== 'resolved')) throw new Error('Session changed during evaluation; run it again');
            const ctx = { facility, scenario: getScenario(i.kind === 'heat' ? 'scn-chiller-trip' : 'scn-riser-leak'), seedReadings: seedReadings(), fixes: [], t: i.kind === 'water' ? 12 : 2 };
            const option = i.kind === 'water' || i.kind === 'heat' ? fixOptionsFor(ctx, i.assetId)[0] : undefined;
            const prediction = option ? predictFix(ctx, option) : undefined;
            const comparison = option && prediction ? { action: option.label, without: prediction.racksWithout, with: prediction.racksWith, saved: prediction.racksWithout - prediction.racksWith, assumptions: 'Conditional fixture scenario, p50 within its model horizon. Documented dependencies and assumed work delays; not a forecast calibrated to this portable reading. No equipment action executed.' } : undefined;
            return apply({ type: 'analysis', analysis: { issueId, comparison, provider: result.provider, summary: result.recommendation.summary, nextAction: result.recommendation.nextAction, at: new Date().toISOString(), runs: Object.keys(result.runs).length, warnings: [...result.warnings, ...(result.fallbackReason ? [result.fallbackReason] : [])] } }, actor);
          } finally { analyzing = false; }
        }
        default: throw new Error('Unknown workflow action');
      }
    },
  };
}
