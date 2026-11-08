/**
 * Phone summary: ONE compact JSON for the native iPhone app (ios/). The engine runs here, on the
 * laptop; the phone only renders. The contract below is mirrored by the Swift Codable models, so
 * key names and types must not change without changing ios/ too.
 *
 *   GET  /api/phone          → PhonePayload
 *   POST /api/phone/random   → start a random disaster (autoplay), returns PhonePayload
 *   POST /api/phone/fix      → {assetId, action}: order a fix the engine offers right now
 * Everything else (play, pause, jump, lookahead, autopause) goes through POST /api/stage {cmd}.
 *
 * Same split as the browser store (audit C1): the script run is the WORLD (which incidents have
 * opened, what is wet); every number presented as a prediction (forecast block, clocks, fix savings)
 * comes from liveForecast — only faults observed or inferable at t — so phone, desktop and stage agree.
 */
import { facility, SCENARIO_WALL_START, seedReadings, services } from '../src/domain/fixture';
import { fixOptionsFor, makeFix, predictFix, simulateScenario, type ScenarioRun } from '../src/domain/engine';
import { liveForecast } from '../src/state/liveForecast';
import type { FixContext } from '../src/domain/engine';
import { DEFAULT_FLOOR_WET_RAW } from '../src/domain/rig/scan';
import type { StampedFrame } from '../src/domain/rig/protocol';
import { getScenario, incidentsFor, randomScenarioId } from '../src/domain/scenarios';
import type { Fix, ID, Scenario, Severity } from '../src/domain/types';
import { detectedAt } from '../src/state/selectors';
import { stageTime, type StageCommand, type StageState } from '../src/stage/protocol';

type Sev = 'critical' | 'warning' | 'advisory';

export interface PhonePayload {
  now: number;
  stage: {
    scenarioId: string; headline: string; kind: 'real' | 'random' | 'what-if'; basis: string;
    t: number; horizon: number; wallClock: string; playing: boolean; speed: number;
    autoPause: boolean; lookaheadMin: number; last: string;
  };
  forecast: {
    firstRackLossIn: number | null; firstRackAssetId: string | null;
    racksTotal: number; racksLost: number; racksAtRisk: number;
    assetsLost: number; servicesAtRisk: number; savedByFixes: number;
  };
  clocks: { assetId: string; name: string; inMin: number; p10In: number; p90In: number; severity: Sev }[];
  problems: {
    id: string; title: string; severity: Sev; assetId: string; openedAt: number;
    fixes: { action: string; assetId: string; label: string; delayMin: number; savesRacks: number; savesAssets: number }[];
  }[];
  fixes: { id: string; label: string; assetId: string; orderedAt: number; effectiveAt: number; inEffect: boolean }[];
  rig: {
    mode: 'serial' | 'simulated' | 'disconnected'; inletC: number | null; outletC: number | null; referenceC: number | null;
    deltaC: number | null; floorWet: boolean | null; ageS: number | null;
  };
  director: { configured: boolean; model: string };
}

export interface PhoneDeps {
  latestFrame(): StampedFrame | null;
  deviceMode(): 'serial' | 'simulated' | 'disconnected';
  director: { configured: boolean; model: string };
}

const SEED = seedReadings();
const RACKS = new Set(facility.assets.filter((a) => a.type === 'rack').map((a) => a.id));
const NAME = new Map(facility.assets.map((a) => [a.id, a.name]));
const SEV_RANK: Record<Sev, number> = { critical: 3, warning: 2, advisory: 1 };
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Same rule as the desktop's wallClock: scenario minute 0 = SCENARIO_WALL_START. */
export function wallClock(t: number): string {
  const total = SCENARIO_WALL_START.h * 60 + SCENARIO_WALL_START.m + Math.round(t);
  const h = (((Math.floor(total / 60)) % 24) + 24) % 24;
  const m = ((total % 60) + 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Same thresholds as simulate.ts visualAt: ≤ 10 min critical, ≤ 30 warning. */
const clockSeverity = (inMin: number): Sev => (inMin <= 10 ? 'critical' : inMin <= 30 ? 'warning' : 'advisory');
const incidentSeverity = (s: Severity): Sev => (s === 'critical' ? 'critical' : s === 'warning' ? 'warning' : 'advisory');

// ---- run cache: keyed by scenario + fixes (the phone polls about once a second)
const runs = new Map<string, ScenarioRun>();
function runFor(scenario: Scenario, fixes: Fix[]): ScenarioRun {
  const key = `${scenario.id}|${fixes.map((f) => `${f.assetId}:${f.action}@${f.effectiveAt}`).sort().join(',')}`;
  let r = runs.get(key);
  if (!r) {
    r = simulateScenario({ facility, scenario, seedReadings: seedReadings(), fixes });
    runs.set(key, r);
    if (runs.size > 24) runs.delete(runs.keys().next().value!);
  }
  return r;
}

const racksLostBy = (run: ScenarioRun) => Object.values(run.clocks).filter((c) => RACKS.has(c.assetId) && c.p50 !== null).length;

export function phoneSummary(state: StageState, now: number, deps: PhoneDeps): PhonePayload {
  const scenario = getScenario(state.scenarioId);
  const H = scenario.horizonMin;
  const t = stageTime(state, H, now);
  const run = runFor(scenario, state.fixes); // the world: incidents and water
  const forecast = liveForecast({ facility, scenario, seedReadings: SEED, t, fixes: state.fixes });
  const clocks = Object.values(forecast.clocks);

  // ---- forecast (p50 = absolute scenario minute; a clock with p50 set is lost by the horizon)
  const rackClocks = clocks.filter((c) => RACKS.has(c.assetId) && c.p50 !== null);
  const nextRack = rackClocks.filter((c) => c.p50! > t).sort((a, b) => a.p50! - b.p50!)[0];
  const lostAssets = clocks.filter((c) => c.p50 !== null && NAME.has(c.assetId));
  const lostSet = new Set(lostAssets.map((c) => c.assetId));
  const servicesAtRisk = services.filter((s) => s.replicas.some((r) => lostSet.has(r))).length;
  const savedByFixes = state.fixes.length ? Math.max(0, racksLostBy(liveForecast({ facility, scenario, seedReadings: SEED, t })) - racksLostBy(forecast)) : 0;

  // ---- top 3 future forecast clocks (root fault observable; the detectedAt check is kept as a guard)
  const future = clocks
    .filter((c) => NAME.has(c.assetId) && c.p50 !== null && c.p50 > t && c.path.length > 1 && detectedAt(scenario, c.path[0]) <= t)
    .sort((a, b) => a.p50! - b.p50!)
    .slice(0, 3)
    .map((c) => {
      const inMin = round1(c.p50! - t);
      return {
        assetId: c.assetId, name: NAME.get(c.assetId)!, inMin,
        p10In: round1(Math.max(0, (c.p10 ?? c.p50!) - t)), p90In: round1(Math.max(0, (c.p90 ?? c.p50!) - t)),
        severity: clockSeverity(inMin),
      };
    });

  // ---- problems: incidents visible at t, minus those whose root has a fix in effect (they are being monitored)
  const fixedNow = new Set(state.fixes.filter((f) => f.effectiveAt <= t).map((f) => f.assetId));
  const ctx: FixContext = { facility, scenario, seedReadings: SEED, fixes: state.fixes, t, run: forecast, mode: 'forecast' };
  const problems = incidentsFor(scenario, run)
    .filter((i) => i.openedAt <= t && i.status !== 'resolved' && !fixedNow.has(i.rootAssetId))
    .sort((a, b) => SEV_RANK[incidentSeverity(b.severity)] - SEV_RANK[incidentSeverity(a.severity)] || b.openedAt - a.openedAt)
    .slice(0, 4)
    .map((i) => {
      let options = fixOptionsFor(ctx, i.rootAssetId);
      for (const id of i.alertAssetIds) { if (options.length) break; options = fixOptionsFor(ctx, id); }
      return {
        id: i.id, title: i.title, severity: incidentSeverity(i.severity), assetId: i.rootAssetId, openedAt: i.openedAt,
        fixes: options.slice(0, 2).map((o) => {
          const p = predictFix(ctx, o);
          return { action: o.action, assetId: o.assetId, label: o.label, delayMin: o.delayMin, savesRacks: Math.max(0, p.racksWithout - p.racksWith), savesAssets: Math.max(0, p.lostWithout - p.lostWith) };
        }),
      };
    });

  // ---- rig: inlet = mean of the acoustic inlet beams that have a value; the reference probe only when both beams are null
  const f = deps.latestFrame();
  const beams = f ? [f.inlet_top_c, f.inlet_bottom_c].filter((v): v is number => v !== null) : [];
  const inletC = f ? (beams.length ? round1(beams.reduce((a, b) => a + b, 0) / beams.length) : f.ref_c) : null;
  const outletC = f?.outlet_c ?? null;

  return {
    now,
    stage: {
      scenarioId: scenario.id, headline: scenario.headline ?? scenario.name, kind: scenario.kind ?? 'what-if', basis: scenario.basis,
      t, horizon: H, wallClock: wallClock(t), playing: state.playing && t < H, speed: state.speed,
      autoPause: state.autoPause, lookaheadMin: state.lookaheadMin, last: state.last,
    },
    forecast: {
      firstRackLossIn: nextRack ? round1(nextRack.p50! - t) : null, firstRackAssetId: nextRack?.assetId ?? null,
      racksTotal: RACKS.size, racksLost: rackClocks.filter((c) => c.p50! <= t).length, racksAtRisk: rackClocks.filter((c) => c.p50! > t).length,
      assetsLost: lostAssets.filter((c) => c.p50! <= t).length, servicesAtRisk, savedByFixes,
    },
    clocks: future,
    problems,
    fixes: state.fixes.map((x) => ({ id: x.id, label: x.label, assetId: x.assetId, orderedAt: x.orderedAt, effectiveAt: x.effectiveAt, inEffect: x.effectiveAt <= t })),
    rig: {
      mode: deps.deviceMode(), inletC, outletC: outletC === null ? null : round1(outletC), referenceC: f?.ref_c == null ? null : round1(f.ref_c),
      deltaC: inletC !== null && outletC !== null ? round1(outletC - inletC) : null,
      floorWet: f ? f.floor_raw >= DEFAULT_FLOOR_WET_RAW : null,
      ageS: f ? round1(Math.max(0, (now - Date.parse(f.at)) / 1000)) : null,
    },
    director: deps.director,
  };
}

/** POST /api/phone/fix: the option must be on offer at the current stage time. */
export function phoneFixCommand(state: StageState, now: number, body: unknown): { ok: true; cmd: StageCommand } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.assetId !== 'string' || typeof b.action !== 'string') return { ok: false, error: 'assetId and action are required' };
  const scenario = getScenario(state.scenarioId);
  const t = stageTime(state, scenario.horizonMin, now);
  const forecast = liveForecast({ facility, scenario, seedReadings: SEED, t, fixes: state.fixes });
  const option = fixOptionsFor({ facility, scenario, seedReadings: SEED, fixes: state.fixes, t, run: forecast, mode: 'forecast' }, b.assetId as ID).find((o) => o.action === b.action);
  if (!option) return { ok: false, error: `no "${b.action}" fix is available for ${b.assetId} right now` };
  return { ok: true, cmd: { type: 'fix', fix: makeFix(option, t) } };
}

/** POST /api/phone/random */
export const phoneRandomCommand = (): StageCommand => ({ type: 'scenario', scenarioId: randomScenarioId(), autoplay: true });
