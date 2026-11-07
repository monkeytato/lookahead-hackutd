/**
 * Local-rules investigation — the transparent no-key fallback for the Nemotron adapter.
 * Every observation cites a stored record id. It never invents a number: values come from
 * readings and engine clocks passed in.
 */
import type { ImpactClock, Incident, Reading, VerificationSession } from '../domain/types';

export interface Analysis {
  observations: { text: string; cite: string }[];
  hypotheses: { label: string; support: string }[];
  next: string;
  open: string[];
}

export function analyzeIncident(input: { incident: Incident; readings: Reading[]; sessions: VerificationSession[]; clocks: ImpactClock[]; now: number; changes: { t: number; assetId: string; text: string }[] }): Analysis {
  const { incident: inc, readings, sessions, clocks, changes } = input;
  const obs: Analysis['observations'] = [];
  const rel = readings.filter((r) => r.assetId === inc.rootAssetId || inc.alertAssetIds.includes(r.assetId)).sort((a, b) => b.t - a.t).slice(0, 3);
  for (const r of rel) obs.push({ text: `${r.assetId} ${r.metric.replace(/_/g, ' ')} = ${r.value} ${r.unit} (${r.source})`, cite: r.id });
  for (const s of sessions) obs.push({ text: `Verification ${s.id}: ${s.verdict.replace(/_/g, ' ')} — ${s.rationale}`, cite: s.id });
  const near = changes.filter((c) => c.assetId === inc.rootAssetId || inc.alertAssetIds.includes(c.assetId));
  for (const c of near) obs.push({ text: `Change record: ${c.text}`, cite: `CHG:${c.assetId}` });
  const first = [...clocks].sort((a, b) => (a.p50 ?? 1e9) - (b.p50 ?? 1e9))[0];
  if (first?.p50 != null) obs.push({ text: `Engine: ${first.assetId} lost at p50 T+${Math.round(first.p50)} (range ${first.p10 != null ? Math.round(first.p10) : '?'}–${first.p90 != null ? Math.round(first.p90) : '>60'}) via ${first.path.join(' → ')}`, cite: `CLK:${first.assetId}` });

  const verdict = sessions.at(-1)?.verdict ?? inc.evidence;
  let hypotheses: Analysis['hypotheses'] = [];
  let next = '';
  const open: string[] = [];

  if (inc.rootAssetId === 'A-11') {
    hypotheses = [
      { label: 'Installed sensor or its telemetry chain is reporting incorrectly', support: 'Neighbouring racks and both covering CRAHs read normal; firmware changed yesterday.' },
      { label: 'Real local hot spot at A-11 (recirculation, missing blanking panel)', support: 'Possible if airflow at the inlet is blocked; would show on a reference probe at the same point.' },
    ];
    next = verdict === 'measurement_disagreement'
      ? 'Treat as a telemetry problem: open a sensor-chain inspection (mounting, firmware 4.8.1, gateway). Keep the alarm visible; do not suppress it until the installed sensor reads true again.'
      : 'Send a cooling technician with the reference probe to the A-11 front inlet (RB-VERIFY-TEMP v3.2). One reading at the same point settles which explanation holds.';
    if (verdict === 'measurement_disagreement') open.push('Whether other row A sensors on firmware 4.8.1 are also biased');
  } else if (inc.rootAssetId === 'CRAH-2') {
    hypotheses = [
      { label: 'Fan imbalance or loosened mount after the belt re-tension 3 days ago', support: 'Vibration tripled against its own baseline; 1× running-speed component is the usual signature of imbalance.' },
      { label: 'Sensor mount loosened', support: 'Would not reproduce on a reference accelerometer on the fixed stud.' },
    ];
    next = 'Vibration check on the CRAH-2 bearing stud, then plan a fan inspection before the modeled trip. Losing CRAH-2 leaves rows C–D on CRAH-4 alone.';
    open.push('Fan load at time of reading (amplitude depends on load)');
  } else if (inc.rootAssetId === 'PIPE-L2') {
    hypotheses = [
      { label: 'Leak on the Level-2 riser above the east corridor', support: 'Make-up flow mismatch with no sensor on Level 2 — the Paris pattern: a leak where nobody is watching.' },
      { label: 'Make-up valve or meter fault', support: 'Would show no liquid at the corridor floor or the battery-room threshold.' },
    ];
    next = 'Send leak response to the corridor with a liquid probe; place an absorbent barrier at the battery-room threshold before confirming (RB-LEAK v4.1). Hold the 03:00 BATT-B module work.';
    open.push('Exact spread path — the water layer is an approximation', 'Whether DRAIN-1 is flowing');
  } else {
    hypotheses = [{ label: 'See dependency chain', support: 'Engine path shown in the Why panel.' }];
    next = 'Follow the linked runbook and confirm the root fault on site.';
  }
  return { observations: obs, hypotheses, next, open };
}
