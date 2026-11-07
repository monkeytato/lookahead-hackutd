/**
 * Walking routes over the facility's waypoint graph (undirected `walkEdges`).
 * Edge length = straight-line distance between its two waypoints. Closed edges and doors whose
 * `restrictedTo` skill the walker lacks are impassable. There is NEVER a straight-line fallback:
 * if the graph has no permitted path the route is `ok: false` with a reason.
 */
import type { Facility, ID, Route, Skill, WalkEdge, Waypoint } from '../types';

export interface RouteOptions {
  skills: Skill[];
  closedEdgeIds?: ID[];
  /** default 1.2 m/s */
  walkSpeedMps?: number;
  /** Where the start position comes from — reported in `assumptions`. */
  startSource?: { source: string; t: number; now?: number };
}

const RESTRICTED_DOOR_MIN = 0.5;

interface Graph { wp: Map<ID, Waypoint>; adj: Map<ID, { edge: WalkEdge; other: ID; len: number }[]> }

function buildGraph(facility: Facility): Graph {
  const wp = new Map(facility.waypoints.map((w) => [w.id, w]));
  const adj = new Map<ID, { edge: WalkEdge; other: ID; len: number }[]>();
  for (const w of facility.waypoints) adj.set(w.id, []);
  for (const e of facility.walkEdges) {
    const a = wp.get(e.a), b = wp.get(e.b);
    if (!a || !b) continue;
    const len = Math.hypot(a.x - b.x, a.z - b.z);
    adj.get(a.id)!.push({ edge: e, other: b.id, len });
    adj.get(b.id)!.push({ edge: e, other: a.id, len });
  }
  return { wp, adj };
}

/** Plain Dijkstra; `allowed` decides which edges may be used. Returns path + edges, or null. */
function dijkstra(g: Graph, from: ID, to: ID, allowed: (e: WalkEdge) => boolean): { path: ID[]; edges: WalkEdge[]; dist: number } | null {
  const dist = new Map<ID, number>([[from, 0]]);
  const prev = new Map<ID, { node: ID; edge: WalkEdge }>();
  const done = new Set<ID>();
  // Graph is small (< 100 nodes): an O(V²) selection is simpler than a heap and fast enough.
  for (;;) {
    let cur: ID | undefined;
    let best = Infinity;
    for (const [id, d] of dist) if (!done.has(id) && d < best) { best = d; cur = id; }
    if (cur === undefined) return null;
    if (cur === to) break;
    done.add(cur);
    for (const { edge, other, len } of g.adj.get(cur) ?? []) {
      if (done.has(other) || !allowed(edge)) continue;
      const nd = best + len;
      if (nd < (dist.get(other) ?? Infinity)) { dist.set(other, nd); prev.set(other, { node: cur, edge }); }
    }
  }
  const path: ID[] = [to];
  const edges: WalkEdge[] = [];
  let n = to;
  while (n !== from) {
    const p = prev.get(n)!;
    edges.unshift(p.edge);
    path.unshift(p.node);
    n = p.node;
  }
  return { path, edges, dist: dist.get(to)! };
}

export function findRoute(facility: Facility, fromWp: ID, toWp: ID, opts: RouteOptions): Route {
  const speed = opts.walkSpeedMps ?? 1.2;
  const closed = new Set(opts.closedEdgeIds ?? []);
  const assumptions = [`Walk speed ${speed} m/s along marked aisles`];
  if (opts.startSource) {
    const age = opts.startSource.now !== undefined ? ` (${Math.round(opts.startSource.now - opts.startSource.t)} min old)` : '';
    assumptions.push(`Start = last ${opts.startSource.source} check-in at ${fromWp}${age}`);
  } else {
    assumptions.push(`Start = waypoint ${fromWp} as given (no check-in source)`);
  }
  const fail = (blockedReason: string): Route => ({ ok: false, path: [], distanceM: 0, etaMin: 0, assumptions, blockedReason });

  const g = buildGraph(facility);
  if (!g.wp.has(fromWp)) return fail(`Unknown start waypoint ${fromWp}`);
  if (!g.wp.has(toWp)) return fail(`Unknown destination waypoint ${toWp}`);

  const isClosed = (e: WalkEdge) => !!e.closed || closed.has(e.id);
  const permitted = (e: WalkEdge) => !e.restrictedTo || opts.skills.includes(e.restrictedTo);

  const r = dijkstra(g, fromWp, toWp, (e) => !isClosed(e) && permitted(e));
  if (r) {
    const doors = r.edges.filter((e) => e.restrictedTo);
    const etaMin = r.dist / speed / 60 + doors.length * RESTRICTED_DOOR_MIN;
    if (doors.length) assumptions.push(`+${RESTRICTED_DOOR_MIN} min per restricted door (${doors.map((d) => d.note ?? d.id).join('; ')})`);
    return { ok: true, path: r.path, distanceM: Math.round(r.dist * 10) / 10, etaMin: Math.round(etaMin * 10) / 10, assumptions };
  }

  // Explain why: would it work with the access restriction lifted, or with closures reopened?
  const ignoringAccess = dijkstra(g, fromWp, toWp, (e) => !isClosed(e));
  if (ignoringAccess) {
    const need = ignoringAccess.edges.filter((e) => !permitted(e));
    const skills = [...new Set(need.map((e) => e.restrictedTo!))];
    return fail(`Requires ${skills.join(' + ')} access: ${need.map((e) => e.note ?? `door ${e.id}`).join('; ')}`);
  }
  const ignoringClosures = dijkstra(g, fromWp, toWp, permitted);
  if (ignoringClosures) {
    const shut = ignoringClosures.edges.filter(isClosed);
    return fail(`No open route: closed ${shut.map((e) => `${e.id} (${e.a}–${e.b}${e.note ? `, ${e.note}` : ''})`).join(', ')}`);
  }
  return fail(`No walkable connection between ${fromWp} and ${toWp} with current closures and access`);
}
