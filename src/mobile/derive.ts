/**
 * Pure view helpers for the phone dashboard (#/m). No React, no DOM — every number they return
 * is read off engine, store or bridge records; nothing here invents a value.
 */
import type { ImpactClock, Incident, Task, TaskStatus } from '../domain/types';
import type { StampedFrame } from '../domain/rig/protocol';
import { DEFAULT_FLOOR_WET_RAW } from '../domain/rig/scan';

/** Countdown text for a clock at scrub time `now`: "T−12" + "8–19", "LOST", or ">60". */
export function clockText(clock: ImpactClock, now: number, horizon = 60): { main: string; range: string | null; lost: boolean } {
  const rem = (v: number | null) => (v == null ? null : Math.max(0, Math.round(v - now)));
  if (clock.p50 != null && clock.p50 <= now) return { main: 'LOST', range: null, lost: true };
  const mid = rem(clock.p50);
  const lo = rem(clock.p10), hi = rem(clock.p90);
  return {
    main: mid == null ? `>${horizon}` : `T−${mid}`,
    range: mid == null || lo == null ? null : `${lo}–${hi ?? `>${horizon}`}`,
    lost: false,
  };
}

/** Same urgency bands as the desktop strip: ≤10 min critical, ≤30 warning, else advisory. */
export function clockSeverity(clock: ImpactClock, now: number): 'critical' | 'warning' | 'advisory' {
  if (clock.p50 == null) return 'advisory';
  const d = clock.p50 - now;
  return d <= 10 ? 'critical' : d <= 30 ? 'warning' : 'advisory';
}

/** The incident's next clock that hasn't run out yet (falls back to the first), as the desktop queue does. */
export function nextClock(clocks: ImpactClock[], now: number): ImpactClock | undefined {
  return clocks.find((c) => c.p50 == null || c.p50 > now) ?? clocks[0];
}

export type TaskBucket = 'open' | 'field' | 'blocked' | 'review' | 'done';
const BUCKET: Record<TaskStatus, TaskBucket> = {
  unassigned: 'open', reopened: 'open', assigned: 'open', accepted: 'open',
  en_route: 'field', at_asset: 'field', in_progress: 'field',
  blocked: 'blocked', submitted_for_review: 'review', completed: 'done', cancelled: 'done',
};
export const taskBucket = (s: TaskStatus): TaskBucket => BUCKET[s];

export function taskCounts(tasks: Task[]): Record<TaskBucket, number> {
  const out: Record<TaskBucket, number> = { open: 0, field: 0, blocked: 0, review: 0, done: 0 };
  for (const t of tasks) out[BUCKET[t.status]]++;
  return out;
}

/** Active work first (blocked, review, field, open), finished last. Stable within a bucket. */
export function sortTasks(tasks: Task[]): Task[] {
  const order: Record<TaskBucket, number> = { blocked: 0, review: 1, field: 2, open: 3, done: 4 };
  return tasks.map((t, i) => ({ t, i })).sort((a, b) => order[BUCKET[a.t.status]] - order[BUCKET[b.t.status]] || a.i - b.i).map((x) => x.t);
}

export const statusText = (s: TaskStatus) => s.replace(/_/g, ' ');

/** Incidents that are open now, keyed for quick lookup. */
export function openIncidents(incidents: Incident[]): Incident[] {
  return incidents.filter((i) => i.status !== 'resolved');
}

export interface RigTile { key: string; label: string; value: string; unit: string; sub: string; abnormal: boolean; missing: boolean }

/** Live Rack Monitor tiles. Null channels render "—" and say why; wet floor is the only abnormal flag. */
export function rigTiles(f: StampedFrame, floorWetRaw = DEFAULT_FLOOR_WET_RAW): RigTile[] {
  const t = (key: string, label: string, v: number | null, sub: string): RigTile => ({
    key, label, value: v == null ? '—' : v.toFixed(1), unit: '°C', sub, abnormal: false, missing: v == null,
  });
  const wet = f.floor_raw >= floorWetRaw;
  return [
    t('inlet_top', 'Inlet top', f.inlet_top_c, `beam ${Math.round(f.beam_age_s.inlet_top)} s`),
    t('inlet_bottom', 'Inlet bottom', f.inlet_bottom_c, `beam ${Math.round(f.beam_age_s.inlet_bottom)} s`),
    t('outlet', 'Outlet', f.outlet_c, `beam ${Math.round(f.beam_age_s.outlet)} s`),
    t('ref', 'Reference', f.ref_c, f.ref_c == null ? 'not fitted' : 'DS18B20'),
    { key: 'floor', label: 'Floor probe', value: wet ? 'WET' : 'Dry', unit: '', sub: `raw ${f.floor_raw}`, abnormal: wet, missing: false },
    { key: 'pack', label: 'Rack power', value: f.pack_v == null ? '—' : f.pack_v.toFixed(2), unit: f.pack_v == null ? '' : 'V', sub: f.pack_v == null ? 'divider not fitted' : '6×AA pack', abnormal: false, missing: f.pack_v == null },
  ];
}

/** Outlet − mean(inlet top, inlet bottom), only when all three beams report. */
export function deltaT(f: StampedFrame): number | null {
  if (f.outlet_c == null || f.inlet_top_c == null || f.inlet_bottom_c == null) return null;
  return +(f.outlet_c - (f.inlet_top_c + f.inlet_bottom_c) / 2).toFixed(1);
}

/**
 * SVG polyline points for a sparkline. Nulls break the line into separate segments (a gap is
 * shown as a gap, never interpolated). Returns one points string per segment.
 */
export function sparkRange(values: (number | null)[]): { min: number; max: number } | null {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (nums.length < 2) return null;
  let min = Math.min(...nums), max = Math.max(...nums);
  // a flat signal stays flat-looking: never stretch less than 0.5 units across the full height
  if (max - min < 0.5) { const c = (max + min) / 2; min = c - 0.25; max = c + 0.25; }
  return { min, max };
}

export function sparkSegments(values: (number | null)[], w: number, h: number, range?: { min: number; max: number }, pad = 2): { segments: string[]; min: number; max: number } | null {
  const r = range ?? sparkRange(values);
  if (!r) return null;
  const { min, max } = r;
  const step = values.length > 1 ? (w - 2 * pad) / (values.length - 1) : 0;
  const y = (v: number) => +(h - pad - ((v - min) / (max - min)) * (h - 2 * pad)).toFixed(1);
  const segments: string[] = [];
  let cur: string[] = [];
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) { if (cur.length > 1) segments.push(cur.join(' ')); cur = []; return; }
    cur.push(`${+(pad + i * step).toFixed(1)},${y(v)}`);
  });
  if (cur.length > 1) segments.push(cur.join(' '));
  return { segments, min, max };
}

/** "now" / "4 s ago" / "2 min ago" for a frame or plan age in seconds. */
export function ageText(sec: number | null): string {
  if (sec == null) return '—';
  if (sec < 1.5) return 'now';
  if (sec < 90) return `${Math.round(sec)} s ago`;
  return `${Math.round(sec / 60)} min ago`;
}
