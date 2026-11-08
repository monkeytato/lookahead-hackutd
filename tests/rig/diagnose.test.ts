import { describe, expect, it } from 'vitest';
import { DEDUPE_S, diagnose, followUp, timeToLimit } from '../../src/domain/rig/diagnose';
import type { RigEvent, RigEventKind, StampedFrame } from '../../src/domain/rig/protocol';
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
  it.each(SEEDS)('one power_loss alert, no fan symptom events (seed %i)', (seed) => {
    const { events } = once(seed, ['sim power off'], 40);
    expect(kindsOf(events)).toEqual(['power_loss']);
    const e = events[0];
    expect(e).toMatchObject({ confidence: 'high', route: 'it', source: 'simulated', actionConfirmed: null, action: 'automatic fixes unavailable — actuators share the pack' });
    expect(e.evidence[0]).toMatch(/pack_v 8\.\d\d V → 0\.\d\d V/);
    const run = slide(seed, ['sim power off'], 180);
    expect([...run.kinds]).toEqual(['power_loss']);
  });
});

describe('diagnose — recirculation', () => {
  it.each(SEEDS)('auto off + flap open → recirculation, fix not confirmed (seed %i)', (seed) => {
    const { events } = once(seed, ['auto off', 'flap open'], 70);
    expect(kindsOf(events)).toEqual(['recirculation']);
    expect(events[0]).toMatchObject({ confidence: 'high', action: 'close flap', actionConfirmed: null, route: 'it' });
    expect(events[0].evidence.join(' ')).toMatch(/above baseline/);
    expect(events[0].timeToLimitMin).not.toBeNull();
  });

  it.each(SEEDS)('with auto on the firmware closes the flap and the fix is confirmed (seed %i)', (seed) => {
    const run = slide(seed, ['flap open'], 240);
    const rec = run.events.filter((e) => e.kind === 'recirculation');
    expect(rec.length).toBeGreaterThanOrEqual(1);
    // follow-up resolves it from the trailing window
    let confirmed = rec[0].actionConfirmed;
    for (let i = 0; i < 60 && confirmed === null; i++) {
      run.h.run(1);
      const f = followUp(run.h.last(60), rec);
      if (f.length) confirmed = f[0].actionConfirmed;
    }
    expect(confirmed).toBe(true);
    expect(run.kinds.has('cold_supply_loss')).toBe(false);
  });
});

describe('diagnose — fans', () => {
  it.each(SEEDS)('sim fan_a fail → single_fan_failure on fan_a with the surviving fan named (seed %i)', (seed) => {
    const { events } = once(seed, ['sim fan_a fail'], 20);
    expect(kindsOf(events)).toEqual(['single_fan_failure']);
    expect(events[0]).toMatchObject({ channel: 'fan_a', confidence: 'high', route: 'it' });
    expect(events[0].action).toMatch(/fan b/);
    expect(events[0].evidence.join(' ')).toMatch(/one motor stopped drawing current/);
  });

  it.each(SEEDS)('imbalance on fan_b → fan_vibration on fan_b only, trending (seed %i)', (seed) => {
    const run = slide(seed, ['sim imbalance fan_b'], 30);
    const v = run.events.filter((e) => e.kind === 'fan_vibration');
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v.every((e) => e.channel === 'fan_b')).toBe(true);
    expect(v[0].evidence.join(' ')).toMatch(/not an ISO 10816 measurement/);
    expect(run.kinds.has('single_fan_failure')).toBe(false);
  });

  it('a loose mount reaches the alarm zone with time-to-limit 0', () => {
    const { events } = once(7, ['sim bump fan_b'], 20);
    const v = events.find((e) => e.kind === 'fan_vibration')!;
    expect(v).toBeDefined();
    expect(v.severity).toBe('high');
    expect(v.timeToLimitMin).toBe(0);
  });
});

describe('diagnose — water', () => {
  it.each(SEEDS)('valve open with auto on → leak at the rack, firmware fix confirmed by followUp (seed %i)', (seed) => {
    const run = slide(seed, ['valve open'], 60);
    const leak = run.events.filter((e) => e.kind === 'coolant_leak_at_rack');
    expect(leak.length).toBeGreaterThanOrEqual(1);
    expect(leak[0]).toMatchObject({ action: 'close isolation valve', route: 'it', confidence: 'high' });
    let confirmed = leak[0].actionConfirmed;
    for (let i = 0; i < 40 && confirmed === null; i++) {
      run.h.run(1);
      const f = followUp(run.h.last(60), leak);
      if (f.length) confirmed = f[0].actionConfirmed;
    }
    expect(confirmed).toBe(true);
    expect(run.kinds.has('outside_water')).toBe(false);
  });

  it('valve open with auto off → leak at the rack, fix not yet taken', () => {
    const { events } = once(7, ['auto off', 'valve open'], 25);
    expect(kindsOf(events)).toEqual(['coolant_leak_at_rack']);
    expect(events[0].actionConfirmed).toBeNull();
  });

  it('a spill with the valve shut → outside_water routed to facilities', () => {
    const { events } = once(7, ['sim spill'], 15);
    expect(kindsOf(events)).toEqual(['outside_water']);
    expect(events[0].route).toBe('facilities');
  });

  it('a wet tray already explained by a coolant leak is not outside water', () => {
    const h = new Harness(7).run(30).cmd('sim spill').run(15);
    const prev: RigEvent[] = [{ id: 'x', kind: 'coolant_leak_at_rack', at: h.now, confidence: 'high', rootCause: '', action: null, actionConfirmed: null, timeToLimitMin: null, route: 'it', evidence: [], source: 'simulated' }];
    expect(diagnose(h.last(60), prev, h.now)).toEqual([]);
  });
});

describe('diagnose — supply loss and anomalies', () => {
  it.each(SEEDS)('sim supply loss → cold_supply_loss with a time-to-limit (seed %i)', (seed) => {
    const run = slide(seed, ['sim supply loss'], 150);
    const c = run.events.filter((e) => e.kind === 'cold_supply_loss');
    expect(c.length).toBeGreaterThanOrEqual(1);
    expect(c[0].timeToLimitMin).not.toBeNull();
    expect(run.kinds.has('recirculation')).toBe(false);
  });
});

describe('diagnose — bad data and obstructions', () => {
  it('temp_invalid flag → sensor_fault on temp_c, no page', () => {
    const { events } = once(7, ['sim fault temp'], 5);
    expect(kindsOf(events)).toEqual(['sensor_fault']);
    expect(events[0]).toMatchObject({ channel: 'temp_c', route: 'none' });
  });

  it('blocked ultrasonic → obstruction on that fan, and no fan rule on the untrusted channel', () => {
    const { events } = once(7, ['sim block fan_a'], 5);
    expect(kindsOf(events)).toEqual(['obstruction']);
    expect(events[0].channel).toBe('fan_a');
  });

  it('timeout flag → sensor_fault on that channel', () => {
    const h = new Harness(7).run(30);
    const frames: StampedFrame[] = h.last(20).map((f) => ({ ...f, flags: ['fan_b_timeout'] }));
    const events = diagnose(frames, [], h.now);
    expect(kindsOf(events)).toEqual(['sensor_fault']);
    expect(events[0].channel).toBe('fan_b');
  });
});

describe('diagnose — de-duplication and time-to-limit', () => {
  it('does not re-raise an active event within DEDUPE_S, re-raises after', () => {
    const h = new Harness(7).run(30).cmd('sim spill').run(10);
    const first = diagnose(h.last(60), [], h.now);
    expect(kindsOf(first)).toEqual(['outside_water']);
    h.run(10);
    expect(diagnose(h.last(60), first, h.now)).toEqual([]);
    const stale = first.map((e) => ({ ...e, at: iso(Date.parse(h.now) - (DEDUPE_S + 5) * 1000) }));
    expect(kindsOf(diagnose(h.last(60), stale, h.now))).toEqual(['outside_water']);
  });

  it('ids are stable per kind/channel/time', () => {
    const h = new Harness(7).run(30).cmd('sim block fan_a').run(5);
    const a = diagnose(h.last(60), [], h.now);
    const b = diagnose(h.last(60), [], h.now);
    expect(a[0].id).toBe(b[0].id);
    expect(a[0].id).toMatch(/^rig-obstruction-fan_a-\d+$/);
  });

  it('timeToLimit = (T_limit − T_now)/slope, null when not rising, 0 when over', () => {
    expect(timeToLimit(22, 32, 2)).toBe(5);
    expect(timeToLimit(22, 32, 0)).toBeNull();
    expect(timeToLimit(22, 32, -1)).toBeNull();
    expect(timeToLimit(33, 32, 1)).toBe(0);
    expect(timeToLimit(NaN, 32, 1)).toBeNull();
  });
});
