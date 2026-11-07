import { describe, expect, it } from 'vitest';
import { DEDUPE_S, diagnose, followUp, timeToLimit } from '../../src/domain/rig/diagnose';
import type { RigEvent, RigEventKind } from '../../src/domain/rig/protocol';
import { Harness, iso } from './helpers';

const SEEDS = [1, 7, 42];

/**
 * Realistic driving: baseline, stage the commands, then call diagnose once per second over the
 * trailing 60 s window with everything raised so far as `prev` (what the bridge does).
 */
function slide(seed: number, cmds: string[], seconds: number, baseline = 60) {
  const h = new Harness(seed).run(baseline).cmd(...cmds);
  const events: RigEvent[] = [];
  for (let i = 0; i < seconds; i++) {
    h.run(1);
    events.push(...diagnose(h.last(60), events, h.now));
  }
  return { h, events, kinds: new Set<RigEventKind>(events.map((e) => e.kind)) };
}

/** One diagnose call over the last 60 s after `seconds` of the staged scenario. */
function once(seed: number, cmds: string[], seconds: number, baseline = 30) {
  const h = new Harness(seed).run(baseline).cmd(...cmds).run(seconds);
  return { h, events: diagnose(h.last(60), [], h.now) };
}

const kindsOf = (evs: RigEvent[]) => evs.map((e) => e.kind);

describe('diagnose — quiet rig', () => {
  it.each(SEEDS)('raises nothing over five quiet minutes (seed %i)', (seed) => {
    expect(slide(seed, [], 300).events).toEqual([]);
  });

  it('returns nothing for an empty window', () => {
    expect(diagnose([], [], iso(0))).toEqual([]);
  });
});

describe('diagnose — power loss', () => {
  it.each(SEEDS)('one power_loss alert, no fan/heat symptom events (seed %i)', (seed) => {
    const { events } = once(seed, ['sim power off'], 40);
    expect(kindsOf(events)).toEqual(['power_loss']);
    const e = events[0];
    expect(e).toMatchObject({
      confidence: 'high', route: 'it', source: 'simulated', actionConfirmed: null,
      action: 'automatic fixes unavailable — actuators share the pack',
    });
    expect(e.rootCause).toMatch(/power/i);
    expect(e.evidence[0]).toMatch(/pack_v 8\.\d\d V → 0\.\d\d V/);
    expect(e.evidence.join(' ')).toMatch(/suppressed symptom rules: .*unclassified_anomaly/);

    const run = slide(seed, ['sim power off'], 180);
    expect([...run.kinds]).toEqual(['power_loss']);
  });
});

describe('diagnose — recirculation', () => {
  it.each(SEEDS)('auto off + flap open → recirculation, fix not confirmed (seed %i)', (seed) => {
    const { events } = once(seed, ['auto off', 'flap open'], 45);
    expect(kindsOf(events)).toEqual(['recirculation']);
    const e = events[0];
    expect(e).toMatchObject({ action: 'close flap', actionConfirmed: null, confidence: 'high', route: 'it' });
    expect(e.timeToLimitMin).toBeGreaterThan(0);
    expect(e.evidence.join(' ')).toMatch(/top − bottom up to \d+\.\d\d °C/);

    const run = slide(seed, ['auto off', 'flap open'], 180);
    expect([...run.kinds]).toEqual(['recirculation']);
  });

  it.each(SEEDS)('auto on: firmware closes the flap and the top inlet recovers → confirmed (seed %i)', (seed) => {
    const { events } = once(seed, ['flap open'], 45);
    const e = events.find((x) => x.kind === 'recirculation');
    expect(e).toBeDefined();
    expect(e!.actionConfirmed).toBe(true);
    expect(e!.evidence.join(' ')).toMatch(/flap closed at .* by firmware/);
    expect(kindsOf(events)).toEqual(['recirculation']);
  });

  it('raised while unconfirmed is confirmed later by followUp', () => {
    const run = slide(7, ['flap open'], 60);
    expect([...run.kinds]).toEqual(['recirculation']);
    const raised = run.events[0];
    expect(raised.actionConfirmed).toBeNull();
    const updates = followUp(run.h.last(60), run.events);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ id: raised.id, kind: 'recirculation', actionConfirmed: true });
  });

  it('a manual flap close after an auto-off recirculation is confirmed by followUp', () => {
    const run = slide(1, ['auto off', 'flap open'], 50);
    expect(followUp(run.h.last(60), run.events)).toEqual([]); // flap still open
    run.h.cmd('flap close').run(30);
    const updates = followUp(run.h.last(60), run.events);
    expect(updates.map((u) => u.actionConfirmed)).toEqual([true]);
  });
});

describe('diagnose — water', () => {
  it.each(SEEDS)('valve open with auto on → coolant_leak_at_rack, valve_closed confirmed (seed %i)', (seed) => {
    const { events } = once(seed, ['valve open'], 40);
    expect(kindsOf(events)).toEqual(['coolant_leak_at_rack']);
    expect(events[0]).toMatchObject({ action: 'close isolation valve', actionConfirmed: true, confidence: 'high', route: 'it' });
    expect(events[0].evidence.join(' ')).toMatch(/valve closed at .* by firmware/);

    const run = slide(seed, ['valve open'], 120);
    expect([...run.kinds]).toEqual(['coolant_leak_at_rack']);
    const upd = followUp(run.h.last(60), run.events.filter((e) => e.actionConfirmed === null));
    expect(upd.every((u) => u.actionConfirmed === true)).toBe(true);
  });

  it('valve open with auto off → leak at the rack, fix not yet taken', () => {
    const { events } = once(3, ['auto off', 'valve open'], 20);
    expect(kindsOf(events)).toEqual(['coolant_leak_at_rack']);
    expect(events[0].actionConfirmed).toBeNull();
    expect(events[0].timeToLimitMin).toBeGreaterThan(0); // minutes to an empty reservoir
  });

  it.each(SEEDS)('reservoir dropping with a dry tray → leak_elsewhere, lower severity (seed %i)', (seed) => {
    const run = slide(seed, ['sim leak remote'], 120);
    expect([...run.kinds]).toEqual(['leak_elsewhere']);
    expect(run.events[0]).toMatchObject({ severity: 'low', actionConfirmed: null });
    expect(run.events[0].evidence.join(' ')).toMatch(/dropping for \d+ s/);
  });

  it.each(SEEDS)('wet floor with a steady reservoir → outside_water routed to facilities (seed %i)', (seed) => {
    const run = slide(seed, ['sim spill'], 120);
    expect([...run.kinds]).toEqual(['outside_water']);
    expect(run.events[0].route).toBe('facilities');
  });

  it('a wet tray already explained by a coolant leak is not outside water', () => {
    const run = slide(1, ['valve open'], 150);
    const later = diagnose(run.h.last(60), [], run.h.now);
    expect(kindsOf(later)).toEqual(['outside_water']); // without history it looks like outside water…
    expect(diagnose(run.h.last(60), run.events.slice(0, 1), run.h.now)).toEqual([]); // …but not with it
  });
});

describe('diagnose — airflow and heat', () => {
  it.each(SEEDS)('fan_a fail → single_fan_failure (medium, by elimination), no heat spike (seed %i)', (seed) => {
    const run = slide(seed, ['sim fan_a fail'], 180);
    expect([...run.kinds]).toEqual(['single_fan_failure']);
    const e = run.events[0];
    expect(e.confidence).toBe('medium');
    expect(e.rootCause).toMatch(/elimination/);
    expect(e.rootCause).toMatch(/can't say which fan/);
    expect(e.action).toMatch(/ramp surviving fan to max/);
    expect(e.timeToLimitMin).toBeGreaterThan(0);
  });

  it.each(SEEDS)('sim heat high → heat_load_spike with a time-to-limit countdown (seed %i)', (seed) => {
    const run = slide(seed, ['sim heat high'], 180);
    expect([...run.kinds]).toEqual(['heat_load_spike']);
    const e = run.events[0];
    expect(e.timeToLimitMin).not.toBeNull();
    expect(e.timeToLimitMin!).toBeGreaterThan(0);
    expect(e.evidence.join(' ')).toMatch(/delta_t .* °C\/min/);
  });

  it.each(SEEDS)('both inlets rising together → cold_supply_loss paged to IT (seed %i)', (seed) => {
    const run = slide(seed, ['sim supply loss'], 240);
    expect([...run.kinds]).toEqual(['cold_supply_loss']);
    const e = run.events[0];
    expect(e.route).toBe('it');
    expect(e.timeToLimitMin).toBeGreaterThan(0);
    expect(e.evidence.join(' ')).toMatch(/32 °C/);
  });

  it('fans commanded off is outside the rule set → unclassified_anomaly', () => {
    const run = slide(1, ['fan 0 0'], 90);
    expect([...run.kinds]).toEqual(['unclassified_anomaly']);
    expect(run.events[0].confidence).toBe('low');
    expect(run.events[0].evidence.join(' ')).toMatch(/fan commands changed/);
  });
});

describe('diagnose — bad data and obstructions', () => {
  it.each(SEEDS)('sim fault inlet_top → sensor_fault routed none, channel untrusted, no recirculation (seed %i)', (seed) => {
    const { events } = once(seed, ['sim fault inlet_top'], 30);
    expect(kindsOf(events)).toEqual(['sensor_fault']);
    expect(events[0]).toMatchObject({ route: 'none', channel: 'inlet_top_c', action: 'mark inlet_top_c untrusted; no page' });
    expect(events[0].evidence.join(' ')).toMatch(/inlet_top_c 2\d\.\d\d °C vs ref_c 2\d\.\d\d °C/);

    const run = slide(seed, ['sim fault inlet_top'], 120);
    expect([...run.kinds]).toEqual(['sensor_fault']);
  });

  it('echo timeout flag → sensor_fault on that channel', () => {
    const h = new Harness(2).run(30);
    const frames = h.last(30).map((f, i) => (i > 20 ? { ...f, outlet_c: null, flags: ['outlet_timeout'] } : f));
    const evs = diagnose(frames, [], h.now);
    expect(evs.map((e) => [e.kind, e.channel, e.route])).toEqual([['sensor_fault', 'outlet_c', 'none']]);
  });

  it.each(SEEDS)('blocked outlet → obstruction flagged on outlet_c (seed %i)', (seed) => {
    const run = slide(seed, ['sim block outlet'], 60);
    expect([...run.kinds]).toEqual(['obstruction']);
    expect(run.events[0]).toMatchObject({ channel: 'outlet_c', action: 'flag blocked aisle', confidence: 'high' });
    expect(run.events[0].evidence.join(' ')).toMatch(/frames flagged outlet_obstructed/);
    // once the outlet beam has had its turn, the impossible echo itself is evidence too
    const later = once(seed, ['sim block outlet'], 10).events;
    expect(kindsOf(later)).toEqual(['obstruction']);
    expect(later[0].evidence.join(' ')).toMatch(/echo \d+\.\d\d µs < 900 µs/);
  });
});

describe('diagnose — de-duplication and time-to-limit', () => {
  it('does not re-raise an active event within DEDUPE_S, re-raises after', () => {
    const { h, events } = once(1, ['sim power off'], 40);
    expect(events).toHaveLength(1);
    const t = Date.parse(h.now);
    expect(diagnose(h.last(60), events, iso(t + 1000))).toEqual([]);
    expect(diagnose(h.last(60), events, iso(t + DEDUPE_S * 1000 - 1000))).toEqual([]);
    expect(kindsOf(diagnose(h.last(60), events, iso(t + (DEDUPE_S + 1) * 1000)))).toEqual(['power_loss']);
    expect(diagnose(h.last(60), events, iso(t + 120_000), { dedupeS: 300 })).toEqual([]);
  });

  it('ids are stable per kind/channel/time', () => {
    const a = once(1, ['sim block outlet'], 10).events[0];
    expect(a.id).toBe(`rig-obstruction-outlet_c-${Date.parse(a.at)}`);
  });

  it('timeToLimit = (T_limit − T_now)/slope, null when not rising, 0 when over', () => {
    expect(timeToLimit(30, 32, 0.5)).toBe(4);
    expect(timeToLimit(30, 32, 0)).toBeNull();
    expect(timeToLimit(30, 32, -1)).toBeNull();
    expect(timeToLimit(33, 32, 1)).toBe(0);
  });
});
