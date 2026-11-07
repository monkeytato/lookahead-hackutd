/**
 * Incident ranking. Transparent weighted sum of 0–1 factor scores; every factor carries a
 * human-readable note so the UI can show exactly why an incident ranks where it does.
 *
 * Weights are ILLUSTRATIVE and operator-configured (versioned as POLICY_VERSION), not a learned
 * model. Changing a weight must bump the policy version.
 */
import type { Asset, Employee, Facility, ID, ImpactClock, Incident, PriorityFactor, PriorityResult, Skill, Task } from '../types';

export const POLICY_VERSION = 'priority-policy v0.3 (illustrative weights, operator-configured)';

export interface PriorityContext {
  facility: Facility;
  clocks: Record<ID, ImpactClock>;
  now: number;
  tasks: Task[];
  employees: Employee[];
}

const WEIGHTS = {
  service: 0.3,
  urgency: 0.25,
  redundancy: 0.15,
  evidence: 0.15,
  resources: 0.1,
  consequence: 0.05,
} as const;

const EVIDENCE_SCORE: Record<Incident['evidence'], number> = {
  corroborated_abnormal: 1,
  unverified: 0.6,
  inconclusive: 0.5,
  // Disagreement keeps a floor — a disputed reading is never ranked as "nothing".
  measurement_disagreement: 0.25,
  not_corroborated_in_session: 0.3,
};

const EVIDENCE_LABEL: Record<Incident['evidence'], string> = {
  corroborated_abnormal: 'corroborated by an independent measurement',
  unverified: 'not yet verified (single source)',
  inconclusive: 'verification inconclusive',
  measurement_disagreement: 'installed sensor and reference probe disagree',
  not_corroborated_in_session: 'not corroborated in the last session',
};

/** Pair types whose loss removes a redundant path. */
const REDUNDANT_TYPES: Asset['type'][] = ['crah', 'ups', 'pdu'];

/** Skills a technician would need for an asset type when no task specifies them. */
const DEFAULT_SKILLS: Partial<Record<Asset['type'], Skill[]>> = {
  rack: ['cooling'], crah: ['cooling'], chiller: ['mechanical'], pump: ['mechanical'], cdu: ['cooling'],
  ups: ['electrical'], pdu: ['electrical'], ats: ['electrical'], utility: ['electrical'], generator: ['electrical'],
  battery: ['battery'], pipe: ['leak_response'], drain: ['leak_response'],
};

/** How bad a wrong action at this asset type is (illustrative). */
const CONSEQUENCE: Partial<Record<Asset['type'], [number, string]>> = {
  ups: [1, 'switching or isolating UPS equipment wrongly can drop a whole power path'],
  battery: [1, 'battery-room work carries thermal-runaway and arc-flash risk'],
  ats: [1, 'a wrong transfer can drop the critical bus'],
  pdu: [0.8, 'a wrong breaker operation drops every rack on that side'],
  crah: [0.6, 'stopping the wrong CRAH removes cooling from neighbouring racks'],
  chiller: [0.6, 'a wrong isolation reduces chilled-water capacity'],
  pump: [0.6, 'a wrong isolation stops chilled-water flow'],
  pipe: [0.7, 'isolating the wrong valve can stop cooling for the hall'],
  rack: [0.3, 'acting on a single rack has a contained blast radius'],
};

/** Every node reachable downstream from `root` over the dependency graph (incl. root). */
function downstreamOf(facility: Facility, root: ID): Set<ID> {
  const out = new Map<ID, ID[]>();
  for (const e of facility.edges) {
    if (!e.confirmed) continue;
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e.to);
  }
  const seen = new Set<ID>([root]);
  const stack = [root];
  while (stack.length) for (const n of out.get(stack.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
  return seen;
}

export function rankIncidents(incidents: Incident[], ctx: PriorityContext): PriorityResult[] {
  const { facility, clocks, now, tasks, employees } = ctx;
  const assetById = new Map(facility.assets.map((a) => [a.id, a]));
  const svcById = new Map(facility.services.map((s) => [s.id, s]));

  const results = incidents.map((inc): PriorityResult => {
    const root = assetById.get(inc.rootAssetId);
    const down = downstreamOf(facility, inc.rootAssetId);
    // nodes downstream of this incident that are on a clock (or whose clock path runs through the root)
    const onClock = Object.values(clocks).filter((c) => down.has(c.assetId) || c.path.includes(inc.rootAssetId));

    // --- service impact
    let svcScore = 0;
    let svcNote = 'No hosted service is on a downstream clock.';
    {
      let best = 0, bestName = '', bestRack = '';
      for (const c of onClock) {
        const a = assetById.get(c.assetId);
        for (const sid of a?.services ?? []) {
          const s = svcById.get(sid);
          if (!s) continue;
          const v = (s.criticality / 5) * c.probWithinHorizon;
          if (v > best) { best = v; bestName = s.name; bestRack = a!.id; }
        }
      }
      if (best > 0) {
        svcScore = best;
        svcNote = `${bestName} (rack ${bestRack}) is on a downstream clock — criticality × probability = ${best.toFixed(2)}.`;
      } else if (root?.services?.length) {
        const crit = Math.max(...root.services.map((sid) => svcById.get(sid)?.criticality ?? 0));
        svcScore = (crit / 5) * 0.5;
        svcNote = `${root.id} hosts ${root.services.map((sid) => svcById.get(sid)?.name ?? sid).join(', ')} but is not on a loss clock (exposure only).`;
      }
    }

    // --- urgency: minutes to the earliest p50 downstream loss
    let urgScore = 0;
    let urgNote = 'No downstream loss within the horizon at p50.';
    {
      const future = onClock.filter((c) => c.p50 !== null && c.assetId !== inc.rootAssetId).map((c) => ({ c, m: c.p50! - now }));
      if (future.length) {
        future.sort((a, b) => a.m - b.m);
        const { c, m } = future[0];
        urgScore = m <= 10 ? 1 : Math.max(0, 1 - (m - 10) / 50);
        urgNote = m <= 0
          ? `${c.assetId} is already past its p50 loss time.`
          : `Earliest downstream p50 loss: ${c.assetId} in ${m.toFixed(0)} min (≤ 10 min scores 1, 60 min scores 0).`;
      }
    }

    // --- redundancy: does this incident take out one side of a redundant pair?
    let redScore = 0;
    let redNote = `${inc.rootAssetId} is not one side of a redundant pair.`;
    {
      const grouped = facility.edges.filter((e) => e.from === inc.rootAssetId && e.redundancyGroup && e.confirmed);
      if (grouped.length && root) {
        const dependents = new Set(grouped.map((e) => e.to));
        redScore = REDUNDANT_TYPES.includes(root.type) ? 1 : 0.6;
        redNote = `Losing ${root.id} removes one of the redundant paths for ${dependents.size} downstream asset${dependents.size > 1 ? 's' : ''} — they would run on a single path.`;
      }
    }

    // --- evidence quality
    const evScore = EVIDENCE_SCORE[inc.evidence];
    const evNote = `Evidence: ${EVIDENCE_LABEL[inc.evidence]}.`;

    // --- resource feasibility: is someone eligible and available right now?
    const incTasks = tasks.filter((t) => t.incidentId === inc.id && t.status !== 'cancelled');
    const skills: Skill[] = incTasks.length
      ? [...new Set(incTasks.flatMap((t) => t.requiredSkills))]
      : (root ? DEFAULT_SKILLS[root.type] ?? [] : []);
    const zone = root?.zoneId;
    const eligible = employees.filter((e) => e.availability === 'available' && skills.every((s) => e.skills.includes(s)) && (!zone || e.zones.includes(zone)));
    const resScore = eligible.length ? 1 : 0.2;
    const resNote = eligible.length
      ? `${eligible.length} available with ${skills.join(', ') || 'required'} skill and ${zone} access (${eligible.map((e) => e.initials).join(', ')}).`
      : `Nobody available with ${skills.join(', ') || 'the required'} skill and ${zone} access — escalate or call in.`;

    // --- consequence of the wrong action
    const [conScore, conText] = (root && CONSEQUENCE[root.type]) ?? [0.3, 'contained blast radius'];
    const conNote = `Consequence if mishandled: ${conText}.`;

    const factors: PriorityFactor[] = [
      { key: 'service', label: 'Service impact', score: svcScore, weight: WEIGHTS.service, note: svcNote },
      { key: 'urgency', label: 'Time to impact', score: urgScore, weight: WEIGHTS.urgency, note: urgNote },
      { key: 'redundancy', label: 'Redundancy lost', score: redScore, weight: WEIGHTS.redundancy, note: redNote },
      { key: 'evidence', label: 'Evidence quality', score: evScore, weight: WEIGHTS.evidence, note: evNote },
      { key: 'resources', label: 'Resource feasibility', score: resScore, weight: WEIGHTS.resources, note: resNote },
      { key: 'consequence', label: 'Consequence of wrong action', score: conScore, weight: WEIGHTS.consequence, note: conNote },
    ].map((f) => ({ ...f, score: Math.round(f.score * 100) / 100 }));
    const total = Math.round(factors.reduce((s, f) => s + f.score * f.weight, 0) * 1000) / 1000;

    let resolvingCheck: string | undefined;
    if (inc.evidence === 'unverified' || inc.evidence === 'inconclusive' || inc.evidence === 'measurement_disagreement') {
      const check = incTasks.find((t) => t.type === 'verify' || t.type === 'inspect');
      const point = root?.type === 'rack' ? 'at the rack inlet, same height as the installed sensor' : `at ${inc.rootAssetId}'s measurement point`;
      resolvingCheck = check
        ? `${check.title} (${check.id}) — an independent reference reading ${point} settles whether the alert is real.`
        : `Take a reference-probe reading ${point} to confirm or rule out the alert on ${inc.rootAssetId}.`;
    }

    return { incidentId: inc.id, total, factors, policyVersion: POLICY_VERSION, resolvingCheck };
  });

  return results.sort((a, b) => b.total - a.total || a.incidentId.localeCompare(b.incidentId));
}
