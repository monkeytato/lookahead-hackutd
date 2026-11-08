/**
 * Seeded, clearly-simulated facility: "DAL-1 / Hall A".
 * Everything here is fictional demonstration data. Delay ranges carry their basis so the
 * Why panel can show what each clock rests on.
 */
import type {
  Asset, DependencyEdge, Employee, Facility, Incident, Reading, Scenario, Service,
  Task, Threshold, WalkEdge, Waypoint, Zone,
} from './types';

export const SCENARIO_WALL_START = { h: 2, m: 10 }; // scenario minute 0 == 02:10 local, night shift

// ------------------------------------------------------------------ zones
export const zones: Zone[] = [
  { id: 'Z-MECH', name: 'Mechanical plant', floor: 1, kind: 'mechanical', rect: { x: 0, z: 0, w: 8, d: 24 }, elevation: 0 },
  { id: 'Z-HALL', name: 'Data Hall A', floor: 1, kind: 'hall', rect: { x: 8, z: 0, w: 24, d: 24 }, elevation: 0.02 },
  { id: 'Z-CORR', name: 'East corridor', floor: 1, kind: 'corridor', rect: { x: 32, z: 0, w: 2, d: 24 }, elevation: 0 },
  { id: 'Z-UPS', name: 'UPS room', floor: 1, kind: 'ups', rect: { x: 34, z: 0, w: 10, d: 12 }, elevation: -0.03 },
  { id: 'Z-BATT', name: 'Battery room', floor: 1, kind: 'battery', rect: { x: 34, z: 12, w: 10, d: 12 }, elevation: -0.05 },
  { id: 'Z-YARD', name: 'Electrical yard', floor: 1, kind: 'electrical', rect: { x: 34, z: -7, w: 10, d: 7 }, elevation: 0 },
];

// ----------------------------------------------------------------- racks
export const ROWS = ['A', 'B', 'C', 'D'] as const;
const ROW_Z: Record<string, number> = { A: 4.6, B: 8.4, C: 14.6, D: 18.4 };
const RACKS_PER_ROW = 12;
const RACK_W = 0.62;
const RACK_X0 = 20 - ((RACKS_PER_ROW - 1) * RACK_W) / 2;
export const rackX = (i: number) => RACK_X0 + i * RACK_W;
const pad = (n: number) => String(n).padStart(2, '0');

/** Rows A/C face south, B/D face north, so A|B and C|D share a cold aisle. */
const rackFacing: Record<string, 'north' | 'south'> = { A: 'south', B: 'north', C: 'south', D: 'north' };
export const GPU_RACKS = ['D-09', 'D-10', 'D-11', 'D-12'];

const racks: Asset[] = ROWS.flatMap((row) =>
  Array.from({ length: RACKS_PER_ROW }, (_, i) => {
    const id = `${row}-${pad(i + 1)}`;
    const gpu = GPU_RACKS.includes(id);
    const aisle = row === 'A' || row === 'B' ? 'N' : 'S';
    return {
      id,
      name: `Rack ${id}`,
      type: 'rack' as const,
      zoneId: 'Z-HALL',
      pos: { x: rackX(i), z: ROW_Z[row] },
      size: { w: 0.6, d: 1.2, h: 2.2 },
      rot: rackFacing[row] === 'south' ? 0 : Math.PI,
      location: { row, slot: pad(i + 1), serviceSide: 'front' as const },
      accessWaypoint: `${aisle}-${pad(i + 1)}`,
      ratedKw: gpu ? 40 : 12,
      loadKw: gpu ? 31 : 6 + ((i * 7 + row.charCodeAt(0)) % 5),
      services: [],
      installedYear: 2022,
    };
  }),
);

// ------------------------------------------------------------- equipment
const eq = (a: Omit<Asset, 'location'> & { location?: Asset['location'] }): Asset => ({ location: {}, ...a });

const equipment: Asset[] = [
  eq({ id: 'UTIL', name: 'Utility feed 13.2 kV', type: 'utility', zoneId: 'Z-YARD', pos: { x: 42, z: -5 }, size: { w: 1.6, d: 1.2, h: 2.4 }, accessWaypoint: 'Y-1' }),
  eq({ id: 'GEN-1', name: 'Generator 1 (2 MW diesel)', type: 'generator', zoneId: 'Z-YARD', pos: { x: 38, z: -4.2 }, size: { w: 4.5, d: 1.8, h: 2.3 }, accessWaypoint: 'Y-1', installedYear: 2019, serviceLifeYears: 25 }),
  eq({ id: 'ATS-1', name: 'Automatic transfer switch 1', type: 'ats', zoneId: 'Z-UPS', pos: { x: 35.4, z: 1.6 }, size: { w: 1.2, d: 0.8, h: 2.2 }, accessWaypoint: 'U-1', installedYear: 2019 }),
  eq({ id: 'UPS-A', name: 'UPS A (500 kVA)', type: 'ups', zoneId: 'Z-UPS', pos: { x: 38.2, z: 3.2 }, size: { w: 3.2, d: 1.0, h: 2.0 }, accessWaypoint: 'U-1', installedYear: 2021, ratedKw: 450, loadKw: 238 }),
  eq({ id: 'UPS-B', name: 'UPS B (500 kVA)', type: 'ups', zoneId: 'Z-UPS', pos: { x: 38.2, z: 8.6 }, size: { w: 3.2, d: 1.0, h: 2.0 }, accessWaypoint: 'U-2', installedYear: 2021, ratedKw: 450, loadKw: 231 }),
  eq({ id: 'BATT-A', name: 'Li-ion string A', type: 'battery', zoneId: 'Z-BATT', pos: { x: 38.5, z: 15.2 }, size: { w: 5, d: 0.8, h: 2.0 }, accessWaypoint: 'B-1', installedYear: 2021, serviceLifeYears: 10 }),
  eq({ id: 'BATT-B', name: 'Li-ion string B', type: 'battery', zoneId: 'Z-BATT', pos: { x: 38.5, z: 20.4 }, size: { w: 5, d: 0.8, h: 2.0 }, accessWaypoint: 'B-2', installedYear: 2015, serviceLifeYears: 10 }),
  eq({ id: 'PDU-A1', name: 'PDU A1 (rows A–B, side A)', type: 'pdu', zoneId: 'Z-HALL', pos: { x: 30.6, z: 2.2 }, size: { w: 0.8, d: 0.8, h: 1.9 }, accessWaypoint: 'H-NE' }),
  eq({ id: 'PDU-B1', name: 'PDU B1 (rows A–B, side B)', type: 'pdu', zoneId: 'Z-HALL', pos: { x: 30.6, z: 10.4 }, size: { w: 0.8, d: 0.8, h: 1.9 }, accessWaypoint: 'H-E' }),
  eq({ id: 'PDU-A2', name: 'PDU A2 (rows C–D, side A)', type: 'pdu', zoneId: 'Z-HALL', pos: { x: 30.6, z: 12.8 }, size: { w: 0.8, d: 0.8, h: 1.9 }, accessWaypoint: 'H-E' }),
  eq({ id: 'PDU-B2', name: 'PDU B2 (rows C–D, side B)', type: 'pdu', zoneId: 'Z-HALL', pos: { x: 30.6, z: 21.8 }, size: { w: 0.8, d: 0.8, h: 1.9 }, accessWaypoint: 'H-SE' }),
  eq({ id: 'CH-1', name: 'Chiller 1', type: 'chiller', zoneId: 'Z-MECH', pos: { x: 3.4, z: 4 }, size: { w: 4, d: 2.2, h: 2.2 }, accessWaypoint: 'M-N', installedYear: 2019 }),
  eq({ id: 'CH-2', name: 'Chiller 2', type: 'chiller', zoneId: 'Z-MECH', pos: { x: 3.4, z: 20 }, size: { w: 4, d: 2.2, h: 2.2 }, accessWaypoint: 'M-S', installedYear: 2019 }),
  eq({ id: 'P-1', name: 'Chilled-water pump 1', type: 'pump', zoneId: 'Z-MECH', pos: { x: 3, z: 9.4 }, size: { w: 1.2, d: 0.8, h: 1.0 }, accessWaypoint: 'M-1' }),
  eq({ id: 'P-2', name: 'Chilled-water pump 2', type: 'pump', zoneId: 'Z-MECH', pos: { x: 3, z: 14.6 }, size: { w: 1.2, d: 0.8, h: 1.0 }, accessWaypoint: 'M-1' }),
  eq({ id: 'CDU-1', name: 'Coolant distribution unit 1', type: 'cdu', zoneId: 'Z-HALL', pos: { x: 27.6, z: 21.6 }, size: { w: 1.2, d: 1.0, h: 2.0 }, accessWaypoint: 'H-SE' }),
  eq({ id: 'CRAH-1', name: 'CRAH 1 (west, north)', type: 'crah', zoneId: 'Z-HALL', pos: { x: 9.2, z: 6.5 }, size: { w: 1.0, d: 2.6, h: 2.0 }, accessWaypoint: 'N-W', location: { serviceSide: 'right' } }),
  eq({ id: 'CRAH-2', name: 'CRAH 2 (west, south)', type: 'crah', zoneId: 'Z-HALL', pos: { x: 9.2, z: 16.5 }, size: { w: 1.0, d: 2.6, h: 2.0 }, accessWaypoint: 'S-W', location: { serviceSide: 'right' } }),
  eq({ id: 'CRAH-3', name: 'CRAH 3 (east, north)', type: 'crah', zoneId: 'Z-HALL', pos: { x: 29.2, z: 6.5 }, size: { w: 1.0, d: 2.6, h: 2.0 }, accessWaypoint: 'N-E', location: { serviceSide: 'left' } }),
  eq({ id: 'CRAH-4', name: 'CRAH 4 (east, south)', type: 'crah', zoneId: 'Z-HALL', pos: { x: 29.2, z: 16.5 }, size: { w: 1.0, d: 2.6, h: 2.0 }, accessWaypoint: 'S-E', location: { serviceSide: 'left' } }),
  eq({ id: 'PIPE-L2', name: 'Level-2 chilled-water riser (above corridor)', type: 'pipe', zoneId: 'Z-CORR', pos: { x: 33, z: 12.5 }, size: { w: 0.3, d: 6, h: 0.3 }, accessWaypoint: 'C-2' }),
  eq({ id: 'DRAIN-1', name: 'Corridor floor drain', type: 'drain', zoneId: 'Z-CORR', pos: { x: 33, z: 22.5 }, size: { w: 0.4, d: 0.4, h: 0.05 }, accessWaypoint: 'C-4' }),
];

// --------------------------------------------------------------- services
export const services: Service[] = [
  { id: 'svc-payments', name: 'Payments API', criticality: 5, replicas: ['A-03', 'C-03'] },
  { id: 'svc-storage', name: 'Object storage', criticality: 5, replicas: ['A-10', 'B-10'] },
  { id: 'svc-search', name: 'Search', criticality: 4, replicas: ['B-05', 'D-05'] },
  { id: 'svc-ml', name: 'ML training', criticality: 2, replicas: GPU_RACKS },
  { id: 'svc-tools', name: 'Internal tools', criticality: 1, replicas: ['B-07'] },
];
for (const s of services) for (const r of s.replicas) racks.find((a) => a.id === r)!.services!.push(s.id);

export const assets: Asset[] = [...equipment, ...racks];

// ----------------------------------------------------------- dependencies
let eid = 0;
const e = (from: string, to: string, kind: DependencyEdge['kind'], delay: [number, number, number], basis: string, basisKind: DependencyEdge['basisKind'], redundancyGroup?: string): DependencyEdge => ({
  id: `E-${++eid}`, from, to, kind, delay: { min: delay[0], mode: delay[1], max: delay[2] }, basis, basisKind, redundancyGroup, confirmed: true, revision: 1,
});

const AUTONOMY = 'UPS autonomy at current load (~240 kW of 450 kW) — vendor curve, assumption until battery test';
const THERMAL = 'Thermal ride-through from rack kW and room air volume; Opengate 2007 saw shutdown in 3 min at 5 kW/cab — lumped model, assumption';
const edges: DependencyEdge[] = [
  // power chain
  e('UTIL', 'ATS-1', 'powers', [0, 0, 0], 'Direct feed', 'rating', 'ats-src'),
  e('GEN-1', 'ATS-1', 'powers', [0, 0.2, 0.5], 'Generator start + transfer ~10–30 s (rating)', 'rating', 'ats-src'),
  e('ATS-1', 'BATT-A', 'powers', [8, 12, 18], AUTONOMY, 'assumption'),
  e('ATS-1', 'BATT-B', 'powers', [6, 10, 15], AUTONOMY + '; string B is 11 years old', 'assumption'),
  e('ATS-1', 'UPS-A', 'powers', [0, 0, 0], 'Normal path', 'rating', 'upsA-src'),
  e('BATT-A', 'UPS-A', 'powers', [0, 0, 0], 'Battery ride-through path', 'rating', 'upsA-src'),
  e('ATS-1', 'UPS-B', 'powers', [0, 0, 0], 'Normal path', 'rating', 'upsB-src'),
  e('BATT-B', 'UPS-B', 'powers', [0, 0, 0], 'Battery ride-through path', 'rating', 'upsB-src'),
  e('UPS-A', 'PDU-A1', 'powers', [0, 0, 0], 'Direct', 'rating'),
  e('UPS-A', 'PDU-A2', 'powers', [0, 0, 0], 'Direct', 'rating'),
  e('UPS-B', 'PDU-B1', 'powers', [0, 0, 0], 'Direct', 'rating'),
  e('UPS-B', 'PDU-B2', 'powers', [0, 0, 0], 'Direct', 'rating'),
  // mechanical load is generator-backed, not UPS-backed …
  ...['CH-1', 'CH-2', 'P-1', 'P-2', 'CRAH-1', 'CRAH-2', 'CRAH-3', 'CRAH-4'].map((m) =>
    e('ATS-1', m, 'powers', [0, 0, 0], 'Mechanical load on generator-backed bus (no UPS)', 'rating')),
  // … except the CDU: cold plates have seconds-to-minutes of margin, so liquid-cooling CDU pumps are
  // normally on UPS (A and B feeds). It still depends on chilled water from P-1/P-2 below.
  e('UPS-A', 'CDU-1', 'powers', [0, 0, 0], 'CDU pumps on UPS, side A (common practice for direct liquid cooling — assumption)', 'assumption', 'cdu-pwr'),
  e('UPS-B', 'CDU-1', 'powers', [0, 0, 0], 'CDU pumps on UPS, side B (common practice for direct liquid cooling — assumption)', 'assumption', 'cdu-pwr'),
  // chilled water
  ...['P-1', 'P-2'].flatMap((p) => ['CH-1', 'CH-2'].map((c) =>
    e(c, p, 'cools', [8, 15, 25], 'Chilled-water loop thermal mass — assumption', 'assumption', `chw-${p}`))),
  ...['CRAH-1', 'CRAH-2', 'CRAH-3', 'CRAH-4', 'CDU-1'].flatMap((u) => ['P-1', 'P-2'].map((p) =>
    e(p, u, 'cools', [5, 10, 20], 'Coil thermal mass after flow loss — assumption', 'assumption', `pump-${u}`))),
];
// racks: dual-corded power, paired CRAH cooling
for (const r of racks) {
  const north = r.location.row === 'A' || r.location.row === 'B';
  const [pa, pb] = north ? ['PDU-A1', 'PDU-B1'] : ['PDU-A2', 'PDU-B2'];
  if (r.id === 'B-07') {
    // single-corded: a rack power-path audit finding
    edges.push(e(pa, r.id, 'powers', [0, 0, 0], 'SINGLE-CORDED — only side A connected (audit 2026-10-02)', 'rating'));
  } else {
    edges.push(e(pa, r.id, 'powers', [0, 0, 0], 'Dual-corded side A', 'rating', `pwr-${r.id}`));
    edges.push(e(pb, r.id, 'powers', [0, 0, 0], 'Dual-corded side B', 'rating', `pwr-${r.id}`));
  }
  if (GPU_RACKS.includes(r.id)) {
    edges.push(e('CDU-1', r.id, 'cools', [1, 2, 4], 'Direct liquid cooling — cold-plate loop has seconds-to-minutes margin (assumption)', 'assumption'));
  } else {
    const [c1, c2] = north ? ['CRAH-1', 'CRAH-3'] : ['CRAH-2', 'CRAH-4'];
    edges.push(e(c1, r.id, 'cools', [3, 6, 10], THERMAL, 'assumption', `cool-${r.id}`));
    edges.push(e(c2, r.id, 'cools', [3, 6, 10], THERMAL, 'assumption', `cool-${r.id}`));
  }
}
// shared-fate: a documented-but-unconfirmed candidate (dependency discovery workflow)
edges.push({ ...e('PIPE-L2', 'BATT-B', 'shares_space', [20, 45, 90], 'As-built note: "riser above corridor drains toward battery room threshold" — candidate, not confirmed', 'assumption'), confirmed: false });

// ---------------------------------------------------------------- walking
const wp = (id: string, x: number, z: number, zoneId: string, label?: string): Waypoint => ({ id, x, z, zoneId, label });
const waypoints: Waypoint[] = [
  wp('C-0', 33, 0.8, 'Z-CORR', 'Corridor north'),
  wp('C-1', 33, 6, 'Z-CORR', 'Corridor by UPS door'),
  wp('C-2', 33, 11.5, 'Z-CORR', 'Corridor / hall door'),
  wp('C-3', 33, 18, 'Z-CORR', 'Corridor by battery door'),
  wp('C-4', 33, 22.8, 'Z-CORR', 'Ops room door'),
  wp('U-1', 36.5, 5.8, 'Z-UPS', 'UPS room, UPS-A front'),
  wp('U-2', 39.5, 10.6, 'Z-UPS', 'UPS room, UPS-B front'),
  wp('B-1', 37, 17.4, 'Z-BATT', 'Battery room, string A'),
  wp('B-2', 37, 22.6, 'Z-BATT', 'Battery room, string B'),
  wp('Y-1', 38, -1.8, 'Z-YARD', 'Yard, generator pad'),
  wp('H-W', 11, 11.5, 'Z-HALL', 'Main aisle west'),
  wp('H-E', 29.4, 11.5, 'Z-HALL', 'Main aisle east'),
  wp('H-NE', 29.4, 2.2, 'Z-HALL', 'Hall NE corner'),
  wp('H-SE', 29.4, 22, 'Z-HALL', 'Hall SE corner'),
  wp('N-W', 10.8, 6.5, 'Z-HALL', 'North cold aisle, west end'),
  wp('N-E', 28.4, 6.5, 'Z-HALL', 'North cold aisle, east end'),
  wp('S-W', 10.8, 16.5, 'Z-HALL', 'South cold aisle, west end'),
  wp('S-E', 28.4, 16.5, 'Z-HALL', 'South cold aisle, east end'),
  wp('M-1', 6.4, 11.5, 'Z-MECH', 'Plant room, pump skid'),
  wp('M-N', 6.4, 4, 'Z-MECH', 'Plant room, chiller 1'),
  wp('M-S', 6.4, 20, 'Z-MECH', 'Plant room, chiller 2'),
  ...Array.from({ length: RACKS_PER_ROW }, (_, i) => wp(`N-${pad(i + 1)}`, rackX(i), 6.5, 'Z-HALL', `North cold aisle, slot ${pad(i + 1)}`)),
  ...Array.from({ length: RACKS_PER_ROW }, (_, i) => wp(`S-${pad(i + 1)}`, rackX(i), 16.5, 'Z-HALL', `South cold aisle, slot ${pad(i + 1)}`)),
];
let wid = 0;
const we = (a: string, b: string, extra: Partial<WalkEdge> = {}): WalkEdge => ({ id: `W-${++wid}`, a, b, ...extra });
const walkEdges: WalkEdge[] = [
  we('C-0', 'C-1'), we('C-1', 'C-2'), we('C-2', 'C-3'), we('C-3', 'C-4'),
  we('C-0', 'Y-1', { note: 'Yard door, badge' }),
  we('C-1', 'U-1', { restrictedTo: 'electrical', note: 'UPS room — electrical-qualified only' }),
  we('U-1', 'U-2'),
  we('C-3', 'B-1', { restrictedTo: 'battery', note: 'Battery room — battery-qualified only' }),
  we('B-1', 'B-2'),
  we('C-2', 'H-E', { note: 'Hall east door' }),
  we('H-E', 'H-NE'), we('H-E', 'H-SE'), we('H-E', 'H-W'),
  we('H-W', 'N-W'), we('H-W', 'S-W'), we('H-E', 'N-E'), we('H-E', 'S-E'), we('H-NE', 'N-E'), we('H-SE', 'S-E'),
  we('H-W', 'M-1', { note: 'Plant room door' }), we('M-1', 'M-N'), we('M-1', 'M-S'),
  we('N-W', 'N-01'), we(`N-${pad(RACKS_PER_ROW)}`, 'N-E'),
  we('S-W', 'S-01'), we(`S-${pad(RACKS_PER_ROW)}`, 'S-E'),
  ...Array.from({ length: RACKS_PER_ROW - 1 }, (_, i) => we(`N-${pad(i + 1)}`, `N-${pad(i + 2)}`)),
  ...Array.from({ length: RACKS_PER_ROW - 1 }, (_, i) => we(`S-${pad(i + 1)}`, `S-${pad(i + 2)}`)),
];

// -------------------------------------------------------------- thresholds
export const thresholds: Threshold[] = [
  { metric: 'inlet_temp_c', warn: 27, alarm: 32, dir: 'above', basis: 'ASHRAE A1: recommended 18–27 °C, allowable 15–32 °C' },
  { metric: 'humidity_rh', warn: 60, alarm: 80, dir: 'above', basis: 'ASHRAE A1 allowable 8–80 % RH' },
  { metric: 'dew_point_c', warn: 15, alarm: 17, dir: 'above', basis: 'ASHRAE A1 dew point ≤ 17 °C' },
  { metric: 'vibration_mm_s', warn: 2.8, alarm: 7.1, dir: 'above', basis: 'ISO 10816-1 class II (15–75 kW): zone C ≥ 2.8, zone D ≥ 7.1 mm/s RMS' },
  { metric: 'ups_autonomy_min', warn: 10, alarm: 5, dir: 'below', basis: 'Site policy — operator-configured' },
  { metric: 'battery_temp_c', warn: 30, alarm: 40, dir: 'above', basis: 'Li-ion vendor guidance — operator-configured' },
  { metric: 'leak', warn: 0.5, alarm: 0.5, dir: 'above', basis: 'Any liquid presence at a probe point' },
];

export const facility: Facility = {
  id: 'DAL-1', name: 'Data Hall A', site: 'DAL-1 (simulated)',
  zones, assets, services, edges, waypoints, walkEdges, thresholds,
};

// ---------------------------------------------------------------- people
export const employees: Employee[] = [
  { id: 'emp-priya', name: 'Priya Raman', initials: 'PR', role: 'supervisor', team: 'Ops', skills: ['electrical', 'cooling'], zones: ['Z-CORR', 'Z-HALL'], shift: 'night', availability: 'available', location: { zoneId: 'Z-CORR', waypointId: 'C-4', t: -2, source: 'manual' } },
  { id: 'emp-marcus', name: 'Marcus Lee', initials: 'ML', role: 'technician', team: 'Mechanical', skills: ['mechanical', 'cooling', 'vibration'], zones: ['Z-HALL', 'Z-MECH', 'Z-CORR'], shift: 'night', availability: 'available', location: { zoneId: 'Z-MECH', waypointId: 'M-1', t: -6, source: 'qr' } },
  { id: 'emp-sofia', name: 'Sofia Alvarez', initials: 'SA', role: 'technician', team: 'Electrical', skills: ['electrical', 'battery'], zones: ['Z-UPS', 'Z-BATT', 'Z-YARD', 'Z-CORR', 'Z-HALL'], shift: 'night', availability: 'available', location: { zoneId: 'Z-CORR', waypointId: 'C-2', t: -14, source: 'manual' } },
  { id: 'emp-jordan', name: 'Jordan Kim', initials: 'JK', role: 'technician', team: 'Mechanical', skills: ['leak_response', 'cooling', 'mechanical'], zones: ['Z-HALL', 'Z-CORR', 'Z-MECH', 'Z-BATT'], shift: 'night', availability: 'busy', location: { zoneId: 'Z-HALL', waypointId: 'N-04', t: -41, source: 'manual' } },
  { id: 'emp-amara', name: 'Amara Singh', initials: 'AS', role: 'engineer', team: 'Facilities eng.', skills: ['electrical', 'cooling', 'battery'], zones: ['Z-HALL', 'Z-UPS', 'Z-BATT', 'Z-MECH', 'Z-CORR', 'Z-YARD'], shift: 'night', availability: 'available', location: { zoneId: 'Z-CORR', waypointId: 'C-4', t: -9, source: 'manual' } },
  { id: 'emp-theo', name: 'Theo Brandt', initials: 'TB', role: 'technician', team: 'Network', skills: ['network', 'electrical'], zones: ['Z-HALL', 'Z-CORR'], shift: 'day', availability: 'off_shift' },
  { id: 'emp-reza', name: 'Reza Haddad', initials: 'RH', role: 'shift_lead', team: 'Ops', skills: ['electrical', 'cooling'], zones: ['Z-CORR', 'Z-HALL'], shift: 'day', availability: 'off_shift' },
];

/** Location older than this is shown as stale, never as live. */
export const CHECKIN_STALE_MIN = 30;

// --------------------------------------------------------------- runbooks
export interface Runbook { id: string; title: string; version: string; steps: string[] }
export const runbooks: Runbook[] = [
  { id: 'RB-VERIFY-TEMP', title: 'Verify a disputed inlet-temperature reading', version: 'v3.2', steps: [
    'Confirm asset ID label matches the task destination',
    'Place reference probe 5 cm in front of the rack inlet at the same height as the installed sensor',
    'Wait 90 s for the probe to settle; record reading and probe ID',
    'Record installed sensor value at the same timestamp',
    'Photograph sensor mounting and note any displacement',
  ] },
  { id: 'RB-FAN-VIB', title: 'CRAH fan vibration check', version: 'v2.0', steps: [
    'Confirm asset ID and record current fan speed / load',
    'Mount reference accelerometer on the fixed stud at the fan bearing housing',
    'Capture a 10 s window; record RMS velocity and 1× amplitude',
    'Compare against baseline (2.1 mm/s) and last visit',
    'Inspect blades and mounts for debris, imbalance, loose fasteners',
  ] },
  { id: 'RB-LEAK', title: 'Liquid leak — contain and isolate', version: 'v4.1', steps: [
    'Confirm location of liquid with probe; do not assume one dry point clears the area',
    'Identify source loop; request engineer approval before isolating any valve',
    'Deploy absorbent barrier at the battery-room threshold',
    'Check floor drain DRAIN-1 is flowing',
    'Photograph extent and mark wet front on the floor map',
  ] },
  { id: 'RB-BATT', title: 'Battery room inspection', version: 'v1.4', steps: [
    'Confirm string ID; check BMS for cell temperature spread',
    'Inspect for liquid at floor level and cable entry points',
    'Confirm no hot work or module handling in progress',
    'Record off-gas detector status',
  ] },
];

// ----------------------------------------------- maintenance / change log
export const changeLog: { t: number; assetId: string; text: string }[] = [
  { t: -1440, assetId: 'A-11', text: 'Row A inlet sensor firmware updated to 4.8.1 (vendor ticket #4471)' },
  { t: -4320, assetId: 'CRAH-2', text: 'Filter change; fan belt re-tensioned' },
  { t: -60, assetId: 'BATT-B', text: 'Vendor on site — module replacement on string B scheduled 03:00' },
  { t: -20160, assetId: 'B-07', text: 'Power-path audit: B-07 found single-corded (side A only)' },
];

// ------------------------------------------------------------- scenarios
export const scenarios: Scenario[] = [
  {
    id: 'scn-riser-leak',
    kind: 'real',
    name: 'Two warnings, then a leak',
    headline: 'A chilled-water leak drifts toward the UPS and battery rooms',
    description: 'A disputed rack inlet alarm and a real CRAH-2 fan vibration compete for the same technician. At 02:14 a Level-2 riser starts leaking above the corridor; water drifts toward the UPS and battery rooms.',
    basis: 'Leak path adapted from the Google Cloud europe-west9 (Paris) incident report, April 2023: 3 h 22 min between leak and battery-room awareness. Timeline compressed and simulated.',
    horizonMin: 60,
    faults: [{ assetId: 'CRAH-2', t: 34 }],
    leak: { x: 33.2, z: 12.5, ratePerMin: 38, startT: 4 },
    steps: [
      { t: 0, kind: 'alert', assetId: 'A-11', summary: 'Inlet temperature 34.2 °C on A-11 (installed sensor)', metric: 'inlet_temp_c', value: 34.2, source: 'installed' },
      { t: 1, kind: 'alert', assetId: 'CRAH-2', summary: 'CRAH-2 fan vibration 6.4 mm/s — up 205 % on baseline', metric: 'vibration_mm_s', value: 6.4, source: 'installed' },
      { t: 4, kind: 'fault', assetId: 'PIPE-L2', summary: 'Riser PIPE-L2 begins leaking (unobserved — no sensor on Level 2)' },
      { t: 11, kind: 'reading', assetId: 'PIPE-L2', summary: 'Loop make-up water flow +6 % (mass-balance mismatch)', metric: 'flow_lpm', value: 38, source: 'simulated' },
      { t: 34, kind: 'fault', assetId: 'CRAH-2', summary: 'CRAH-2 fan trips on vibration — modeled if not serviced' },
    ],
    // INC-1042/1043 are seeded at start (seedIncidents). These two open as the clock passes; the
    // water incident is rebuilt from the run (incidentsFor) so it follows fixes.
    incidents: [
      { id: 'INC-1044', title: 'Possible leak — loop make-up flow +6 %', rootAssetId: 'PIPE-L2', alertAssetIds: ['PIPE-L2', 'BATT-A', 'UPS-B', 'BATT-B', 'UPS-A', 'ATS-1'],
        severity: 'warning', status: 'open', evidence: 'unverified', shiftLeadId: 'emp-priya', openedAt: 11,
        summary: 'Chilled-water make-up flow no longer matches supply. No leak sensor exists on Level 2; the riser above the east corridor is the only pipe run consistent with the mismatch.',
        recentChanges: ['Vendor on site — BATT-B module replacement scheduled 03:00'], runbookId: 'RB-LEAK' },
      { id: 'INC-1045', title: 'Water reached BATT-A — battery/UPS exposure', rootAssetId: 'BATT-A', alertAssetIds: ['BATT-A', 'UPS-B', 'BATT-B', 'UPS-A'],
        severity: 'critical', status: 'open', evidence: 'unverified', shiftLeadId: 'emp-priya', openedAt: 12,
        summary: 'Water layer (approximation) shows the wet front at UPS/battery equipment. Li-ion string B is past its 10-year service life.',
        recentChanges: ['BATT-B installed 2015 — past 10-year service life', 'Vendor module work scheduled 03:00 — hold until dry'], runbookId: 'RB-BATT' },
    ],
  },
  {
    id: 'scn-gen-nostart',
    kind: 'real',
    name: 'Utility loss, no generator start',
    headline: 'Utility power is lost and the generator never starts',
    description: 'Grid surge damages transfer-switch relays; GEN-1 never receives a start signal. UPS batteries carry the load until they drain.',
    basis: 'Adapted from the NaviSite Silicon Valley outage (DatacenterDynamics): 36 min of UPS before blackout, ~40 min dark. Simulated.',
    horizonMin: 60,
    faults: [{ assetId: 'UTIL', t: 2 }, { assetId: 'GEN-1', t: 2 }],
    steps: [
      { t: 2, kind: 'fault', assetId: 'UTIL', summary: 'Utility feed lost (voltage sag → 0)' },
      { t: 2, kind: 'alert', assetId: 'ATS-1', summary: 'ATS-1 transfer requested — generator start not acknowledged' },
    ],
    incidents: [{
      id: 'INC-2001', title: 'Utility lost — generator start not acknowledged', rootAssetId: 'ATS-1', alertAssetIds: ['UTIL', 'GEN-1', 'ATS-1', 'BATT-A', 'BATT-B'],
      severity: 'critical', status: 'open', evidence: 'corroborated_abnormal', shiftLeadId: 'emp-priya', openedAt: 2,
      summary: 'Load is on UPS batteries. The only clock that matters is UPS autonomy; manual generator start is the fastest recovery.',
      recentChanges: ['ATS-1 last test transfer: 41 days ago'],
    }],
  },
  {
    id: 'scn-chiller-trip',
    kind: 'what-if',
    name: 'Chiller trip what-if',
    headline: 'One chiller trips; in the what-if, the second follows',
    description: 'CH-1 trips on high condenser pressure. Redundancy holds until CH-2 also trips at +12 min in the what-if.',
    basis: 'Engineering what-if; delay ranges are assumptions shown in the Why panel. Simulated.',
    horizonMin: 60,
    faults: [{ assetId: 'CH-1', t: 1 }, { assetId: 'CH-2', t: 12 }],
    steps: [
      { t: 1, kind: 'fault', assetId: 'CH-1', summary: 'CH-1 trip — high condenser pressure' },
      { t: 12, kind: 'fault', assetId: 'CH-2', summary: 'What-if: CH-2 trips as well' },
    ],
    incidents: [
      { id: 'INC-3001', title: 'Chiller 1 tripped — running on CH-2 only', rootAssetId: 'CH-1', alertAssetIds: ['CH-1'], severity: 'warning', status: 'open', evidence: 'corroborated_abnormal', shiftLeadId: 'emp-priya', openedAt: 1, summary: 'Redundancy lost on chilled water. No rack impact unless CH-2 also trips.', recentChanges: [] },
      { id: 'INC-3002', title: 'What-if: Chiller 2 tripped — no chilled water', rootAssetId: 'CH-2', alertAssetIds: ['CH-1', 'CH-2', 'P-1', 'P-2'], severity: 'critical', status: 'open', evidence: 'unverified', shiftLeadId: 'emp-priya', openedAt: 12, summary: 'Scenario preview: thermal ride-through clocks start across the hall.', recentChanges: [] },
    ],
  },
];

// ------------------------------------------------- seed readings/incidents
/** Baseline installed telemetry at scenario start. Row C sensors are deliberately stale. */
export function seedReadings(): Reading[] {
  const out: Reading[] = [];
  let n = 0;
  for (const r of racks) {
    const staleRowC = r.location.row === 'C' && Number(r.location.slot) >= 6;
    const base = 21.2 + ((Number(r.location.slot) * 13 + r.location.row!.charCodeAt(0)) % 25) / 10 + (GPU_RACKS.includes(r.id) ? 1.8 : 0);
    out.push({ id: `R-${++n}`, assetId: r.id, metric: 'inlet_temp_c', value: +base.toFixed(1), unit: '°C', t: staleRowC ? -19 : -1, source: 'installed', expectedIntervalMin: 5 });
  }
  out.push({ id: `R-${++n}`, assetId: 'A-11', metric: 'inlet_temp_c', value: 34.2, unit: '°C', t: 0, source: 'installed', expectedIntervalMin: 5 });
  // humidity is a modelled demo value, not a fitted probe: labelled simulated like every other generated reading
  out.push({ id: `R-${++n}`, assetId: 'A-11', metric: 'humidity_rh', value: 47, unit: '%', t: 0, source: 'simulated', expectedIntervalMin: 10 });
  out.push({ id: `R-${++n}`, assetId: 'CRAH-2', metric: 'humidity_rh', value: 45, unit: '%', t: 0, source: 'simulated', expectedIntervalMin: 10 });
  out.push({ id: `R-${++n}`, assetId: 'UPS-A', metric: 'humidity_rh', value: 44, unit: '%', t: 0, source: 'simulated', expectedIntervalMin: 10 });
  for (const c of ['CRAH-1', 'CRAH-3', 'CRAH-4']) out.push({ id: `R-${++n}`, assetId: c, metric: 'vibration_mm_s', value: 1.9 + (c.charCodeAt(5) % 3) / 10, unit: 'mm/s', t: -3, source: 'installed', expectedIntervalMin: 15 });
  out.push({ id: `R-${++n}`, assetId: 'CRAH-2', metric: 'vibration_mm_s', value: 6.4, unit: 'mm/s', t: 1, source: 'installed', expectedIntervalMin: 15 });
  out.push({ id: `R-${++n}`, assetId: 'UPS-A', metric: 'ups_autonomy_min', value: 13, unit: 'min', t: -1, source: 'installed', expectedIntervalMin: 5 });
  out.push({ id: `R-${++n}`, assetId: 'UPS-B', metric: 'ups_autonomy_min', value: 11, unit: 'min', t: -1, source: 'installed', expectedIntervalMin: 5 });
  out.push({ id: `R-${++n}`, assetId: 'BATT-A', metric: 'battery_temp_c', value: 24.1, unit: '°C', t: -1, source: 'installed', expectedIntervalMin: 5 });
  out.push({ id: `R-${++n}`, assetId: 'BATT-B', metric: 'battery_temp_c', value: 27.6, unit: '°C', t: -1, source: 'installed', expectedIntervalMin: 5 });
  return out;
}

/** Reference-probe readings a technician would capture (fixture, clearly labeled — no live sensor connection). */
export const referenceFixtures: Record<string, Omit<Reading, 'id' | 't'>> = {
  'A-11': { assetId: 'A-11', metric: 'inlet_temp_c', value: 24.1, unit: '°C', source: 'reference_probe', expectedIntervalMin: 5, probeId: 'PRB-01', point: 'A-11 front inlet, 1.6 m' },
  'CRAH-2': { assetId: 'CRAH-2', metric: 'vibration_mm_s', value: 6.6, unit: 'mm/s', source: 'reference_probe', expectedIntervalMin: 15, probeId: 'PRB-01', point: 'CRAH-2 fan bearing stud' },
  'BATT-B': { assetId: 'BATT-B', metric: 'leak', value: 1, unit: 'wet', source: 'reference_probe', expectedIntervalMin: 5, probeId: 'PRB-01', point: 'Battery room threshold, floor' },
};

export function seedIncidents(): Incident[] {
  return [
    { id: 'INC-1042', title: 'High inlet temperature reported on A-11', rootAssetId: 'A-11', alertAssetIds: ['A-11'], severity: 'critical', status: 'open', evidence: 'unverified', shiftLeadId: 'emp-priya', openedAt: 0,
      summary: 'One installed sensor reports 34.2 °C; neighbours A-10 and A-12 read 22–23 °C and CRAH-1/3 are healthy.', recentChanges: ['Row A inlet sensor firmware updated yesterday (4.8.1)'], runbookId: 'RB-VERIFY-TEMP' },
    { id: 'INC-1043', title: 'CRAH-2 fan vibration rising', rootAssetId: 'CRAH-2', alertAssetIds: ['CRAH-2'], severity: 'warning', status: 'open', evidence: 'unverified', shiftLeadId: 'emp-priya', openedAt: 1,
      summary: '6.4 mm/s against a 2.1 mm/s baseline (ISO zone C). CRAH-2 shares rows C–D with CRAH-4; losing it removes cooling redundancy for 20 racks.', recentChanges: ['Filter change and belt re-tension 3 days ago'], runbookId: 'RB-FAN-VIB' },
  ];
}

export function seedTasks(): Task[] {
  const steps = (rb: string) => runbooks.find((r) => r.id === rb)!.steps.map((text, i) => ({ id: `${rb}-${i + 1}`, text, required: i !== 4, evidenceIds: [] }));
  return [
    { id: 'TSK-201', type: 'verify', title: 'Verify A-11 inlet with reference probe', incidentId: 'INC-1042', assetId: 'A-11', requiredSkills: ['cooling'], status: 'unassigned', estimateMin: 8, checklist: steps('RB-VERIFY-TEMP'), reviewRequired: false, assetConfirmed: false, prerequisites: [], priorityReason: 'Disputed critical alarm — one check resolves it', version: 1 },
    { id: 'TSK-202', type: 'inspect', title: 'Vibration check on CRAH-2 fan', incidentId: 'INC-1043', assetId: 'CRAH-2', requiredSkills: ['vibration'], status: 'unassigned', estimateMin: 15, checklist: steps('RB-FAN-VIB'), reviewRequired: true, assetConfirmed: false, prerequisites: [], priorityReason: 'Losing CRAH-2 removes redundancy for 20 racks', version: 1 },
  ];
}
