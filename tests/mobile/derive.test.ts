import { describe, expect, it } from 'vitest';
import type { ImpactClock, Task } from '../../src/domain/types';
import type { StampedFrame } from '../../src/domain/rig/protocol';
import { seedTasks } from '../../src/domain/fixture';
import {
  ageText, clockSeverity, clockText, deltaT, nextClock, rigTiles, sortTasks, sparkRange, sparkSegments, taskBucket, taskCounts,
} from '../../src/mobile/derive';

const clock = (p10: number | null, p50: number | null, p90: number | null): ImpactClock => ({ assetId: 'A-11', p10, p50, p90, probWithinHorizon: 0.5, path: ['CRAH-2', 'A-11'] });

const frame = (over: Partial<StampedFrame> = {}): StampedFrame => ({
  v: 1, dev: 'RACKMON-SIM', fw: 'sim', seq: 1, up_ms: 1000,
  inlet_top_c: 22.4, inlet_bottom_c: 22.6, outlet_c: 31.5,
  echo_us: { inlet_top: 1040, inlet_bottom: 1040, outlet: 1020 },
  beam_age_s: { inlet_top: 1.2, inlet_bottom: 3.6, outlet: 0.4 },
  ref_c: 22.5, reservoir_raw: 400, floor_raw: 3, pack_v: 8.91,
  flap: 'open', valve: 'open', fan_pct: [55, 55], auto: true, flags: [], event: null,
  source: 'simulated', at: '2026-11-07T08:00:00.000Z', ...over,
});

describe('clockText', () => {
  it('shows remaining p50 with the p10–p90 range relative to now', () => {
    expect(clockText(clock(20, 30, 45), 10)).toEqual({ main: 'T−20', range: '10–35', lost: false });
  });
  it('says LOST once p50 has passed, with no range', () => {
    expect(clockText(clock(5, 8, 12), 9)).toEqual({ main: 'LOST', range: null, lost: true });
  });
  it('shows >horizon when the median run never loses the node', () => {
    expect(clockText(clock(40, null, null), 0, 60)).toEqual({ main: '>60', range: null, lost: false });
  });
  it('keeps an open-ended upper bound honest', () => {
    expect(clockText(clock(10, 30, null), 0, 60).range).toBe('10–>60');
  });
});

describe('clockSeverity / nextClock', () => {
  it('matches the desktop strip bands', () => {
    expect(clockSeverity(clock(1, 15, 20), 6)).toBe('critical');
    expect(clockSeverity(clock(1, 35, 40), 6)).toBe('warning');
    expect(clockSeverity(clock(1, 50, 55), 6)).toBe('advisory');
    expect(clockSeverity(clock(1, null, null), 6)).toBe('advisory');
  });
  it('skips clocks that have already run out', () => {
    const a = clock(1, 5, 8), b = clock(10, 20, 30);
    expect(nextClock([a, b], 6)).toBe(b);
    expect(nextClock([a], 6)).toBe(a);
    expect(nextClock([], 6)).toBeUndefined();
  });
});

describe('tasks', () => {
  const tasks = seedTasks();
  it('buckets every status', () => {
    expect(taskBucket('in_progress')).toBe('field');
    expect(taskBucket('submitted_for_review')).toBe('review');
    expect(taskBucket('cancelled')).toBe('done');
    const c = taskCounts(tasks);
    expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe(tasks.length);
  });
  it('puts blocked work first and finished work last, stably', () => {
    const mk = (id: string, status: Task['status']): Task => ({ ...tasks[0], id, status });
    const out = sortTasks([mk('a', 'completed'), mk('b', 'unassigned'), mk('c', 'blocked'), mk('d', 'unassigned'), mk('e', 'en_route')]);
    expect(out.map((x) => x.id)).toEqual(['c', 'e', 'b', 'd', 'a']);
  });
});

describe('rigTiles', () => {
  it('reports frame values as-is and flags only a wet floor', () => {
    const tiles = rigTiles(frame());
    expect(tiles.find((t) => t.key === 'inlet_top')!.value).toBe('22.4');
    expect(tiles.every((t) => !t.abnormal)).toBe(true);
    const wet = rigTiles(frame({ floor_raw: 300 })).find((t) => t.key === 'floor')!;
    expect(wet).toMatchObject({ value: 'WET', abnormal: true });
  });
  it('renders null channels as missing, never zero', () => {
    const tiles = rigTiles(frame({ ref_c: null, outlet_c: null, pack_v: null }));
    for (const k of ['ref', 'outlet', 'pack']) expect(tiles.find((t) => t.key === k)).toMatchObject({ value: '—', missing: true });
    expect(tiles.find((t) => t.key === 'ref')!.sub).toBe('not fitted');
  });
  it('computes ΔT only when all three beams report', () => {
    expect(deltaT(frame())).toBe(9);
    expect(deltaT(frame({ inlet_top_c: null }))).toBeNull();
  });
});

describe('sparkline', () => {
  it('needs two points', () => {
    expect(sparkSegments([1], 100, 20)).toBeNull();
    expect(sparkSegments([null, null], 100, 20)).toBeNull();
  });
  it('breaks the line at gaps instead of interpolating', () => {
    const r = sparkSegments([20, 21, null, 22, 23], 100, 20)!;
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0].split(' ')).toHaveLength(2);
  });
  it('maps min to the bottom and max to the top within padding', () => {
    const r = sparkSegments([10, 20], 100, 20)!;
    expect(r.segments[0]).toBe('2,18 98,2');
  });
  it('uses a shared range when given, and widens a flat signal', () => {
    expect(sparkRange([22, 22, 22])).toEqual({ min: 21.75, max: 22.25 });
    const r = sparkSegments([15, 15], 100, 20, { min: 10, max: 20 })!;
    expect(r.segments[0]).toBe('2,10 98,10');
  });
});

describe('ageText', () => {
  it('formats ages', () => {
    expect(ageText(null)).toBe('—');
    expect(ageText(0.4)).toBe('now');
    expect(ageText(12.4)).toBe('12 s ago');
    expect(ageText(600)).toBe('10 min ago');
  });
});
