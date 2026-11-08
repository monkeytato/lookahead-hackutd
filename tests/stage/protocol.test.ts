import { describe, expect, it } from 'vitest';
import { applyStageCommand, initialStage, MIN_PER_SEC, newer, parseStageCommand, parseStageState, reanchor, stageTime } from '../../src/stage/protocol';
import type { Fix } from '../../src/domain/types';
import { createStageHub, type StagePayload } from '../../server/stageHub';

const H = 60;
const T0 = 1_000_000;
const fix: Fix = { id: 'FIX-isolate_valve-PIPE-L2-120', assetId: 'PIPE-L2', action: 'isolate_valve', label: 'Close the riser isolation valve', orderedAt: 12, effectiveAt: 15 };

describe('stage time', () => {
  it('stands still while paused and advances MIN_PER_SEC × speed while playing', () => {
    const s = initialStage('scn-riser-leak', T0);
    expect(stageTime(s, H, T0 + 10_000)).toBe(0);
    const p = applyStageCommand(s, { type: 'play' }, H, T0);
    expect(p.playing).toBe(true);
    expect(stageTime(p, H, T0 + 2_000)).toBe(2 * MIN_PER_SEC);
    const fast = applyStageCommand(p, { type: 'speed', speed: 4 }, H, T0 + 2_000);
    expect(stageTime(fast, H, T0 + 3_000)).toBe(2 * MIN_PER_SEC + 4 * MIN_PER_SEC);
  });

  it('clamps to the horizon, and play at the end restarts from 0', () => {
    const p = applyStageCommand(initialStage('scn-riser-leak', T0), { type: 'play' }, H, T0);
    expect(stageTime(p, H, T0 + 3_600_000)).toBe(H);
    const again = applyStageCommand(p, { type: 'play' }, H, T0 + 3_600_000);
    expect(again.t0).toBe(0);
  });

  it('pause freezes the current minute; seek and jump clamp', () => {
    const p = applyStageCommand(initialStage('scn-riser-leak', T0), { type: 'play' }, H, T0);
    const paused = applyStageCommand(p, { type: 'pause' }, H, T0 + 4_000);
    expect(paused.playing).toBe(false);
    expect(stageTime(paused, H, T0 + 60_000)).toBe(4 * MIN_PER_SEC);
    expect(applyStageCommand(paused, { type: 'seek', t: 99 }, H, T0).t0).toBe(H);
    expect(applyStageCommand(paused, { type: 'jump', dt: -50 }, H, T0).t0).toBe(0);
    expect(applyStageCommand(paused, { type: 'jump', dt: 5 }, H, T0 + 4_000).t0).toBe(4 * MIN_PER_SEC + 5);
  });
});

describe('stage commands', () => {
  it('pauses with a reason, toggles auto-pause, and keeps auto-pause across a scenario switch', () => {
    const s0 = initialStage('scn-riser-leak', T0);
    expect(s0.autoPause).toBe(true);
    const paused = applyStageCommand(applyStageCommand(s0, { type: 'play' }, H, T0), { type: 'pause', reason: 'New incident: X' }, H, T0 + 1000);
    expect(paused.last).toBe('New incident: X');
    const off = applyStageCommand(paused, { type: 'autopause', on: false }, H, T0);
    expect(off.autoPause).toBe(false);
    expect(applyStageCommand(off, { type: 'scenario', scenarioId: 'rnd-abc' }, H, T0).autoPause).toBe(false);
    expect(parseStageCommand({ type: 'autopause', on: 'yes' })).toBeNull();
    expect(parseStageState({ ...off })?.autoPause).toBe(false);
  });

  it('dedupes a fix by id and cancels it with unfix', () => {
    const s = initialStage('scn-riser-leak', T0);
    const a = applyStageCommand(s, { type: 'fix', fix }, H, T0);
    expect(a.fixes).toHaveLength(1);
    expect(applyStageCommand(a, { type: 'fix', fix }, H, T0)).toBe(a);
    expect(applyStageCommand(a, { type: 'unfix', fixId: fix.id }, H, T0).fixes).toHaveLength(0);
  });

  it('a scenario switch starts a new epoch, keeps speed, clears fixes; reset keeps the scenario', () => {
    let s = applyStageCommand(initialStage('scn-riser-leak', T0), { type: 'speed', speed: 2 }, H, T0);
    s = applyStageCommand(s, { type: 'fix', fix }, H, T0);
    const sw = applyStageCommand(s, { type: 'scenario', scenarioId: 'rnd-abc', autoplay: true }, H, T0);
    expect(sw).toMatchObject({ scenarioId: 'rnd-abc', speed: 2, playing: true, fixes: [], t0: 0 });
    expect(sw.epoch).toBe(sw.rev);
    expect(sw.epoch).not.toBe(s.epoch);
    const rs = applyStageCommand(sw, { type: 'reset' }, H, T0);
    expect(rs).toMatchObject({ scenarioId: 'rnd-abc', speed: 2, playing: false });
    expect(rs.epoch).toBeGreaterThan(sw.epoch);
  });

  it('every command raises rev, and newer() keeps the highest rev (ties: later anchor)', () => {
    const s = initialStage('scn-riser-leak', T0);
    const a = applyStageCommand(s, { type: 'lookahead', min: 20 }, H, T0);
    expect(a.rev).toBe(1);
    expect(a.lookaheadMin).toBe(20);
    expect(newer(a, s)).toBe(a);
    expect(newer(s, a)).toBe(a);
    expect(newer(null, s)).toBe(s);
    const later = { ...a, at: a.at + 5 };
    expect(newer(a, later)).toBe(later);
  });
});

describe('untrusted input', () => {
  it('accepts well-formed commands and drops malformed ones', () => {
    expect(parseStageCommand({ type: 'jump', dt: 5 })).toEqual({ type: 'jump', dt: 5 });
    expect(parseStageCommand({ type: 'focus', assetId: null })).toEqual({ type: 'focus', assetId: null });
    expect(parseStageCommand({ type: 'fix', fix })).toEqual({ type: 'fix', fix });
    expect(parseStageCommand({ type: 'jump', dt: 'x' })).toBeNull();
    expect(parseStageCommand({ type: 'scenario', scenarioId: '<script>' })).toBeNull();
    expect(parseStageCommand({ type: 'fix', fix: { ...fix, action: 'rm -rf' } })).toBeNull();
    expect(parseStageCommand({ type: 'nope' })).toBeNull();
    expect(parseStageCommand(null)).toBeNull();
  });

  it('round-trips a state and clamps speed / lookahead; re-anchors to the receiver clock', () => {
    const s = applyStageCommand(applyStageCommand(initialStage('scn-riser-leak', T0), { type: 'fix', fix }, H, T0), { type: 'play' }, H, T0);
    expect(parseStageState(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(parseStageState({ ...s, speed: 99, lookaheadMin: 500 })).toMatchObject({ speed: 8, lookaheadMin: 60 });
    expect(parseStageState({ ...s, fixes: [{ bad: true }] })).toBeNull();
    // sender's clock is 3 s behind ours: the anchor moves forward by 3 s
    expect(reanchor(s, T0, T0 + 3_000).at).toBe(s.at + 3_000);
  });
});

describe('bridge stage hub', () => {
  it('applies valid commands, persists, broadcasts with the server clock; rejects bad ones', () => {
    const saved: unknown[] = [];
    const sent: StagePayload[] = [];
    let now = T0;
    const hub = createStageHub({ save: (s) => saved.push(s), broadcast: (p) => sent.push(p), screens: () => 3, now: () => now });
    expect(hub.get().scenarioId).toBe('scn-riser-leak');
    const r = hub.command({ type: 'play' });
    expect(r.ok).toBe(true);
    expect(sent.at(-1)).toMatchObject({ now: T0, screens: 3, state: { playing: true, rev: 1 } });
    expect(saved).toHaveLength(1);
    now += 2_000;
    hub.command({ type: 'pause' });
    expect(hub.get().t0).toBe(2 * MIN_PER_SEC);
    expect(hub.command({ type: 'seek', t: 'soon' })).toEqual({ ok: false, error: 'invalid stage command' });
    expect(saved).toHaveLength(2);
  });

  it('restores a persisted state and ignores a corrupt one', () => {
    const persisted = applyStageCommand(initialStage('scn-gen-nostart', T0), { type: 'seek', t: 12 }, H, T0);
    const ok = createStageHub({ initial: persisted, save: () => {}, broadcast: () => {}, screens: () => 0 });
    expect(ok.get()).toMatchObject({ scenarioId: 'scn-gen-nostart', t0: 12 });
    const bad = createStageHub({ initial: { rev: 'x' }, save: () => {}, broadcast: () => {}, screens: () => 0 });
    expect(bad.get().scenarioId).toBe('scn-riser-leak');
  });
});
