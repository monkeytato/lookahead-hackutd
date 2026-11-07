import { describe, expect, it } from 'vitest';
import { findRoute } from '../../src/domain/engine';
import { facility } from '../../src/domain/fixture';

const edgeId = (a: string, b: string) => facility.walkEdges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))!.id;

describe('findRoute', () => {
  it('finds a valid route to the CRAH-2 access waypoint', () => {
    const crah2 = facility.assets.find((a) => a.id === 'CRAH-2')!;
    const r = findRoute(facility, 'C-2', crah2.accessWaypoint, { skills: ['vibration', 'mechanical'] });
    expect(r.ok).toBe(true);
    expect(r.path[0]).toBe('C-2');
    expect(r.path.at(-1)).toBe('S-W');
    // consecutive path nodes must be joined by a walk edge (no straight-line shortcuts)
    for (let i = 1; i < r.path.length; i++) expect(edgeId(r.path[i - 1], r.path[i])).toBeTruthy();
    expect(r.distanceM).toBeGreaterThan(18);
    expect(r.etaMin).toBeCloseTo(r.distanceM / 1.2 / 60, 1);
    expect(r.assumptions.join(' ')).toMatch(/1\.2 m\/s/);
  });

  it('UPS room is unreachable without electrical skill, with a blockedReason', () => {
    const r = findRoute(facility, 'C-2', 'U-2', { skills: ['cooling', 'mechanical'] });
    expect(r.ok).toBe(false);
    expect(r.path).toEqual([]);
    expect(r.blockedReason).toMatch(/electrical/);
  });

  it('electrical skill passes the restricted door with +0.5 min', () => {
    const r = findRoute(facility, 'C-2', 'U-2', { skills: ['electrical'] });
    expect(r.ok).toBe(true);
    expect(r.path).toEqual(['C-2', 'C-1', 'U-1', 'U-2']);
    expect(r.etaMin).toBeCloseTo(r.distanceM / 1.2 / 60 + 0.5, 1);
  });

  it('A12: closed edge reroutes when an alternative exists', () => {
    const open = findRoute(facility, 'C-2', 'N-E', { skills: [] });
    expect(open.path).toContain('H-E');
    expect(open.path).not.toContain('H-NE');
    const r = findRoute(facility, 'C-2', 'N-E', { skills: [], closedEdgeIds: [edgeId('H-E', 'N-E')] });
    expect(r.ok).toBe(true);
    expect(r.path).toContain('H-NE');
    expect(r.distanceM).toBeGreaterThan(open.distanceM);
  });

  it('A12: closed edge with no alternative gives no route, never a straight line', () => {
    const r = findRoute(facility, 'C-2', 'H-E', { skills: [], closedEdgeIds: [edgeId('C-2', 'H-E')] });
    expect(r.ok).toBe(false);
    expect(r.blockedReason).toMatch(/closed/i);
    const unknown = findRoute(facility, 'C-2', 'NOPE', { skills: [] });
    expect(unknown.ok).toBe(false);
  });
});
