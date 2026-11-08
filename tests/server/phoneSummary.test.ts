import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { phoneFixCommand, phoneRandomCommand, phoneSummary, wallClock, type PhoneDeps, type PhonePayload } from '../../server/phoneSummary';
import { applyStageCommand, initialStage, type StageState } from '../../src/stage/protocol';
import type { StampedFrame } from '../../src/domain/rig/protocol';

const T0 = 1_800_000_000_000;
const H = 60;
const frame: StampedFrame = {
  v: 1, dev: 'RACKMON-SIM', fw: 'sim-1.0', seq: 1, up_ms: 1000,
  inlet_top_c: 22.8, inlet_bottom_c: 22.4, outlet_c: 31, echo_us: { inlet_top: 1040, inlet_bottom: 1041, outlet: 1010 },
  beam_age_s: { inlet_top: 1, inlet_bottom: 2, outlet: 0 }, ref_c: 22.5, reservoir_raw: 600, floor_raw: 1, pack_v: 8.9,
  flap: 'closed', valve: 'closed', fan_pct: [70, 70], auto: true, flags: [], event: null,
  source: 'simulated', at: new Date(T0 - 500).toISOString(),
};
const deps: PhoneDeps = { latestFrame: () => frame, deviceMode: () => 'simulated', director: { configured: false, model: 'nvidia/nemotron-3.5-lightning-30b-a3b' } };
/** Paused stage at scenario minute t. */
const at = (t: number, s: StageState = initialStage('scn-riser-leak', T0)): StageState => applyStageCommand(s, { type: 'seek', t }, H, T0);

const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown) => v === null || isNum(v);
const SEV = ['critical', 'warning', 'advisory'];

function expectShape(p: PhonePayload) {
  expect(Object.keys(p).sort()).toEqual(['clocks', 'director', 'fixes', 'forecast', 'now', 'problems', 'rig', 'stage']);
  expect(isNum(p.now)).toBe(true);
  const s = p.stage;
  expect(Object.keys(s).sort()).toEqual(['autoPause', 'basis', 'headline', 'horizon', 'kind', 'last', 'lookaheadMin', 'playing', 'scenarioId', 'speed', 't', 'wallClock']);
  for (const k of ['scenarioId', 'headline', 'basis', 'wallClock', 'last'] as const) expect(typeof s[k]).toBe('string');
  for (const k of ['t', 'horizon', 'speed', 'lookaheadMin'] as const) expect(isNum(s[k])).toBe(true);
  for (const k of ['playing', 'autoPause'] as const) expect(typeof s[k]).toBe('boolean');
  expect(['real', 'random', 'what-if']).toContain(s.kind);
  expect(s.wallClock).toMatch(/^\d\d:\d\d$/);
  const f = p.forecast;
  expect(Object.keys(f).sort()).toEqual(['assetsLost', 'firstRackAssetId', 'firstRackLossIn', 'racksAtRisk', 'racksLost', 'racksTotal', 'savedByFixes', 'servicesAtRisk']);
  expect(numOrNull(f.firstRackLossIn)).toBe(true);
  expect(f.firstRackAssetId === null || typeof f.firstRackAssetId === 'string').toBe(true);
  for (const k of ['racksTotal', 'racksLost', 'racksAtRisk', 'assetsLost', 'servicesAtRisk', 'savedByFixes'] as const) expect(Number.isInteger(f[k])).toBe(true);
  for (const c of p.clocks) {
    expect(Object.keys(c).sort()).toEqual(['assetId', 'inMin', 'name', 'p10In', 'p90In', 'severity']);
    expect(c.inMin).toBeGreaterThan(0);
    expect(SEV).toContain(c.severity);
  }
  for (const pr of p.problems) {
    expect(Object.keys(pr).sort()).toEqual(['assetId', 'fixes', 'id', 'openedAt', 'severity', 'title']);
    expect(SEV).toContain(pr.severity);
    for (const x of pr.fixes) {
      expect(Object.keys(x).sort()).toEqual(['action', 'assetId', 'delayMin', 'label', 'savesAssets', 'savesRacks']);
      expect(isNum(x.delayMin) && Number.isInteger(x.savesRacks) && Number.isInteger(x.savesAssets)).toBe(true);
    }
  }
  for (const x of p.fixes) {
    expect(Object.keys(x).sort()).toEqual(['assetId', 'effectiveAt', 'id', 'inEffect', 'label', 'orderedAt']);
    expect(typeof x.inEffect).toBe('boolean');
  }
  expect(Object.keys(p.rig).sort()).toEqual(['ageS', 'deltaC', 'floorWet', 'inletC', 'mode', 'outletC', 'referenceC']);
  expect(['serial', 'simulated', 'disconnected']).toContain(p.rig.mode);
  for (const k of ['inletC', 'outletC', 'referenceC', 'deltaC', 'ageS'] as const) expect(numOrNull(p.rig[k])).toBe(true);
  expect(p.rig.floorWet === null || typeof p.rig.floorWet === 'boolean').toBe(true);
  expect(Object.keys(p.director).sort()).toEqual(['configured', 'model']);
}

describe('phoneSummary', () => {
  it('matches the contract at several times in scn-riser-leak', () => {
    for (const t of [0, 5, 14, 30, 59]) {
      const p = phoneSummary(at(t), T0, deps);
      expectShape(p);
      expect(p.stage.t).toBe(t);
      expect(p.stage.wallClock).toBe(wallClock(t));
      expect(p.forecast.racksTotal).toBe(48);
      // the payload survives a JSON round trip unchanged (no undefined, NaN or Infinity)
      expect(JSON.parse(JSON.stringify(p))).toEqual(p);
    }
  });

  it('lists at most 3 future clocks, soonest first', () => {
    for (const t of [12, 20, 35]) {
      const { clocks } = phoneSummary(at(t), T0, deps);
      expect(clocks.length).toBeLessThanOrEqual(3);
      for (let i = 1; i < clocks.length; i++) expect(clocks[i].inMin).toBeGreaterThanOrEqual(clocks[i - 1].inMin);
      for (const c of clocks) expect(c.p10In).toBeLessThanOrEqual(c.p90In);
    }
    expect(phoneSummary(at(14), T0, deps).clocks.length).toBeGreaterThan(0);
  });

  it('shows a problem only once its incident has opened', () => {
    const early = phoneSummary(at(5), T0, deps).problems.map((p) => p.id);
    expect(early).not.toContain('INC-1044');
    const later = phoneSummary(at(14), T0, deps).problems;
    const leak = later.find((p) => p.id === 'INC-1044');
    expect(leak).toBeTruthy();
    expect(leak!.openedAt).toBeLessThanOrEqual(14);
    expect(later.length).toBeLessThanOrEqual(4);
  });

  it('reads the rig: inlet = mean of the acoustic inlet beams, ΔT against the outlet', () => {
    const { rig } = phoneSummary(at(0), T0, deps);
    expect(rig.inletC).toBe(22.6);
    expect(rig.deltaC).toBe(8.4);
    expect(rig.floorWet).toBe(false);
    expect(rig.ageS).toBe(0.5);
    const none = phoneSummary(at(0), T0, { ...deps, latestFrame: () => null, deviceMode: () => 'disconnected' }).rig;
    expect(none).toEqual({ mode: 'disconnected', inletC: null, outletC: null, referenceC: null, deltaC: null, floorWet: null, ageS: null });
  });

  it('validates and applies a fix intent; isolating the riser saves racks', () => {
    const s14 = at(14);
    expect(phoneFixCommand(s14, T0, { assetId: 'PIPE-L2' }).ok).toBe(false);
    expect(phoneFixCommand(s14, T0, { assetId: 'A-01', action: 'restart_chiller' }).ok).toBe(false);
    const offered = phoneSummary(s14, T0, deps).problems.find((p) => p.id === 'INC-1044')!.fixes.find((f) => f.action === 'isolate_valve');
    expect(offered).toBeTruthy();
    expect(offered!.savesRacks).toBeGreaterThan(0);
    const c = phoneFixCommand(s14, T0, { assetId: 'PIPE-L2', action: 'isolate_valve' });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const fixed = applyStageCommand(s14, c.cmd, H, T0);
    expect(fixed.fixes).toHaveLength(1);
    const later = phoneSummary(applyStageCommand(fixed, { type: 'seek', t: 30 }, H, T0), T0, deps);
    expect(later.forecast.savedByFixes).toBeGreaterThan(0);
    expect(later.fixes[0]).toMatchObject({ assetId: 'PIPE-L2', inEffect: true });
  });

  it('random intent switches to a generated scenario that plays', () => {
    const cmd = phoneRandomCommand();
    expect(cmd.type).toBe('scenario');
    const s = applyStageCommand(initialStage('scn-riser-leak', T0), cmd, H, T0);
    expect(s.scenarioId).toMatch(/^rnd-/);
    const p = phoneSummary(s, T0 + 3000, deps);
    expectShape(p);
    expect(p.stage.kind).toBe('random');
    expect(p.stage.playing).toBe(true);
  });

  it('writes a sample payload (scn-riser-leak, T+14, no fixes) for the Swift models', () => {
    const p = phoneSummary(at(14), T0, deps);
    const dir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'phone-sample.json'), JSON.stringify(p, null, 2) + '\n');
    expect(p.problems.length).toBeGreaterThan(0);
  });
});
