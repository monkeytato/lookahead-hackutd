/**
 * Scenarios adapted from public post-incident reports. Each is re-staged in our simulated hall
 * DAL-1 with a compressed timeline: the failure pattern follows the report, the equipment,
 * minutes and consequences are the engine's, and every one is labeled simulated.
 */
import type { Incident, Scenario } from '../types';

const inc = (i: Omit<Incident, 'status' | 'shiftLeadId' | 'recentChanges'> & Partial<Pick<Incident, 'recentChanges'>>): Incident => ({
  status: 'open', shiftLeadId: 'emp-priya', recentChanges: [], ...i,
});

export const realScenarios: Scenario[] = [
  {
    id: 'real-london-heatwave-2022',
    kind: 'real',
    name: 'Record heat: chillers fail one by one',
    headline: 'Record outdoor heat: the chillers lose capacity, then trip',
    description: 'Outdoor air is far above the plant\'s design point. CH-1 runs at high head pressure and trips; CH-2 carries the whole load, degrades, and trips 10 minutes later. With no chilled water, the CRAHs and then the racks run out of thermal margin.',
    basis: 'Adapted from the cooling-related outages at Google Cloud (europe-west2, London) and Oracle Cloud (London) during the record UK heatwave of 19 July 2022, as described in the providers\' public incident reports. Adapted to DAL-1, timeline compressed, simulated.',
    horizonMin: 60,
    faults: [{ assetId: 'CH-1', t: 4 }, { assetId: 'CH-2', t: 14 }],
    steps: [
      { t: 0, kind: 'note', assetId: 'CH-1', summary: 'Outdoor air 40 °C — condensers far above design ambient' },
      { t: 2, kind: 'reading', assetId: 'CH-1', summary: 'CH-1 leaving water 10.4 °C and rising (setpoint 7 °C)', metric: 'supply_temp_c', value: 10.4, source: 'installed' },
      { t: 4, kind: 'fault', assetId: 'CH-1', summary: 'CH-1 trips on high condenser pressure' },
      { t: 4, kind: 'alert', assetId: 'CH-1', summary: 'CH-1 tripped — chilled water on CH-2 only', metric: 'supply_temp_c', value: 12.8, source: 'installed' },
      { t: 9, kind: 'reading', assetId: 'CH-2', summary: 'CH-2 leaving water 13.9 °C — running past capacity', metric: 'supply_temp_c', value: 13.9, source: 'installed' },
      { t: 14, kind: 'fault', assetId: 'CH-2', summary: 'CH-2 trips on high condenser pressure' },
      { t: 14, kind: 'alert', assetId: 'CH-2', summary: 'CH-2 tripped — no chilled-water production', metric: 'supply_temp_c', value: 16.2, source: 'installed' },
    ],
    incidents: [
      inc({ id: 'INC-5101', title: 'CH-1 tripped in record heat — running on CH-2 only', rootAssetId: 'CH-1', alertAssetIds: ['CH-1'], severity: 'warning', evidence: 'corroborated_abnormal', openedAt: 4,
        summary: 'High condenser pressure in 40 °C outdoor air. CH-2 now carries the whole load, also above its design ambient.', recentChanges: ['Heat advisory issued for the site'] }),
      inc({ id: 'INC-5102', title: 'CH-2 tripped — no chilled water', rootAssetId: 'CH-2', alertAssetIds: ['CH-1', 'CH-2', 'P-1', 'P-2'], severity: 'critical', evidence: 'corroborated_abnormal', openedAt: 14,
        summary: 'Both chillers are down. The loop and coil thermal mass are now the only buffer before the CRAHs and racks lose cooling.' }),
    ],
  },
  {
    id: 'real-ovh-sbg2-2021',
    kind: 'real',
    name: 'Fire starts in the UPS room',
    headline: 'A UPS catches fire; fire and smoke spread through the electrical rooms',
    description: 'A fire starts at UPS-B. It spreads through the UPS room toward UPS-A, the transfer switch and the battery room, and smoke reaches the corridor and the hall. Suppression stops the front where it is.',
    basis: 'Adapted from the OVHcloud Strasbourg fire of 10 March 2021, which destroyed the SBG2 building; OVHcloud and the investigators reported that it started in a room holding UPS equipment. Fire-spread speed is an assumption. Adapted to DAL-1, timeline compressed, simulated.',
    horizonMin: 60,
    faults: [],
    hazards: [
      { kind: 'fire', originAssetId: 'UPS-B', x: 38.2, z: 8.6, startT: 3, spreadMPerMin: 0.45, maxRadiusM: 14, zoneIds: ['Z-UPS', 'Z-BATT'] },
      { kind: 'smoke', originAssetId: 'UPS-B', x: 38.2, z: 8.6, startT: 3, spreadMPerMin: 1.6, maxRadiusM: 24, zoneIds: ['Z-UPS', 'Z-BATT', 'Z-CORR', 'Z-HALL'] },
    ],
    steps: [
      { t: 3, kind: 'fault', assetId: 'UPS-B', summary: 'Fire starts at UPS-B' },
      { t: 3, kind: 'alert', assetId: 'UPS-B', summary: 'Smoke detection in the UPS room — UPS-B battery cabinet at 58 °C', metric: 'battery_temp_c', value: 58, source: 'installed' },
      { t: 6, kind: 'note', assetId: 'UPS-B', summary: 'UPS-B offline; its PDUs run on the A side only' },
    ],
    incidents: [
      inc({ id: 'INC-5201', title: 'Fire in the UPS room — UPS-B', rootAssetId: 'UPS-B', alertAssetIds: ['UPS-B', 'UPS-A', 'ATS-1', 'BATT-A', 'BATT-B'], severity: 'critical', evidence: 'corroborated_abnormal', openedAt: 3,
        summary: 'Smoke detection and a temperature spike at UPS-B. Everything on the B side is down; UPS-A and the transfer switch share the room.', runbookId: 'RB-BATT' }),
    ],
  },
  {
    id: 'real-azure-syd-2023',
    kind: 'real',
    name: 'Power sag trips the chillers',
    headline: 'A grid voltage dip trips both chillers, and neither restarts on its own',
    description: 'A short utility voltage sag does not drop the IT load, but it trips both chillers. They do not auto-restart, and with a small night crew the manual restart sequence takes too long.',
    basis: 'Adapted from Microsoft\'s post-incident review of the Azure Australia East (Sydney) incident of 30 August 2023: a utility power sag tripped chillers offline, they did not restart automatically, and the staff on site were not enough to restart them manually in time. Adapted to DAL-1, timeline compressed, simulated.',
    horizonMin: 60,
    faults: [{ assetId: 'CH-1', t: 2 }, { assetId: 'CH-2', t: 2 }],
    steps: [
      { t: 2, kind: 'note', assetId: 'UTIL', summary: 'Utility voltage sag — IT load rides through on UPS' },
      { t: 2, kind: 'fault', assetId: 'CH-1', summary: 'CH-1 trips on the voltage sag — no auto-restart' },
      { t: 2, kind: 'fault', assetId: 'CH-2', summary: 'CH-2 trips on the voltage sag — no auto-restart' },
      { t: 3, kind: 'alert', assetId: 'CH-1', summary: 'Both chillers offline — chilled-water supply rising', metric: 'supply_temp_c', value: 11.5, source: 'installed' },
      { t: 8, kind: 'reading', assetId: 'CH-2', summary: 'Chilled-water supply 15.1 °C', metric: 'supply_temp_c', value: 15.1, source: 'installed' },
    ],
    incidents: [
      inc({ id: 'INC-5301', title: 'Both chillers tripped on a power sag — no auto-restart', rootAssetId: 'CH-1', alertAssetIds: ['CH-1', 'CH-2', 'P-1', 'P-2'], severity: 'critical', evidence: 'corroborated_abnormal', openedAt: 2,
        summary: 'The chillers need a manual restart sequence at each unit. Every minute without chilled water spends the loop\'s thermal buffer.', recentChanges: ['Night shift: 5 people on site'] }),
    ],
  },
];
