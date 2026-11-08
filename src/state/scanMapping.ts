/**
 * Turns a rig Scan (computed by the bridge from real or simulated frames) into dashboard evidence:
 * a reference Reading on the scanned asset plus, when an open incident covers that asset and metric,
 * a VerificationSession using the same verdict rules as everything else.
 *
 * Protocol v2 points: "Front inlet" → inlet_temp_c (DS18B20); "Fan mount" → vibration_mm_s
 * (ultrasonic displacement, indicative); "Drip tray" → leak.
 */
import { facility } from '../domain/fixture';
import { compareReadings } from '../domain/engine';
import type { Incident, Metric, Reading, VerificationSession } from '../domain/types';
import type { Scan } from '../domain/rig/protocol';
import { latestFor } from './selectors';

export interface ScanEvidence {
  reading: Reading | null;
  session: VerificationSession | null;
  incident: Incident | null;
  summary: string;
}

function metricFor(scan: Scan): { metric: Metric; value: number; unit: string } | null {
  const c = scan.channels;
  if (scan.point.startsWith('Drip') && c.drip_wet) return { metric: 'leak', value: c.drip_wet.mean >= 0.5 ? 1 : 0, unit: 'wet' };
  if (scan.point.startsWith('Front inlet') && c.temp_c) return { metric: 'inlet_temp_c', value: +c.temp_c.mean.toFixed(2), unit: '°C' };
  if (scan.point.startsWith('Fan mount')) {
    // the louder of the two ultrasonic channels stands in for a contact reading on the fan
    const vals = [c.vib_a_mm_s, c.vib_b_mm_s].filter(Boolean) as NonNullable<typeof c.vib_a_mm_s>[];
    if (!vals.length) return null;
    return { metric: 'vibration_mm_s', value: +Math.max(...vals.map((v) => v.mean)).toFixed(2), unit: 'mm/s' };
  }
  return null;
}

export function scanToEvidence(scan: Scan, ctx: { t: number; incidents: Incident[]; readings: Reading[]; sessionCount: number }): ScanEvidence {
  const m = metricFor(scan);
  const where = `${scan.assetId} · ${scan.point}`;
  if (!m) return { reading: null, session: null, incident: null, summary: `Scan ${scan.id} at ${where} recorded (no comparable installed reading)` };

  const reading: Reading = {
    id: `RR-${scan.id}`, assetId: scan.assetId, metric: m.metric, value: m.value, unit: m.unit, t: ctx.t,
    source: 'reference_probe', expectedIntervalMin: 5, probeId: scan.deviceId, point: scan.point,
  };
  const sevRank = { critical: 3, warning: 2, advisory: 1, normal: 0 } as const;
  const incident = ctx.incidents
    .filter((i) => i.status !== 'resolved' && i.openedAt <= ctx.t && (i.rootAssetId === scan.assetId || i.alertAssetIds.includes(scan.assetId)))
    .sort((a, b) => Number(b.rootAssetId === scan.assetId) - Number(a.rootAssetId === scan.assetId) || sevRank[b.severity] - sevRank[a.severity])[0] ?? null;
  const qualityFlags = [...scan.quality, `${scan.source}_rig`, `${scan.frames}_frames`, `${scan.durationS.toFixed(1)}s_hold`];
  if (m.metric === 'vibration_mm_s') qualityFlags.push('ultrasonic_displacement_not_iso');

  let verdict: VerificationSession['verdict'];
  let rationale: string;
  const installed = latestFor(ctx.readings.filter((r) => r.source === 'installed' || r.source === 'simulated'), scan.assetId, m.metric);

  if (m.metric === 'leak') {
    verdict = m.value === 1 ? 'corroborated_abnormal' : 'not_corroborated_in_session';
    rationale = m.value === 1
      ? `Liquid present at ${scan.point} (${Math.round((scan.channels.drip_wet?.mean ?? 0) * 100)} % of ${scan.frames} frames wet).`
      : `Dry at ${scan.point} for ${scan.durationS.toFixed(0)} s. One dry point does not exclude a leak elsewhere; keep the alert.`;
  } else if (installed) {
    const cmp = compareReadings(installed, [reading], { now: ctx.t, thresholds: facility.thresholds });
    verdict = cmp.verdict;
    rationale = cmp.rationale;
    qualityFlags.push(...cmp.qualityFlags);
  } else {
    verdict = 'inconclusive';
    rationale = 'No installed reading to compare against at this point.';
  }
  if ((scan.quality.includes('temp_missing') && m.metric === 'inlet_temp_c') || scan.quality.some((q) => q.startsWith('vib_timeout') && m.metric === 'vibration_mm_s')) {
    verdict = 'inconclusive';
    rationale = `Rig flagged the channel as untrusted during the hold — repeat the scan before trusting it. (${rationale})`;
  }

  const session: VerificationSession | null = incident ? {
    id: `VS-${ctx.sessionCount + 1}`, assetId: scan.assetId, incidentId: incident.id, operatorId: scan.operator, probeId: scan.deviceId, point: scan.point,
    metric: m.metric, installedReadingId: installed?.id ?? 'none', referenceReadingIds: [reading.id], t: ctx.t, qualityFlags, verdict, rationale,
  } : null;

  const val = m.metric === 'leak' ? (m.value ? 'WET' : 'dry') : m.metric === 'vibration_mm_s' ? `${m.value.toFixed(1)} mm/s` : `${m.value.toFixed(1)} °C`;
  return { reading, session, incident, summary: `Scan ${scan.id} (${scan.source === 'live' ? 'live rig' : 'simulated rig'}) at ${where}: ${val}${session ? ` → ${verdict.replace(/_/g, ' ')} on ${incident!.id}` : ''}` };
}
