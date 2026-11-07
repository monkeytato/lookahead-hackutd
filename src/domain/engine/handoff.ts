/**
 * Shift handoff note built by local rules from the shared records (no LLM). Every line is derived
 * from an incident, task, verification, clock or event — nothing is invented here.
 */
import type { Employee, Facility, ID, ImpactClock, Incident, OpEvent, Task, VerificationSession } from '../types';

export interface HandoffInput {
  now: number;
  incidents: Incident[];
  tasks: Task[];
  employees: Employee[];
  events: OpEvent[];
  verifications: VerificationSession[];
  clocks: Record<ID, ImpactClock>;
  staleAssetIds: ID[];
  facility: Facility;
}

export interface HandoffNote {
  generatedAt: number;
  source: 'local_rules';
  /** What is happening now */
  happening: string[];
  /** What has been verified (and how) */
  verified: string[];
  /** What is still uncertain */
  uncertain: string[];
  /** What has been done */
  done: string[];
  owners: { item: string; owner: string }[];
  /** Work the next shift should not repeat */
  doNotRepeat: string[];
  /** Upcoming clock events to watch, soonest first */
  watch: { assetId: ID; atMin: number; why: string }[];
}

const VERDICT_TEXT: Record<VerificationSession['verdict'], string> = {
  corroborated_abnormal: 'corroborated abnormal',
  measurement_disagreement: 'measurement disagreement',
  inconclusive: 'inconclusive',
  not_corroborated_in_session: 'not corroborated in session',
};

const fmtMin = (m: number) => `${Math.round(m)} min`;

export function buildHandoff(input: HandoffInput): HandoffNote {
  const { now, incidents, tasks, employees, events, verifications, clocks, staleAssetIds, facility } = input;
  const name = (id?: ID) => (id ? employees.find((e) => e.id === id)?.name ?? id : 'unassigned');
  const assetName = (id: ID) => facility.assets.find((a) => a.id === id)?.name ?? id;
  const open = incidents.filter((i) => i.status !== 'resolved');

  const happening: string[] = open.map((i) => `${i.id} ${i.title} — ${i.severity}, ${i.status}, evidence: ${i.evidence.replace(/_/g, ' ')}.`);
  const lostAlready = Object.values(clocks).filter((c) => c.p50 !== null && c.p50 <= now);
  if (lostAlready.length) happening.push(`Modeled as lost by now (p50): ${lostAlready.map((c) => c.assetId).join(', ')}.`);

  const verified: string[] = [];
  const doNotRepeat: string[] = [];
  for (const v of [...verifications].sort((a, b) => a.t - b.t)) {
    verified.push(`${v.assetId} ${v.metric.replace(/_/g, ' ')} — ${VERDICT_TEXT[v.verdict]} (probe ${v.probeId}, ${v.point}, t=${v.t}). ${v.rationale}`);
    if (v.verdict !== 'inconclusive') {
      doNotRepeat.push(`${v.assetId} already checked with ${v.probeId} at t=${v.t} (${VERDICT_TEXT[v.verdict]}) — repeat only if new evidence appears.`);
    }
  }

  const uncertain: string[] = [];
  for (const i of open) {
    if (i.evidence === 'unverified' || i.evidence === 'inconclusive' || i.evidence === 'measurement_disagreement') {
      uncertain.push(`${i.id} (${i.rootAssetId}): ${i.evidence.replace(/_/g, ' ')} — not yet settled by an independent measurement.`);
    }
  }
  for (const id of staleAssetIds) uncertain.push(`${id}: telemetry stale — last value may not reflect current state.`);
  const weak = new Set<string>();
  for (const c of Object.values(clocks)) {
    if (c.p50 !== null && c.p50 > now && c.weakestAssumption && !weak.has(c.weakestAssumption)) {
      weak.add(c.weakestAssumption);
      if (weak.size <= 3) uncertain.push(`Clock assumption: ${c.weakestAssumption}`);
    }
  }

  const done: string[] = [];
  for (const t of tasks) {
    if (t.status === 'completed') {
      done.push(`${t.id} ${t.title} — completed by ${name(t.ownerId)}.`);
      doNotRepeat.push(`${t.id} ${t.title} is complete — do not re-dispatch.`);
    } else if (t.status === 'submitted_for_review') {
      done.push(`${t.id} ${t.title} — submitted for review by ${name(t.ownerId)}.`);
    }
  }
  for (const e of events) {
    if (e.t <= now && (e.kind === 'analysis' || e.kind === 'dependency' || e.kind === 'note') && e.source === 'operator') {
      done.push(`t=${e.t}: ${e.summary} (${e.actor}).`);
    }
  }

  const owners: HandoffNote['owners'] = [
    ...open.map((i) => ({ item: `${i.id} ${i.title}`, owner: name(i.ownerId ?? i.shiftLeadId) })),
    ...tasks
      .filter((t) => !['completed', 'cancelled'].includes(t.status))
      .map((t) => ({ item: `${t.id} ${t.title} (${t.status.replace(/_/g, ' ')})`, owner: name(t.ownerId) })),
  ];

  const watch = Object.values(clocks)
    .filter((c) => c.p50 !== null && c.p50 > now)
    .sort((a, b) => a.p50! - b.p50!)
    .slice(0, 6)
    .map((c) => ({
      assetId: c.assetId,
      atMin: c.p50!,
      why: `${assetName(c.assetId)} modeled lost in ${fmtMin(c.p50! - now)} (p10–p90 ${c.p10 ?? '—'}–${c.p90 ?? '>horizon'}, ${Math.round(c.probWithinHorizon * 100)} % of runs) via ${c.path.join(' → ')}.`,
    }));

  return { generatedAt: now, source: 'local_rules', happening, verified, uncertain, done, owners, doNotRepeat, watch };
}

export function handoffToMarkdown(note: HandoffNote, wallClock: (t: number) => string): string {
  const list = (items: string[]) => (items.length ? items.map((s) => `- ${s}`).join('\n') : '- (none)');
  return [
    `# Shift handoff — ${wallClock(note.generatedAt)}`,
    `_Generated by local rules from the shared records (source: ${note.source})._`,
    '',
    '## What is happening', list(note.happening), '',
    '## Verified', list(note.verified), '',
    '## Still uncertain', list(note.uncertain), '',
    '## Done', list(note.done), '',
    '## Owners', list(note.owners.map((o) => `${o.item} — **${o.owner}**`)), '',
    '## Do not repeat', list(note.doNotRepeat), '',
    '## Watch', list(note.watch.map((w) => `${wallClock(w.atMin)} · ${w.assetId}: ${w.why}`)),
    '',
  ].join('\n');
}
