import { CATALOG, changeWork, emptyWork, type WorkState, type WorkCommand, type WorkIssue, type Evidence } from '../src/domain/workflow';
import type { Scan, StampedFrame } from '../src/domain/rig/protocol';
import type { Incident } from '../src/domain/types';
import type { DirectorInput, DirectorResult } from './director/types';
import { employees, facility, seedReadings } from '../src/domain/fixture';
import { incidentModel } from '../src/domain/scenarios';
import { hashSeed } from '../src/domain/engine/ensemble';
import { coverageNote } from '../src/domain/engine/coverage';
import { createEvaluationState, dominantRegion, evaluationOutput } from './director/evaluation';
import { evidencePosterior, type EvidencePosterior } from '../src/domain/engine/evidence';

/** Installed readings of the neighbouring racks (same row, ±2 slots): the no-condition baseline. */
function neighbourInlets(assetId: string): number[] {
  const a = facility.assets.find(x => x.id === assetId);
  if (!a || a.type !== 'rack') return [];
  const slot = Number(a.location.slot);
  const ids = new Set(facility.assets.filter(x => x.type === 'rack' && x.location.row === a.location.row && x.id !== assetId && Math.abs(Number(x.location.slot) - slot) <= 2).map(x => x.id));
  return seedReadings().filter(r => ids.has(r.assetId) && r.metric === 'inlet_temp_c' && r.source === 'installed' && r.t < 0).map(r => r.value);
}
/** Evidence posterior for a workflow issue (PREDICTION-SCIENCE.md §2.6). */
export function issueEvidence(i: WorkIssue, reference: { mean: number; n: number; sd?: number; slopePerMin?: number; quality?: string[] } | null): EvidencePosterior {
  const metric = i.kind === 'water' ? 'leak' : i.kind === 'vibration' ? 'vibration_mm_s' : i.kind === 'heat' ? 'supply_temp_c' : 'inlet_temp_c';
  const nb = neighbourInlets(i.assetId);
  return evidencePosterior({ metric, installed: { value: i.installed }, reference, neighbours: nb, modelBaseline: { mean: nb.length ? nb.reduce((x, y) => x + y, 0) / nb.length : 22.5 } });
}

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
    /**
     * Hidden truth for the SIMULATED device (audit C4): the sim responds to the scanned asset's injected
     * incident, so the demo shows both outcomes. Water: real (the floor probe gets wet). Temperature alert
     * at A-11: installed-sensor fault (the probe reads normal air). Chiller supply water and fan mm/s are
     * not measurable by the rig, so nothing is simulated for them.
     */
    simulatedTruth(assetId: string): { truth: 'real' | 'sensor_fault'; before: string[]; after: string[] } | null {
      const i = state.issues.find(x => x.assetId === assetId && x.status !== 'resolved');
      if (!i) return null;
      return i.kind === 'water' ? { truth: 'real', before: ['sim spill'], after: ['sim dry'] } : { truth: i.kind === 'sensor' ? 'sensor_fault' : 'real', before: [], after: [] };
    },
    async command(body: Record<string, unknown>) {
      const actor = typeof body.actor === 'string' ? body.actor : 'CenterGuard operator';
      const issueId = typeof body.issueId === 'string' ? body.issueId : '';
      switch (body.type) {
        case 'simulate_error':
          if (!['sensor','heat','water','vibration'].includes(String(body.kind))) throw new Error('Unknown error type');
          if (state.issues.length >= 60) throw new Error('Start a new demo session before adding more warnings');
          return apply({ type: 'simulate_error', kind: body.kind as 'sensor' | 'heat' | 'water' | 'vibration' }, actor);
        case 'create_response':
          if (!['sensor','heat','water','vibration'].includes(String(body.kind))) throw new Error('Choose a response type');
          if (typeof body.assetId !== 'string' || !facility.assets.some(a => a.id === body.assetId)) throw new Error('Choose equipment from the facility list');
          if (typeof body.title !== 'string') throw new Error('Give the response a title (at least 3 characters)');
          if (state.issues.length >= 60) throw new Error('Start a new demo session before adding more responses');
          return apply({ type: 'create_response', kind: body.kind as 'sensor' | 'heat' | 'water' | 'vibration', assetId: body.assetId, title: body.title.slice(0, 200) }, actor);
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
          // Bayesian verdict: installed vs portable against the sensor error budget (audit C3).
          const post = issueEvidence(i, { mean: channel.mean, n: channel.n, sd: channel.sd, slopePerMin: channel.slopePerMin, quality: scan.quality });
          const pTxt = `P(real) ≈ ${post.pReal >= 0.995 ? '> 0.99' : post.pReal <= 0.005 ? '< 0.01' : post.pReal.toFixed(2)}`;
          const verdict: Evidence['verdict'] = vibration ? (channel.mean > 0.5 ? 'confirmed' : 'inconclusive')
            : bad || !post.measurable ? 'inconclusive' : post.verdict === 'corroborated_abnormal' ? 'confirmed' : post.verdict === 'measurement_disagreement' ? 'disagrees' : 'inconclusive';
          const evidence: Evidence = { value: +channel.mean.toFixed(2), unit: floor || vibration ? 'detection fraction' : '°C', source: scan.source, at: scan.endedAt, scanId: scan.id, verdict,
            note: vibration ? (channel.mean > 0.5 ? 'Motion present only. Qualitative vibration detector: fraction of frames detecting motion. Not a calibrated mm/s measurement, not a severity zone, and no proof of bearing damage.' : 'No motion detected: check the probe is coupled to the fan housing. The detector cannot measure mm/s.')
              : !post.measurable ? `Not measurable by the portable rig: its air probe cannot read ${i.kind === 'heat' ? 'chiller supply water' : 'this quantity'}. Use the plant's own instrument; ${pTxt} stays at the prior.`
              : bad ? `Quality flags: ${scan.quality.join(', ')}. Repeat the measurement (${pTxt} under the stated error assumptions).`
              : `${post.rationale} Installed ${i.installed} ${i.unit} vs portable ${channel.mean.toFixed(1)} ${floor ? 'detection fraction' : '°C'}.` };
          return apply({ type: 'evidence', issueId, evidence }, actor);
        }
        case 'evaluate': {
          const i = find(issueId);
          if (analyzing) throw new Error('A response evaluation is already running');
          if (i.status === 'resolved') throw new Error('Evaluate an open incident');
          // Incident models exist for the demo warning equipment only; never evaluate another asset in their scenario.
          if (i.assetId !== CATALOG[i.kind].assetId) throw new Error(`Response simulation covers the demo warning equipment only; ${i.assetId} has no incident model yet.`);
          const generation = state.events.find(e => e.kind === 'session')?.id;
          analyzing = true;
          try {
            // Evidence posterior from the attached reading moves the prediction (audit C2): P(real) becomes the
            // weight of "the alarm is real" in the incident's own ensemble.
            const post = issueEvidence(i, i.evidence ? { mean: i.evidence.value, n: 10 } : null);
            const pRealBasis = !i.evidence ? 'prior 0.5: no independent reading attached (assumption)' : post.measurable ? `evidence posterior from installed ${i.installed} ${i.unit} vs portable ${i.evidence.value} ${i.evidence.unit} (${i.evidence.source})` : 'prior 0.5: the portable rig cannot measure this quantity (assumption)';
            const model = incidentModel(i.kind, post.pReal, i.installed);
            const inc: Incident = { id: i.id, title: i.title, rootAssetId: i.assetId, alertAssetIds: [i.assetId], severity: i.kind === 'water' || i.kind === 'heat' ? 'critical' : 'warning', status: 'open', evidence: post.verdict === 'corroborated_abnormal' ? 'corroborated_abnormal' : post.verdict === 'measurement_disagreement' ? 'measurement_disagreement' : i.evidence ? 'inconclusive' : 'unverified', openedAt: 0, shiftLeadId: 'emp-priya', summary: `${i.title}. Installed reading is a demo fixture: ${i.installed} ${i.unit}.`, recentChanges: [] };
            // Log context goes in as a structured field (capped), not appended to the 500-char question (audit C6).
            const mine = state.events.filter(e => !e.issueId || e.issueId === i.id);
            const context = { events: mine.slice(-20).map(e => ({ id: e.id, at: e.at, summary: `${e.actor}: ${e.summary}`.slice(0, 200) })), notes: mine.filter(e => e.kind === 'context').slice(-10).map(e => e.summary.slice(0, 200)) };
            const evaluation = { kind: i.kind, pReal: post.pReal, pRealBasis, installed: i.installed, seed: hashSeed(i.id, i.evidence?.scanId ?? 'no-evidence') };
            const result = await d.plan({ scenarioId: model.scenario.id, t: model.t, incidents: [inc], scans: d.scans().filter(x => x.assetId === i.assetId).slice(-4), confirmedEdgeIds: [],
              question: `Evaluate ${i.id} (${i.assetId}: ${i.title}). Separate model assumptions from observations. Never execute equipment actions. No causal proof from temporal proximity; cite event ids from get_context.`,
              context, evaluation });
            if (generation !== state.events.find(e => e.kind === 'session')?.id || !state.issues.some(x => x.id === issueId && x.status !== 'resolved')) throw new Error('Session changed during evaluation; run it again');
            // The director normally returns the ensemble; compute it here if it did not (same pure functions).
            const ev = result.evaluation ?? evaluationOutput({ evaluation: createEvaluationState(evaluation), stressRuns: new Map(), numbers: new Map() })!;
            const none = ev.options[0], withOpt = ev.options.find(o => o.id === ev.withOptionId);
            const side = (o: typeof none) => ({ racksP10: o.racks.p10, racksP50: o.racks.p50, racksP90: o.racks.p90, racksMean: o.racks.mean, pServiceDown: o.pServiceDown, ci90: o.ci90, firstImpactMin: o.firstImpactMin, firstEnvelopeMin: o.firstEnvelopeMin, futures: o.futures });
            const dom = ev.stress ? dominantRegion(ev.stress.regions) : null;
            const comparison = withOpt ? {
              action: withOpt.label, without: none.racks.p50, with: withOpt.racks.p50, saved: none.racks.p50 - withOpt.racks.p50,
              assumptions: `Incident scenario ${ev.scenarioId} built from this warning alone (no scripted future faults); racks impacted p50 over ${ev.trials} physics-and-priors trials, weighted by P(real) = ${ev.pReal.toFixed(2)}. No equipment action executed.`,
              ensemble: {
                trials: ev.trials, ess: ev.ess, provider: result.provider, pReal: ev.pReal, pRealBasis: ev.pRealBasis, scenarioId: ev.scenarioId, horizonMin: model.scenario.horizonMin - model.t,
                without: side(none), with: side(withOpt),
                dominantFailure: dom ? { label: dom.label, priorOneIn: dom.priorOneIn, shareOfFailure: dom.shareOfFailure, pFailGivenRegion: dom.pFailGivenRegion } : undefined,
                stress: ev.stress ? { by: ev.stress.by, trials: ev.stress.trials, ess: ev.stress.ess, pFail: ev.stress.pFail, ci90: ev.stress.ci90, rounds: ev.stress.rounds, regions: ev.stress.regions.map(r => ({ label: r.label, priorOneIn: r.priorOneIn, shareOfFailure: r.shareOfFailure, pFailGivenRegion: r.pFailGivenRegion })), rejected: ev.stress.rejected.length } : undefined,
                nextScan: ev.nextScan ? { assetId: ev.nextScan.assetId, point: ev.nextScan.point, evsi: ev.nextScan.evsi, why: ev.nextScan.evsi > 0 ? `one outcome changes the best response (it discriminates ${ev.nextScan.informs})` : `no outcome changes the best response; it moves the forecast most (${ev.nextScan.informs})` } : undefined,
                hypotheses: ev.hypotheses.map(h => ({ label: h.label, p: h.p, basisKind: h.basisKind })),
                coverageNote: coverageNote(),
                basis: 'Physics model: room-air / IT-mass energy balance (k_G fitted to Schneider WP179). Published data: INL/EXT-21-65055 failure rates, ASHRAE envelopes, iDRAC limits. Assumptions: crew speed, leak start, battery health, hot-spot rise, P(trip | caution).',
              },
            } : undefined;
            return apply({ type: 'analysis', analysis: { issueId, comparison, provider: result.provider, summary: result.recommendation.summary, nextAction: result.recommendation.nextAction, at: new Date().toISOString(), runs: Object.keys(result.runs).length, warnings: [...result.warnings, ...(result.fallbackReason ? [result.fallbackReason] : [])] } }, actor);
          } finally { analyzing = false; }
        }
        default: throw new Error('Unknown workflow action');
      }
    },
  };
}
