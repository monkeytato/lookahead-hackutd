/**
 * Cascade engine: Monte Carlo time-to-impact over the dependency graph.
 *
 * Model per run:
 *  - every edge delay is drawn from its triangular {min, mode, max};
 *  - a faulted node is lost at its fault `t`;
 *  - any other node is lost at  min over its redundancy groups of
 *      (max over the group's member edges of lossTime(from) + delay)
 *    i.e. a group is a set of redundant feeds — all must be gone before the node is;
 *    an edge without `redundancyGroup` is a group on its own (single point of failure).
 *
 * Only `confirmed` facility edges are used, plus any `extraEdges` the caller passes in
 * (what-if / candidate edges must be opted in explicitly — acceptance A05).
 *
 * Fixes and recovery (operator remediation, `opts.fixes`): an asset fixed at tf is available
 * again from tf. Per run every node has a loss time L and a recovery time R (∞ = never):
 *  - an edge X→Y only propagates if X is still down when its delay runs out: L[X] + d < R[X]
 *    (a generator started before the batteries drain means the batteries never drain);
 *  - a group that is fully lost recovers when its first member recovers;
 *  - a fixed node ignores any loss arriving at or after tf, and recovers at tf at the latest;
 *  - losses that happened before a fix stay in the record (no rewriting history).
 * With no fixes every R is ∞ and the model is exactly the one above.
 */
import type { DependencyEdge, Facility, ID, ImpactClock } from '../types';
import { mulberry32, sampleTriangular } from './rng';

export interface CascadeOptions {
  horizonMin: number;
  /** Monte Carlo runs (default 400) */
  runs?: number;
  /** RNG seed (default 7) */
  seed?: number;
  /** Additional edges (what-if, derived water edges, opted-in candidates). Used regardless of `confirmed`. */
  extraEdges?: DependencyEdge[];
  /** Operator fixes: the asset is repaired / protected from `t` on (see the header). */
  fixes?: { assetId: ID; t: number }[];
}

/** Indexed dependency graph: nodes, edges, redundancy groups and a topological order (built once). */
export interface CompiledGraph {
  ids: ID[]; index: Map<ID, number>; edges: DependencyEdge[]; N: number; E: number;
  from: Int32Array; to: Int32Array; groups: number[][][]; order: number[];
}

/** Compile the graph runCascade uses: confirmed facility edges + extraEdges; extraIds adds fault/fix-only nodes. */
export function compileGraph(facility: Facility, extraEdges: DependencyEdge[] = [], extraIds: ID[] = []): CompiledGraph {
  const edges = [...facility.edges.filter((e) => e.confirmed), ...extraEdges];

  // ---- index nodes (assets plus any ids referenced only by edges / faults)
  const ids: ID[] = facility.assets.map((a) => a.id);
  const index = new Map<ID, number>(ids.map((id, i) => [id, i]));
  const ensure = (id: ID) => {
    if (!index.has(id)) { index.set(id, ids.length); ids.push(id); }
    return index.get(id)!;
  };
  for (const e of edges) { ensure(e.from); ensure(e.to); }
  for (const id of extraIds) ensure(id);
  const N = ids.length;
  const E = edges.length;
  const from = Int32Array.from(edges, (e) => index.get(e.from)!);
  const to = Int32Array.from(edges, (e) => index.get(e.to)!);

  // ---- redundancy groups per destination node: groups[node] = list of edge-index lists
  const groups: number[][][] = Array.from({ length: N }, () => []);
  {
    const keyed = new Map<string, number[]>();
    edges.forEach((e, i) => {
      const key = e.redundancyGroup ? `${e.to}|${e.redundancyGroup}` : `#${i}`;
      let g = keyed.get(key);
      if (!g) { g = []; keyed.set(key, g); groups[to[i]].push(g); }
      g.push(i);
    });
  }

  // ---- topological order (Kahn) so a single relaxation pass usually settles; cycles fall back
  // to repeated passes until stable.
  const order: number[] = [];
  {
    const indeg = new Int32Array(N);
    const out: number[][] = Array.from({ length: N }, () => []);
    for (let i = 0; i < E; i++) { indeg[to[i]]++; out[from[i]].push(to[i]); }
    const q: number[] = [];
    for (let n = 0; n < N; n++) if (indeg[n] === 0) q.push(n);
    const seen = new Uint8Array(N);
    while (q.length) {
      const n = q.shift()!;
      seen[n] = 1; order.push(n);
      for (const m of out[n]) if (--indeg[m] === 0) q.push(m);
    }
    for (let n = 0; n < N; n++) if (!seen[n]) order.push(n);
  }

  return { ids, index, edges, N, E, from, to, groups, order };
}

/**
 * One Monte Carlo run over a compiled graph with the given edge delays, own-fault times and fix
 * times (Infinity = none). Fills loss / rec / cause (see the header for the recovery rules).
 */
export function runOnce(g: CompiledGraph, delay: Float64Array, faultT: Float64Array, fixT: Float64Array, loss: Float64Array, rec: Float64Array, cause: Int32Array): void {
  const { N, from, groups, order } = g;
  // own faults: a fix at or before the fault prevents it; otherwise the fix ends it
  for (let n = 0; n < N; n++) {
    const own = faultT[n] < fixT[n] ? faultT[n] : Infinity;
    loss[n] = own; rec[n] = own < Infinity ? fixT[n] : Infinity; cause[n] = own < Infinity ? -1 : -2;
  }

  // Relax to a fixpoint. Each node is recomputed from its own fault and its upstream groups.
  for (let pass = 0; pass <= N; pass++) {
    let changed = false;
    for (const n of order) {
      const gs = groups[n];
      if (gs.length === 0) continue;
      const own = faultT[n] < fixT[n] ? faultT[n] : Infinity;
      let bestL = own;
      let bestCause = own < Infinity ? -1 : -2;
      // recovery = when every active cause has recovered (own fault: only a fix ends it)
      let maxR = own < Infinity ? fixT[n] : -Infinity;
      let gBest = Infinity;
      let gBestEdge = -2;
      for (const g of gs) {
        let worst = -Infinity;
        let worstEdge = -2;
        let gR = Infinity;
        for (const ei of g) {
          const f = from[ei];
          const arrive = loss[f] + delay[ei];
          const t = arrive < rec[f] ? arrive : Infinity; // upstream back before the buffer ran out
          if (t > worst) { worst = t; worstEdge = ei; }
          if (rec[f] < gR) gR = rec[f]; // the group is back when its first member is
        }
        if (worst === Infinity || worst >= fixT[n]) continue;
        gR = Math.min(gR, fixT[n]);
        if (worst >= gR) continue;
        if (gR > maxR) maxR = gR;
        if (worst < gBest) { gBest = worst; gBestEdge = worstEdge; }
      }
      // Prefer the propagated cause on ties so paths show where the loss came from.
      if (gBest < Infinity && gBest <= bestL) { bestL = gBest; bestCause = gBestEdge; }
      const newR = bestL === Infinity ? Infinity : Math.min(maxR, fixT[n]);
      if (bestL !== loss[n] || newR !== rec[n] || bestCause !== cause[n]) {
        if (bestL !== loss[n] || newR !== rec[n]) changed = true;
        loss[n] = bestL; rec[n] = newR; cause[n] = bestCause;
      }
    }
    if (!changed) break;
  }
}

export function runCascade(
  facility: Facility,
  faults: { assetId: ID; t: number }[],
  opts: CascadeOptions,
): Record<ID, ImpactClock> {
  const runs = Math.max(1, opts.runs ?? 400);
  const rand = mulberry32(opts.seed ?? 7);
  const horizon = opts.horizonMin;

  const g = compileGraph(facility, opts.extraEdges ?? [], [...faults.map((f) => f.assetId), ...(opts.fixes ?? []).map((f) => f.assetId)]);
  const { ids, index, edges, N, E, from, to } = g;

  const faultT = new Float64Array(N).fill(Infinity);
  for (const f of faults) {
    const n = index.get(f.assetId)!;
    faultT[n] = Math.min(faultT[n], f.t);
  }

  const fixT = new Float64Array(N).fill(Infinity);
  for (const f of opts.fixes ?? []) {
    const n = index.get(f.assetId)!;
    fixT[n] = Math.min(fixT[n], f.t);
  }
  const hasFixes = (opts.fixes ?? []).length > 0;

  // Per-node accumulators across runs
  const times: Float64Array[] = Array.from({ length: N }, () => new Float64Array(runs));
  const recov: Float64Array[] = Array.from({ length: N }, () => new Float64Array(runs));
  const pathCounts: Map<string, number>[] = Array.from({ length: N }, () => new Map());

  const delay = new Float64Array(E);
  const loss = new Float64Array(N);
  const rec = new Float64Array(N);
  /** cause[n]: edge index that determined the loss time, -1 = own fault, -2 = not lost */
  const cause = new Int32Array(N);

  for (let r = 0; r < runs; r++) {
    for (let i = 0; i < E; i++) {
      const d = edges[i].delay;
      delay[i] = sampleTriangular(rand, d.min, d.mode, d.max);
    }
    runOnce(g, delay, faultT, fixT, loss, rec, cause);

    for (let n = 0; n < N; n++) {
      const lost = loss[n] <= horizon;
      times[n][r] = lost ? loss[n] : Infinity;
      recov[n][r] = lost ? rec[n] : Infinity;
      if (!lost) continue;
      // trace propagation path back to a fault: edge indices, root first
      const chain: number[] = [];
      let cur = n;
      for (let guard = 0; guard <= N && cause[cur] >= 0; guard++) {
        chain.push(cause[cur]);
        cur = from[cause[cur]];
      }
      chain.reverse();
      const key = `${cur}:${chain.join(',')}`;
      pathCounts[n].set(key, (pathCounts[n].get(key) ?? 0) + 1);
    }
  }

  const result: Record<ID, ImpactClock> = {};
  const pct = (sorted: Float64Array, q: number) => {
    const v = sorted[Math.min(runs - 1, Math.max(0, Math.ceil(q * runs) - 1))];
    return v === Infinity ? null : Math.round(v * 10) / 10;
  };
  for (let n = 0; n < N; n++) {
    const sorted = times[n].slice().sort();
    let lostRuns = 0;
    for (let r = 0; r < runs; r++) if (sorted[r] !== Infinity) lostRuns++;
    if (lostRuns === 0) continue;

    // modal path
    let bestKey = '';
    let bestCount = -1;
    for (const [k, c] of pathCounts[n]) if (c > bestCount) { bestCount = c; bestKey = k; }
    const [rootStr, chainStr] = bestKey.split(':');
    const chain = chainStr ? chainStr.split(',').map(Number) : [];
    const path: ID[] = [ids[Number(rootStr)], ...chain.map((ei) => ids[to[ei]])];

    // weakest assumption = widest delay spread on the modal path
    let weakest: DependencyEdge | undefined;
    for (const ei of chain) {
      const e = edges[ei];
      const w = e.delay.max - e.delay.min;
      if (w > 0 && (!weakest || w > weakest.delay.max - weakest.delay.min)) weakest = e;
    }

    // Percentiles are taken over ALL runs (not-lost = +∞), so p50 is null when the node is lost
    // in fewer than half the runs, etc.
    result[ids[n]] = {
      assetId: ids[n],
      p10: pct(sorted, 0.1),
      p50: pct(sorted, 0.5),
      p90: pct(sorted, 0.9),
      probWithinHorizon: lostRuns / runs,
      path,
      weakestAssumption: weakest?.basis,
    };
    if (hasFixes) {
      // median recovery over the runs where this node was lost (∞ = stays down)
      const rs: number[] = [];
      for (let r = 0; r < runs; r++) if (times[n][r] !== Infinity) rs.push(recov[n][r]);
      rs.sort((a, b) => a - b);
      const m = rs[Math.max(0, Math.ceil(0.5 * rs.length) - 1)];
      result[ids[n]].recoveredP50 = m === undefined || m === Infinity ? null : Math.round(m * 10) / 10;
    }
  }
  return result;
}
