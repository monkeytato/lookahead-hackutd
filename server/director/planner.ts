/**
 * Deterministic local planner — the no-key / failure fallback for the Nemotron director.
 *
 * It drives the SAME tool implementations through the SAME dispatcher the model uses:
 *   get_situation → scan_value for each open incident whose evidence is unverified / inconclusive /
 *   disagreement → compare_runs on the best scan's two hypotheses → recommend.
 * Text is assembled only from tool results, so it passes the same post-validator.
 */
import { facility } from '../../src/domain/fixture';
import type { ID, Metric } from '../../src/domain/types';
import { RIG_METRICS, UNCERTAIN_EVIDENCE, createSession, defaultMetricFor, dispatchTool, metricLabel } from './tools';
import type { Session } from './tools';
import type { CompactRun, DirectorInput, DirectorResult, DirectorStep, Hypothesis, ScanValueResult } from './types';
import { validateRecommendation } from './validate';
import { dispatchExternal, type ExternalServices } from './external';
import { bestResponseIndex, crossEntropyRound, dominantRegion, evaluationOutput, prepareRound0Async } from './evaluation';

/** Let a browser page paint between heavy engine steps (the static artifact runs the planner in-page). */
const yieldUi = () => new Promise<void>((r) => setTimeout(r, 0));
const fp = (p: number) => (p < 0.0005 ? '< 0.1 %' : `${Math.round(p * 1000) / 10} %`);

/** Sentences about the ensemble and the stress test, built only from cited engine numbers. */
function evaluationText(session: Session): { summary: string; hypothesis: Hypothesis | null } {
  const ev = session.evaluation!;
  const ens = ev.round0!;
  const id = ev.digestId!;
  const none = ens.summaries[0];
  const k = bestResponseIndex(ens);
  const w = k > 0 ? ens.summaries[k] : null;
  let summary = `Engine ensemble (${id}, ${ens.trials} trials per option, P(real) ${ev.request.pReal.toFixed(2)}): with no response, P(critical service down) ${fp(none.pServiceDown)} (CI90 ${fp(none.ci90[0])}–${fp(none.ci90[1])}), p50 ${none.racks.p50} racks impacted (p10–p90 ${none.racks.p10}–${none.racks.p90}).`;
  if (w) summary += ` ${w.label}: ${fp(w.pServiceDown)}, p50 ${w.racks.p50} racks impacted.`;
  const st = ev.stress.at(-1);
  let hypothesis: Hypothesis | null = null;
  if (st) {
    const top = dominantRegion(st.result.regions);
    summary += ` Cross-entropy stress test (${st.id}, ${st.result.trials} trials, ESS ${st.result.ess}): P(failure) ${fp(st.result.pFail)}.`;
    if (top && top.shareOfFailure > 0) {
      summary += ` Biggest remaining risk: ${top.label} (about 1 in ${top.priorOneIn} incidents; ${fp(top.shareOfFailure)} of the remaining failure probability).`;
      hypothesis = { label: `Dominant failure mode: ${top.label}`, support: `P(failure | region) ${fp(top.pFailGivenRegion)}; ${fp(top.shareOfFailure)} of the failure probability (${st.id})`, runIds: [st.id] };
    }
  }
  return { summary, hypothesis };
}

const PLANNER = 'Local planner';

async function callExt(session: Session, steps: DirectorStep[], ext: ExternalServices, tool: string, args: Record<string, unknown>) {
  const out = (await dispatchExternal(session, ext, tool, args, PLANNER))!;
  steps.push({ tool, args, summary: out.summary, ok: out.ok, service: out.service });
  return out;
}

const assetType = new Map(facility.assets.map((a) => [a.id, a.type]));

function call(session: Session, steps: DirectorStep[], tool: string, args: Record<string, unknown>) {
  const out = dispatchTool(session, tool, args);
  steps.push({ tool, args, summary: out.summary, runId: out.runId, runIds: out.runIds, ok: out.ok });
  return out;
}

/** Which (asset, metric) readings would resolve each uncertain incident. */
export function planCandidates(session: Session): { assetId: ID; metric: Metric; incidentId: ID }[] {
  const { water, now } = session;
  const out: { assetId: ID; metric: Metric; incidentId: ID }[] = [];
  const seen = new Set<string>();
  const push = (assetId: ID, metric: Metric, incidentId: ID) => {
    const k = `${assetId}|${metric}`;
    if (!seen.has(k)) { seen.add(k); out.push({ assetId, metric, incidentId }); }
  };
  for (const inc of session.incidents) {
    if (!UNCERTAIN_EVIDENCE.includes(inc.evidence)) continue;
    const members = [inc.rootAssetId, ...inc.alertAssetIds];
    const watery = members.some((a) => a === water.sourceId || a in water.arrival || assetType.get(a) === 'pipe');
    if (watery) {
      if (assetType.get(inc.rootAssetId) === 'pipe') push(inc.rootAssetId, 'leak', inc.id);
      // the modeled wet front: the latest-wetted member the model says is wet by now
      const front = members.filter((a) => a in water.arrival && water.arrival[a] <= now).sort((a, b) => water.arrival[b] - water.arrival[a] || a.localeCompare(b))[0];
      if (front) push(front, 'leak', inc.id);
      else if (assetType.get(inc.rootAssetId) !== 'pipe') push(inc.rootAssetId, 'leak', inc.id);
    } else {
      push(inc.rootAssetId, defaultMetricFor(session, inc.rootAssetId), inc.id);
    }
  }
  return out;
}

const fmt = (x: { assetId: ID; inMin: number; atMin: number } | null) =>
  !x ? 'none within the horizon' : x.inMin <= 0 ? `${x.assetId} due now (T+${x.atMin})` : `${x.assetId} in ${x.inMin} min (T+${x.atMin})`;

function describe(r: CompactRun): string {
  return `first rack loss ${fmt(r.firstRackLoss)}; earliest upcoming loss ${fmt(r.earliest)}; ${r.lostAfterNow} asset${r.lostAfterNow === 1 ? '' : 's'} lost after now; top incident ${r.ranking[0]?.incidentId ?? 'none'}`;
}

/** Arrival minute of the modeled water at this asset (source = leak start), else null. */
function arrivalOf(session: Session, assetId: ID): number | null {
  if (assetId === session.water.sourceId) return session.water.startT;
  return session.water.arrival[assetId] ?? null;
}

export async function runLocalPlanner(input: DirectorInput, fallbackReason?: string, started = Date.now(), ext?: ExternalServices): Promise<DirectorResult> {
  const session = createSession(input);
  const steps: DirectorStep[] = [];

  call(session, steps, 'get_situation', {});
  let evalSummary: ReturnType<typeof evaluationText> | null = null;
  if (session.evaluation) {
    if (session.context.events.length || session.context.notes.length) call(session, steps, 'get_context', {});
    await prepareRound0Async(session);
    call(session, steps, 'stress_digest', {});
    await yieldUi();
    const ce = crossEntropyRound(session);
    if (ce) steps.push({ tool: 'stress_test', args: { proposer: 'cross_entropy', option: ce.result.option, regions: ce.result.regions.map((r) => r.label) }, summary: `${ce.id}: ${ce.result.option} P(failure) ${(ce.result.pFail * 100).toFixed(2)} % over ${ce.result.trials} trials (cross-entropy proposals)`, runId: ce.id, ok: true });
    await yieldUi();
    evalSummary = evaluationText(session);
  }
  // outside world first: is the rig trustworthy, and is the weather stressing the cooling plant?
  let rigTrust: string | null = null;
  let rig: { valve?: string; floor_raw?: number; source?: string } | null = null;
  let weatherNote: string | null = null;
  if (ext) {
    const r = await callExt(session, steps, ext, 'get_rig_status', {});
    if (r.ok) { const c = r.content as { trust: string; valve: string; floor_raw: number; source: string }; rigTrust = c.trust; rig = c; }
    const w = await callExt(session, steps, ext, 'get_weather', { hours: 6 });
    if (w.ok) weatherNote = (w.content as { note: string }).note;
  }
  const base = session.runs.get(session.baselineId!)!;
  const rankOf = (id: ID) => base.ranking.find((r) => r.incidentId === id)?.rank ?? 99;

  // rig-measurable first, then by baseline incident rank — so the run budget goes where a scan can help
  const cands = planCandidates(session).sort((a, b) =>
    Number(RIG_METRICS.includes(b.metric)) - Number(RIG_METRICS.includes(a.metric)) || rankOf(a.incidentId) - rankOf(b.incidentId) || a.assetId.localeCompare(b.assetId));
  const values: ScanValueResult[] = [];
  for (const c of cands) {
    if (session.runs.size + 2 > session.maxRuns) break;
    const out = call(session, steps, 'scan_value', { assetId: c.assetId, metric: c.metric });
    if (out.ok) values.push(out.content as ScanValueResult);
  }

  // Best scan: highest decision value among rig-measurable, not-yet-scanned readings. Ties go to the
  // reading nearest the modeled wet front (where the water layer is least certain), then incident rank.
  const ranked = values.filter((v) => v.rigMeasurable && !v.alreadyScanned).sort((a, b) =>
    b.decisionValue - a.decisionValue
    || (arrivalOf(session, b.assetId) ?? -1) - (arrivalOf(session, a.assetId) ?? -1)
    || rankOf(a.incidentId) - rankOf(b.incidentId)
    || a.assetId.localeCompare(b.assetId));
  const best = ranked[0] && ranked[0].decisionValue > 0 ? ranked[0] : null;
  const top = base.ranking[0];
  const topInc = top ? session.incidents.find((i) => i.id === top.incidentId) : undefined;
  const offRig = values.filter((v) => !v.rigMeasurable).sort((a, b) => b.decisionValue - a.decisionValue)[0];

  const hypotheses: Hypothesis[] = [];
  let nextScan: { assetId: ID; point: string; reason: string } | null = null;
  let nextAction: string;
  let summary = `At T+${session.now}, baseline ${base.id}: ${describe(base)}.`;

  if (best) {
    call(session, steps, 'compare_runs', { a: best.runIfAbnormal, b: best.runIfNormal });
    const ra = session.runs.get(best.runIfAbnormal)!;
    const rn = session.runs.get(best.runIfNormal)!;
    hypotheses.push({ label: best.hypothesisAbnormal, support: describe(ra), runIds: [ra.id] });
    hypotheses.push({ label: best.hypothesisNormal, support: describe(rn), runIds: [rn.id] });
    const moves = best.topChanged ? ` and the top-ranked incident changes (${best.topIfAbnormal} vs ${best.topIfNormal})` : '';
    nextScan = {
      assetId: best.assetId,
      point: best.point,
      reason: `Highest decision value (${best.decisionValue}) of ${values.length} candidate scans: if abnormal (${ra.id}) the first rack loss is ${fmt(ra.firstRackLoss)}; if normal (${rn.id}) it is ${fmt(rn.firstRackLoss)}${moves}.`,
    };
    summary += ` Scan ${best.assetId} (${metricLabel(best.metric)}, ${best.incidentId}) has the highest decision value (${best.decisionValue}): it decides between ${ra.id} and ${rn.id}.`;
    const tie = ranked.filter((v) => v !== best && v.decisionValue === best.decisionValue);
    if (tie.length) summary += ` ${tie.map((v) => v.assetId).join(', ')} tie${tie.length === 1 ? 's' : ''} on decision value; ${best.assetId} is preferred because ${arrivalOf(session, best.assetId) !== null ? `it sits at the modeled wet front (arrival T+${arrivalOf(session, best.assetId)}), where the water layer is least certain` : 'its incident ranks higher'}.`;
    nextAction = best.metric === 'leak'
      ? `Before any irreversible step (valve isolation, battery or UPS module work), take the ${best.assetId} scan; stage an absorbent barrier there meanwhile. If wet, plan against ${ra.id} (first rack loss ${fmt(ra.firstRackLoss)}); if dry, ${rn.id} applies.`
      : `Keep the ${best.assetId} alarm visible and do not move load or suppress it until the reference reading is in; if the installed sensor disagrees, open a sensor-chain inspection (${rn.id}).`;
  } else {
    nextAction = top
      ? `No rig scan changes the ranking or any clock right now; work the top-ranked incident ${top.incidentId}${topInc ? ` (${topInc.title})` : ''} per its runbook (${base.id}).`
      : `No open incident needs a decision right now (${base.id}).`;
    summary += ' No rig-measurable reading would change what the team does first.';
    hypotheses.push({ label: 'Situation as modeled', support: describe(base), runIds: [base.id] });
  }

  for (const v of ranked.slice(best ? 1 : 0, best ? 3 : 2)) {
    const va = session.runs.get(v.runIfAbnormal)!;
    const vn = session.runs.get(v.runIfNormal)!;
    hypotheses.push({ label: `Alternative: ${v.assetId} ${metricLabel(v.metric)} scan (${v.incidentId})`, support: `decision value ${v.decisionValue}; first rack loss ${fmt(va.firstRackLoss)} if abnormal vs ${fmt(vn.firstRackLoss)} if normal; top incident ${v.topChanged ? 'changes' : 'unchanged'}`, runIds: [va.id, vn.id] });
    summary += ` ${v.assetId}: decision value ${v.decisionValue} (${v.runIfAbnormal}/${v.runIfNormal}).`;
  }
  if (offRig) {
    const rn = session.runs.get(offRig.runIfNormal)!;
    const ra = session.runs.get(offRig.runIfAbnormal)!;
    hypotheses.push({ label: offRig.hypothesisNormal, support: `vs ${offRig.hypothesisAbnormal}: first rack loss ${fmt(rn.firstRackLoss)} vs ${fmt(ra.firstRackLoss)}; decision value ${offRig.decisionValue}`, runIds: [ra.id, rn.id] });
    nextAction += ` ${offRig.assetId}: the rig cannot measure ${metricLabel(offRig.metric)} — send the ${offRig.incidentId} runbook check (decision value ${offRig.decisionValue}, ${ra.id}/${rn.id}).`;
  }
  if (top && best) nextAction += ` Top-ranked incident in ${base.id}: ${top.incidentId}${topInc ? ` (${topInc.title})` : ''}.`;

  if (rigTrust && rigTrust !== 'rig self-checks clear') nextAction += ` Rig self-check: ${rigTrust}.`;
  if (weatherNote) summary += ` Weather (NWS): ${weatherNote}`;

  if (ext) {
    // act within authority: queue the scan (a person performs it); propose, never execute, the rest
    if (nextScan) await callExt(session, steps, ext, 'request_scan', { ...nextScan, incidentId: best?.incidentId });
    const latestWet = session.input.scans.filter((sc) => sc.status === 'complete' && (sc.channels.floor_wet?.mean ?? 0) >= 0.5).at(-1);
    if (latestWet && rig?.valve === 'open') {
      await callExt(session, steps, ext, 'propose_rig_action', { cmd: 'valve close', reason: `Floor scan ${latestWet.id} at ${latestWet.assetId} is wet while the rig's isolation valve is open — isolate the loop.`, incidentId: session.incidents.find((i) => i.rootAssetId === latestWet.assetId || i.alertAssetIds.includes(latestWet.assetId))?.id });
    }
    for (const inc of session.incidents.filter((i) => i.severity === 'critical' && i.evidence === 'corroborated_abnormal')) {
      const r = base.ranking.find((x) => x.incidentId === inc.id);
      await callExt(session, steps, ext, 'open_ticket', {
        incidentId: inc.id, severity: 'critical', title: `[${inc.id}] ${inc.title}`,
        body: [`Corroborated by a Rack Monitor scan. Rank ${r?.rank ?? '—'} in ${base.id}.`, '', `Baseline (${base.id}): ${describe(base)}.`, '', `Next action: ${nextAction}`, '', '_Drafted by the CenterGuard simulation director (local planner); approved by a person before filing._'].join('\n'),
      });
    }
  }

  if (evalSummary) {
    summary = `${evalSummary.summary} ${summary}`;
    if (evalSummary.hypothesis) hypotheses.unshift(evalSummary.hypothesis);
    const ev = session.evaluation!;
    const top = (ev.evsi ?? []).find((r) => r.evsi > 0 || r.forecastShift > 0);
    nextScan = top ? { assetId: top.assetId, point: top.point, reason: `Highest expected value of the reading (${ev.digestId}): it discriminates ${top.informs}${top.evsi > 0 ? '; one outcome changes the best response' : '; no outcome changes the best response, but it moves the forecast most'}.` } : null;
    const ens = ev.round0!;
    const k = bestResponseIndex(ens);
    const none = ens.summaries[0], w = k > 0 ? ens.summaries[k] : null;
    nextAction = w && w.expectedUtility > none.expectedUtility
      ? `By expected outcome the engine favours "${w.label}" (${ev.digestId}): P(critical service down) ${fp(w.pServiceDown)} against ${fp(none.pServiceDown)} with no response. A person decides and performs any equipment action; nothing is executed from here.`
      : `No response option improves the expected outcome over monitoring (${ev.digestId}); keep the alarm visible and verify before changing equipment.`;
    nextAction += top ? ` Measure next: ${top.point}.` : ' No portable scan would change the best response (every rig-measurable point has zero expected value).';
  }
  const rec = call(session, steps, 'recommend', { nextScan, nextAction, hypotheses, summary });
  if (!rec.ok || !session.recommendation) throw new Error(`local planner produced an invalid recommendation: ${rec.summary}`);
  const { recommendation, warnings } = validateRecommendation(session.recommendation, session);
  const evaluation = evaluationOutput(session);
  return {
    evaluation,
    provider: 'local_planner',
    model: null,
    steps,
    recommendation,
    runs: Object.fromEntries(session.runs),
    warnings: [...session.notes, ...warnings],
    fallbackReason,
    elapsedMs: Date.now() - started,
  };
}
