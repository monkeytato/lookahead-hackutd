/**
 * Random disaster generator. `randomScenario(id)` is deterministic in its id ("rnd-<base36 seed>"),
 * so any screen can rebuild the same disaster from the id alone.
 *
 * One primary event from the templates below, plus (half the time) one compounding event a few
 * minutes later. Event times are random draws; every consequence comes from the facility's
 * dependency graph and its delay assumptions. A scenario that would produce no clock within the
 * horizon gets an extra compounding event, so it is always presentable.
 */
import { facility, seedReadings } from '../fixture';
import { mulberry32 } from '../engine/rng';
import { simulateScenario } from '../engine/simulate';
import type { Hazard, ID, Incident, Scenario, ScenarioStep } from '../types';

type Rand = () => number;
interface Event {
  key: TemplateKey;
  label: string;
  faults: { assetId: ID; t: number }[];
  steps: ScenarioStep[];
  incidents: Incident[];
  leak?: Scenario['leak'];
  hazards?: Hazard[];
  /** Asset ids this event already uses (a compounding event avoids them) */
  uses: ID[];
}
export type TemplateKey = 'leak' | 'chillers' | 'crah' | 'power' | 'ups_fire' | 'pdu';
export const TEMPLATES: TemplateKey[] = ['leak', 'chillers', 'crah', 'power', 'ups_fire', 'pdu'];

const pick = <T,>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length) % xs.length];
const between = (r: Rand, lo: number, hi: number) => Math.round((lo + r() * (hi - lo)) * 2) / 2; // 0.5-min steps
const inc = (n: number, i: Omit<Incident, 'id' | 'status' | 'shiftLeadId' | 'recentChanges'>): Incident => ({
  id: `INC-${7100 + n}`, status: 'open', shiftLeadId: 'emp-priya', recentChanges: [], ...i,
});

let incN = 0;
const BUILDERS: Record<TemplateKey, (r: Rand, t0: number) => Event> = {
  leak(r, t0) {
    const atCdu = r() < 0.35;
    const x = atCdu ? 27.4 : 33.2;
    const z = atCdu ? 21.3 : between(r, 10, 15);
    const src = atCdu ? 'CDU-1' : 'PIPE-L2';
    const seen = atCdu ? t0 + 1 : t0 + between(r, 4, 8);
    const rate = Math.round(between(r, 30, 55));
    return {
      key: 'leak', label: atCdu ? 'coolant leak at CDU-1' : 'chilled-water riser leak', uses: [src],
      faults: [],
      leak: { x, z, ratePerMin: rate, startT: t0 },
      steps: [
        { t: t0, kind: 'fault', assetId: src, summary: atCdu ? 'CDU-1 secondary loop starts leaking under the floor tile' : `Riser ${src} starts leaking above the corridor (no sensor on Level 2)` },
        atCdu
          ? { t: seen, kind: 'alert', assetId: src, summary: 'Leak-detection cable wet under CDU-1', metric: 'leak', value: 1, source: 'installed' }
          : { t: seen, kind: 'reading', assetId: src, summary: `Loop make-up water flow up — ${rate} L/min unaccounted for`, metric: 'flow_lpm', value: rate, source: 'simulated' },
      ],
      incidents: [inc(++incN, {
        title: atCdu ? 'Coolant leak at CDU-1' : 'Possible leak — loop make-up flow rising', rootAssetId: src, alertAssetIds: [src],
        severity: atCdu ? 'critical' : 'warning', evidence: atCdu ? 'corroborated_abnormal' : 'unverified', openedAt: seen,
        summary: atCdu ? 'The leak-detection cable under CDU-1 is wet. The GPU racks it cools have minutes of margin.' : 'Make-up flow no longer matches supply. The riser above the east corridor is the only pipe run consistent with it.',
        runbookId: 'RB-LEAK',
      })],
    };
  },
  chillers(r, t0) {
    const [a, b] = r() < 0.5 ? ['CH-1', 'CH-2'] : ['CH-2', 'CH-1'];
    const t1 = t0 + between(r, 6, 14);
    return {
      key: 'chillers', label: `${a} trip, then ${b}`, uses: [a, b],
      faults: [{ assetId: a, t: t0 }, { assetId: b, t: t1 }],
      steps: [
        { t: t0, kind: 'fault', assetId: a, summary: `${a} trips on high condenser pressure` },
        { t: t0, kind: 'alert', assetId: a, summary: `${a} tripped — running on ${b} only`, metric: 'supply_temp_c', value: 11.8, source: 'installed' },
        { t: t1, kind: 'fault', assetId: b, summary: `${b} trips under the full load` },
        { t: t1, kind: 'alert', assetId: b, summary: `${b} tripped — no chilled water`, metric: 'supply_temp_c', value: 15.6, source: 'installed' },
      ],
      incidents: [
        inc(++incN, { title: `${a} tripped — running on ${b} only`, rootAssetId: a, alertAssetIds: [a], severity: 'warning', evidence: 'corroborated_abnormal', openedAt: t0, summary: 'Chilled-water redundancy is gone. No rack impact unless the other chiller also trips.' }),
        inc(++incN, { title: `${b} tripped — no chilled water`, rootAssetId: b, alertAssetIds: [a, b, 'P-1', 'P-2'], severity: 'critical', evidence: 'corroborated_abnormal', openedAt: t1, summary: 'Both chillers are down; the loop thermal mass is the only buffer left.' }),
      ],
    };
  },
  crah(r, t0) {
    const [a, b] = pick(r, [['CRAH-1', 'CRAH-3'], ['CRAH-3', 'CRAH-1'], ['CRAH-2', 'CRAH-4'], ['CRAH-4', 'CRAH-2']] as const);
    const t1 = t0 + between(r, 5, 12);
    const rows = a === 'CRAH-1' || a === 'CRAH-3' ? 'A–B' : 'C–D';
    return {
      key: 'crah', label: `${a} fan failure, then ${b}`, uses: [a, b],
      faults: [{ assetId: a, t: t0 }, { assetId: b, t: t1 }],
      steps: [
        { t: Math.max(0, t0 - 2), kind: 'alert', assetId: a, summary: `${a} fan vibration 7.4 mm/s (ISO zone D)`, metric: 'vibration_mm_s', value: 7.4, source: 'installed' },
        { t: t0, kind: 'fault', assetId: a, summary: `${a} fan fails` },
        { t: t1, kind: 'fault', assetId: b, summary: `${b} trips on overload carrying rows ${rows} alone` },
        { t: t1, kind: 'alert', assetId: b, summary: `${b} fan overload trip`, metric: 'vibration_mm_s', value: 8.1, source: 'installed' },
      ],
      incidents: [
        inc(++incN, { title: `${a} fan failed — rows ${rows} on one CRAH`, rootAssetId: a, alertAssetIds: [a], severity: 'warning', evidence: 'corroborated_abnormal', openedAt: Math.max(0, t0 - 2), summary: `Losing ${a} leaves ${b} carrying rows ${rows} alone.`, runbookId: 'RB-FAN-VIB' }),
        inc(++incN, { title: `${b} tripped — rows ${rows} have no cooling`, rootAssetId: b, alertAssetIds: [a, b], severity: 'critical', evidence: 'corroborated_abnormal', openedAt: t1, summary: `Both CRAHs for rows ${rows} are down. Thermal ride-through clocks have started.` }),
      ],
    };
  },
  power(_r, t0) {
    return {
      key: 'power', label: 'utility loss, generator does not start', uses: ['UTIL', 'GEN-1', 'ATS-1'],
      faults: [{ assetId: 'UTIL', t: t0 }, { assetId: 'GEN-1', t: t0 }],
      steps: [
        { t: t0, kind: 'fault', assetId: 'UTIL', summary: 'Utility feed lost' },
        { t: t0, kind: 'alert', assetId: 'ATS-1', summary: 'ATS-1 transfer requested — generator start not acknowledged' },
        { t: t0 + 1, kind: 'reading', assetId: 'UPS-A', summary: 'UPS-A on battery — 12 min autonomy at current load', metric: 'ups_autonomy_min', value: 12, source: 'installed' },
      ],
      incidents: [inc(++incN, { title: 'Utility lost — generator did not start', rootAssetId: 'ATS-1', alertAssetIds: ['UTIL', 'GEN-1', 'ATS-1', 'BATT-A', 'BATT-B'], severity: 'critical', evidence: 'corroborated_abnormal', openedAt: t0, summary: 'The load is on UPS batteries and cooling has no power. A manual generator start is the fastest recovery.' })],
    };
  },
  ups_fire(r, t0) {
    const origin = r() < 0.5 ? 'UPS-A' : 'UPS-B';
    const a = facility.assets.find((x) => x.id === origin)!;
    const speed = between(r, 0.4, 0.7);
    return {
      key: 'ups_fire', label: `fire at ${origin}`, uses: [origin],
      faults: [],
      hazards: [
        { kind: 'fire', originAssetId: origin, x: a.pos.x, z: a.pos.z, startT: t0, spreadMPerMin: speed, maxRadiusM: 10, zoneIds: ['Z-UPS'] },
        { kind: 'smoke', originAssetId: origin, x: a.pos.x, z: a.pos.z, startT: t0, spreadMPerMin: 1.5, maxRadiusM: 18, zoneIds: ['Z-UPS', 'Z-CORR', 'Z-BATT'] },
      ],
      steps: [
        { t: t0, kind: 'fault', assetId: origin, summary: `Fire starts at ${origin}` },
        { t: t0, kind: 'alert', assetId: origin, summary: `Smoke detection in the UPS room — ${origin}`, metric: 'battery_temp_c', value: 55, source: 'installed' },
      ],
      incidents: [inc(++incN, { title: `Fire in the UPS room — ${origin}`, rootAssetId: origin, alertAssetIds: [origin, 'UPS-A', 'UPS-B', 'ATS-1'].filter((v, i, xs) => xs.indexOf(v) === i), severity: 'critical', evidence: 'corroborated_abnormal', openedAt: t0, summary: `Smoke and heat at ${origin}. The other UPS and the transfer switch share the room.` })],
    };
  },
  pdu(r, t0) {
    const [a, b] = pick(r, [['PDU-A1', 'PDU-B1'], ['PDU-B1', 'PDU-A1'], ['PDU-A2', 'PDU-B2'], ['PDU-B2', 'PDU-A2']] as const);
    const t1 = t0 + between(r, 4, 10);
    const rows = a.endsWith('1') ? 'A–B' : 'C–D';
    return {
      key: 'pdu', label: `${a} breaker trip, then ${b}`, uses: [a, b],
      faults: [{ assetId: a, t: t0 }, { assetId: b, t: t1 }],
      steps: [
        { t: t0, kind: 'fault', assetId: a, summary: `${a} main breaker trips` },
        { t: t0, kind: 'alert', assetId: a, summary: `${a} output lost — rows ${rows} on side ${b.slice(4, 5)} only`, metric: 'load_kw', value: 0, source: 'installed' },
        { t: t1, kind: 'fault', assetId: b, summary: `${b} trips on overload after the load transfer` },
      ],
      incidents: [
        inc(++incN, { title: `${a} breaker tripped`, rootAssetId: a, alertAssetIds: [a], severity: 'warning', evidence: 'corroborated_abnormal', openedAt: t0, summary: `Dual-corded racks in rows ${rows} moved to ${b}. Single-corded racks lost power.` }),
        inc(++incN, { title: `${b} overload trip — rows ${rows} dark`, rootAssetId: b, alertAssetIds: [a, b], severity: 'critical', evidence: 'corroborated_abnormal', openedAt: t1, summary: `Both feeds for rows ${rows} are down.` }),
      ],
    };
  },
};

/** Seed from an id: "rnd-<base36>" → number. Any other string hashes to a seed. */
export function seedOf(id: string): number {
  const m = id.match(/^rnd-([0-9a-z]+)$/);
  if (m) { const v = parseInt(m[1], 36); if (Number.isFinite(v)) return v >>> 0; }
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const hasClock = (s: Scenario) => {
  const run = simulateScenario({ facility, scenario: s, seedReadings: seedReadings(), runs: 60 });
  return Object.values(run.clocks).some((c) => c.p50 !== null && c.path.length > 1);
};

function assemble(id: string, events: Event[]): Scenario {
  const steps = events.flatMap((e) => e.steps).sort((a, b) => a.t - b.t);
  const labels = events.map((e) => e.label);
  const title = labels.length > 1 ? `${cap(labels[0])}, then ${labels[1]}` : cap(labels[0]);
  return {
    id,
    kind: 'random',
    name: `Random: ${labels.join(' + ')}`,
    headline: title,
    description: `Generated disaster: ${labels.join('; then ')}. Consequences come from the facility's dependency graph and its delay assumptions.`,
    basis: `Randomly generated what-if (seed ${id}). Event times are random draws; dependency delays are the facility's assumptions. Simulated.`,
    horizonMin: 60,
    faults: events.flatMap((e) => e.faults),
    leak: events.find((e) => e.leak)?.leak,
    hazards: events.flatMap((e) => e.hazards ?? []),
    steps,
    incidents: events.flatMap((e) => e.incidents).sort((a, b) => a.openedAt - b.openedAt),
  };
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const cache = new Map<string, Scenario>();

/** Cached: the same id always returns the same object. */
export function randomScenario(id: string): Scenario {
  let s = cache.get(id);
  if (!s) { s = generateRandomScenario(id); cache.set(id, s); }
  return s;
}

/** Uncached generation (deterministic in the id). */
export function generateRandomScenario(id: string): Scenario {
  const r = mulberry32(seedOf(id));
  incN = 0;
  const primary = pick(r, TEMPLATES);
  const t0 = between(r, 1, 6);
  const events: Event[] = [BUILDERS[primary](r, t0)];
  // a compounding event starts 4–12 min after the primary (another template, at most one leak)
  const compound = (avoid: TemplateKey[]) => {
    const keys = TEMPLATES.filter((k) => !avoid.includes(k) && !(k === 'leak' && events.some((e) => e.leak)));
    return BUILDERS[pick<TemplateKey>(r, keys.length ? keys : ['chillers'])](r, Math.min(40, t0 + between(r, 4, 12)));
  };
  if (r() < 0.5) events.push(compound([primary]));
  let s = assemble(id, events);
  for (let tries = 0; tries < 3 && !hasClock(s); tries++) {
    events.push(compound(events.map((e) => e.key)));
    s = assemble(id, events);
  }
  return s;
}

