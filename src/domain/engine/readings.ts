/** Telemetry helpers: freshness, threshold severity, latest-reading selection. */
import type { Freshness, Metric, Reading, ReadingSource, Severity, Threshold } from '../types';

/** 'missing' if no reading; 'stale' if older than 2× its expected interval; else 'fresh'. */
export function freshness(reading: Reading | undefined, now: number): Freshness {
  if (!reading) return 'missing';
  return now - reading.t > 2 * reading.expectedIntervalMin ? 'stale' : 'fresh';
}

/** Threshold severity, direction aware. A metric without a threshold is 'normal'. */
export function severityFor(metric: Metric, value: number, thresholds: Threshold[]): Severity {
  if (metric === 'leak') return value >= 0.5 ? 'critical' : 'normal';
  const th = thresholds.find((t) => t.metric === metric);
  if (!th) return 'normal';
  if (th.dir === 'above') {
    if (value >= th.alarm) return 'critical';
    if (value >= th.warn) return 'warning';
  } else {
    if (value <= th.alarm) return 'critical';
    if (value <= th.warn) return 'warning';
  }
  return 'normal';
}

export function readingKey(r: Pick<Reading, 'assetId' | 'metric' | 'source'>): string {
  return `${r.assetId}|${r.metric}|${r.source}`;
}

/**
 * Latest reading per `assetId|metric|source` key with `t ≤ now`, optionally restricted to the
 * given sources. Ties on `t` go to the later element in the input.
 */
export function latestReadings(readings: Reading[], now: number, sources?: ReadingSource[]): Reading[] {
  const best = new Map<string, Reading>();
  for (const r of readings) {
    if (r.t > now) continue;
    if (sources && !sources.includes(r.source)) continue;
    const k = readingKey(r);
    const cur = best.get(k);
    if (!cur || r.t >= cur.t) best.set(k, r);
  }
  return [...best.values()];
}

const SEV_RANK: Record<Severity, number> = { normal: 0, advisory: 1, warning: 2, critical: 3 };
export const maxSeverity = (a: Severity, b: Severity): Severity => (SEV_RANK[a] >= SEV_RANK[b] ? a : b);
export const severityRank = (s: Severity) => SEV_RANK[s];
