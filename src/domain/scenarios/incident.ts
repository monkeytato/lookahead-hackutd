/**
 * Incident scenarios for the workflow's "Evaluate a response" (audit C2 / S4, PREDICTION-SCIENCE.md
 * §6 Step 6.1). Each demo warning is evaluated in its OWN scenario, built from the injected incident
 * alone — no future scripted faults. Everything not observed enters as a hypothesis with a prior,
 * and "the alarm is real" enters at the evidence posterior P(real), so the portable reading moves the
 * prediction.
 *
 *   sensor    incident-rack-inlet       A-11 inlet 34.2 °C; hypothesis: real local hot spot at A-11
 *   heat      incident-chiller-trip     CH-1 supply alarm; hypotheses: CH-1 really tripped, CH-2 also trips
 *   water     incident-riser-leak       make-up-flow mismatch at T+11; hypothesis: the leak is real
 *   vibration incident-crah-vibration   CRAH-2 at caution; hypothesis: it trips within the horizon
 */
import type { EnsembleHypothesis, EnsembleOption, HotspotSpec } from '../engine/ensemble';
import type { EvsiContext, ScanCandidate } from '../engine/evsi';
import { fixOption } from '../engine/fixes';
import { PRECURSOR_TRIP_PRIOR } from '../engine/observable';
import { facility, seedReadings } from '../fixture';
import type { ID, Scenario } from '../types';

export type IncidentKind = 'sensor' | 'heat' | 'water' | 'vibration';

const base = { kind: 'what-if' as const, horizonMin: 60, faults: [] as { assetId: ID; t: number }[] };
export const incidentScenarios: Scenario[] = [
  { ...base, id: 'incident-rack-inlet', name: 'Rack inlet alarm (A-11)', description: 'One installed inlet sensor reports 34.2 °C; nothing else is observed.', basis: 'Injected demo incident; no scripted future.',
    steps: [{ t: 0, kind: 'alert', assetId: 'A-11', summary: 'Installed inlet sensor 34.2 °C', metric: 'inlet_temp_c', value: 34.2, source: 'installed' }] },
  { ...base, id: 'incident-chiller-trip', name: 'Chiller supply alarm (CH-1)', description: 'CH-1 supply temperature alarm; CH-2 healthy.', basis: 'Injected demo incident; CH-2 tripping too is a prior-weighted hypothesis, not a fact.',
    steps: [{ t: 1, kind: 'alert', assetId: 'CH-1', summary: 'CH-1 supply temperature 30.8 °C', metric: 'supply_temp_c', value: 30.8, source: 'installed' }] },
  { ...base, id: 'incident-riser-leak', name: 'Possible riser leak (PIPE-L2)', description: 'Make-up-flow mismatch of 38 L/min; the leak start is not observed.', basis: 'Injected demo incident; leak rate = the observed mismatch (meter error assumed), start time unknown.',
    leak: { x: 33.2, z: 12.5, ratePerMin: 38, startT: 4 },
    steps: [{ t: 11, kind: 'reading', assetId: 'PIPE-L2', summary: 'Loop make-up water flow mismatch 38 L/min', metric: 'flow_lpm', value: 38, source: 'simulated' }] },
  { ...base, id: 'incident-crah-vibration', name: 'CRAH fan vibration (CRAH-2)', description: 'CRAH-2 fan at 6.8 mm/s (caution); CRAH-4 shares rows C–D.', basis: 'Injected demo incident; a trip within the hour is an assumption-level prior.',
    steps: [{ t: 1, kind: 'alert', assetId: 'CRAH-2', summary: 'CRAH-2 fan vibration 6.8 mm/s', metric: 'vibration_mm_s', value: 6.8, source: 'installed' }] },
];

export interface IncidentModel {
  kind: IncidentKind;
  scenario: Scenario;
  /** evaluation minute ("now") */
  t: number;
  rootAssetId: ID;
  hypotheses: EnsembleHypothesis[];
  hotspot?: HotspotSpec;
  options: EnsembleOption[];
  scanCandidates: ScanCandidate[];
  evsi: EvsiContext;
  leakStartUnknown: boolean;
  /** family id of "the alarm reflects a real condition" */
  realFamily: string;
}

const SCN: Record<IncidentKind, string> = { sensor: 'incident-rack-inlet', heat: 'incident-chiller-trip', water: 'incident-riser-leak', vibration: 'incident-crah-vibration' };
const opt = (o: ReturnType<typeof fixOption>): EnsembleOption => ({ id: `${o.action}:${o.assetId}`, label: o.label, action: o.action, assetId: o.assetId, delayMin: o.delayMin });
const NONE: EnsembleOption = { id: 'none', label: 'No response (monitor only)' };

/** Neighbour baseline for a rack: installed seed inlets of the same row, ±2 slots. */
export function neighbourBaseline(assetId: ID): number {
  const a = facility.assets.find((x) => x.id === assetId);
  if (!a || a.type !== 'rack') return 22.5;
  const slot = Number(a.location.slot);
  const ids = new Set(facility.assets.filter((x) => x.type === 'rack' && x.location.row === a.location.row && x.id !== assetId && Math.abs(Number(x.location.slot) - slot) <= 2).map((x) => x.id));
  const v = seedReadings().filter((r) => ids.has(r.assetId) && r.metric === 'inlet_temp_c' && r.source === 'installed' && r.t < 0).map((r) => r.value);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 22.5;
}

/** The incident model for one demo warning, with P(real) from the evidence posterior. */
export function incidentModel(kind: IncidentKind, pReal: number, installed?: number): IncidentModel {
  const scenario = incidentScenarios.find((s) => s.id === SCN[kind])!;
  const real = (label: string, effect: EnsembleHypothesis['effect']): EnsembleHypothesis => ({ id: 'real', label, p: pReal, basis: 'evidence posterior P(real) (engine, evidence.ts)', basisKind: 'model', effect });
  switch (kind) {
    case 'sensor': {
      const zoneC = neighbourBaseline('A-11');
      const nowC = installed ?? 34.2;
      return {
        kind, scenario, t: 0, rootAssetId: 'A-11', realFamily: 'h:real', leakStartUnknown: false,
        hypotheses: [real('A-11 inlet is really hot (local recirculation / cooling deficit)', { hotspot: true })],
        hotspot: { assetId: 'A-11', nowC, zoneC },
        options: [NONE, opt(fixOption('shed_load', 'A-11')), opt(fixOption('deploy_portable_cooling', 'A-11'))],
        scanCandidates: ['A-11', 'A-10', 'A-12'].map((id) => ({ assetId: id, metric: 'inlet_temp_c' as const, point: `${id} front inlet, reference probe at sensor height` })),
        evsi: { installedC: nowC, baselineC: zoneC, realFamily: 'h:real' },
      };
    }
    case 'heat': {
      const hours = (scenario.horizonMin - 2) / 60;
      const pCh2 = 1 - Math.exp(-3.87e-5 * hours);
      return {
        kind, scenario, t: 2, rootAssetId: 'CH-1', realFamily: 'h:real', leakStartUnknown: false,
        hypotheses: [
          real('CH-1 has really stopped producing chilled water', { faults: [{ assetId: 'CH-1', t: 1 }] }),
          { id: 'ch2', label: 'CH-2 also trips (at T+12)', p: pCh2, basis: `INL/EXT-21-65055 chiller fail-to-run 3.87e-5/h × ${hours.toFixed(2)} h`, basisKind: 'published', effect: { faults: [{ assetId: 'CH-2', t: 12 }] } },
        ],
        options: [NONE, opt(fixOption('restart_chiller', 'CH-1'))],
        scanCandidates: [], // chiller supply water is not measurable by the portable rig
        evsi: { realFamily: 'h:real' },
      };
    }
    case 'water':
      return {
        kind, scenario, t: 12, rootAssetId: 'PIPE-L2', realFamily: 'h:real', leakStartUnknown: true,
        hypotheses: [real('The make-up-flow mismatch is a real leak at PIPE-L2', { leak: true })],
        options: [NONE, opt(fixOption('isolate_valve', 'PIPE-L2')), opt(fixOption('transfer_ups', 'UPS-B'))],
        scanCandidates: [
          { assetId: 'PIPE-L2', metric: 'leak', point: 'Corridor floor below PIPE-L2 (floor water sensor)' },
          ...['UPS-A', 'UPS-B', 'ATS-1', 'BATT-A', 'BATT-B', 'PDU-B1'].map((id) => ({ assetId: id, metric: 'leak' as const, point: `Floor at ${id} footprint (floor water sensor)` })),
          { assetId: 'A-01', metric: 'inlet_temp_c', point: 'A-01 front inlet' },
        ],
        evsi: { realFamily: 'h:real', leakSourceId: 'PIPE-L2' },
      };
    case 'vibration':
      return {
        kind, scenario, t: 1, rootAssetId: 'CRAH-2', realFamily: 'h:trip', leakStartUnknown: false,
        hypotheses: [{ id: 'trip', label: 'CRAH-2 fan trips within the hour', p: pReal * PRECURSOR_TRIP_PRIOR, basis: `P(real) × P(trip within the horizon | caution) = ${PRECURSOR_TRIP_PRIOR} (no P-F interval data; assumption, range 0.005–0.1)`, basisKind: 'assumption', effect: { faults: [{ assetId: 'CRAH-2', t: 30 }] } }],
        options: [NONE, opt(fixOption('swap_crah', 'CRAH-2'))],
        scanCandidates: [], // the rig's vibration channel is a motion switch, not mm/s
        evsi: {},
      };
  }
}
