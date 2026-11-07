/**
 * Agent hub: runs the simulation director with real services, keeps the approval queue, and
 * RE-PLANS AUTOMATICALLY when a scan the director asked for comes back.
 *
 *   operator ▶ director plan #1 ──request_scan──▶ technician holds scan ──▶ bridge computes scan
 *        ▲                                                                        │
 *        └──────── plan #2 (automatic, with the new evidence) ◀───────────────────┘
 *
 * Hardware commands and outward tickets are only ever PROPOSED by the agent; they execute here,
 * after a person approves them on the dashboard.
 */
import { randomUUID } from 'node:crypto';
import { facility, scenarios, seedReadings } from '../src/domain/fixture';
import { simulateScenario } from '../src/domain/engine';
import type { RigEvent, Scan, ScanRequest, StampedFrame } from '../src/domain/rig/protocol';
import { scanToEvidence } from '../src/state/scanMapping';
import { runDirector } from './director';
import { createGithubIssue, type ExternalServices, type HttpLike } from './director/external';
import type { DirectorInput, DirectorResult, PendingAction } from './director/types';

export interface DirectorRecord {
  id: string;
  chainId: string;
  generation: number;
  trigger: string;
  at: string;
  result: DirectorResult;
}

export interface HubDeps {
  broadcast(event: string, data: unknown): void;
  latestFrame(): StampedFrame | null;
  recentEvents(): RigEvent[];
  deviceMode(): string;
  createRequest(r: { assetId: string; point: string; reason: string; incidentId?: string; requestedBy: string }): ScanRequest;
  sendCommand(cmd: string): { ok: boolean; reply: string };
  actions: PendingAction[];
  save(): void;
  env: Record<string, string | undefined>;
  http?: HttpLike;
}

const MAX_AUTO_REPLANS = 3;

export function createAgentHub(deps: HubDeps) {
  const http: HttpLike = deps.http ?? ((url, init) => fetch(url, init));
  const log: DirectorRecord[] = [];
  let ctx: {
    chainId: string; generation: number; input: DirectorInput;
    watchRequestIds: Set<string>; watchAssets: Set<string>; autoReplans: number;
  } | null = null;
  let running: Promise<unknown> | null = null;

  const services: ExternalServices = {
    http,
    rigStatus: () => ({ frame: deps.latestFrame(), events: deps.recentEvents(), mode: deps.deviceMode() }),
    requestScan: (r) => deps.createRequest(r),
    proposeAction: (a) => {
      const action: PendingAction = { ...a, id: `ACT-${randomUUID().slice(0, 6)}`, createdAt: new Date().toISOString(), status: 'pending' };
      deps.actions.push(action);
      deps.save();
      deps.broadcast('action', action);
      return action;
    },
    pendingActions: () => deps.actions,
    ticketsConfigured: !!(deps.env.GITHUB_TOKEN && deps.env.TICKET_REPO),
  };

  async function run(input: DirectorInput, trigger: string, generation: number, chainId: string): Promise<DirectorRecord> {
    const result = await runDirector(input, { ext: services, generation, trigger, env: deps.env });
    const rec: DirectorRecord = { id: `DIR-${randomUUID().slice(0, 6)}`, chainId, generation, trigger, at: new Date().toISOString(), result };
    log.push(rec);
    if (log.length > 20) log.shift();
    const watchAssets = new Set<string>();
    if (result.recommendation.nextScan) watchAssets.add(result.recommendation.nextScan.assetId);
    for (const q of result.queuedRequests ?? []) watchAssets.add(q.assetId);
    const prev = ctx?.chainId === chainId ? ctx : null;
    ctx = {
      chainId, generation, input,
      watchRequestIds: new Set((result.queuedRequests ?? []).map((q) => q.id)),
      watchAssets, autoReplans: prev?.autoReplans ?? 0,
    };
    deps.broadcast('director', rec);
    return rec;
  }

  /** Operator-triggered plan: starts a new chain. */
  async function plan(input: DirectorInput): Promise<DirectorRecord> {
    const p = run(input, 'operator', 1, `CH-${randomUUID().slice(0, 5)}`);
    running = p;
    try { return await p; } finally { if (running === p) running = null; }
  }

  /** Called by the bridge for every completed scan. Re-plans if the director was waiting for it. */
  async function onScan(scan: Scan): Promise<DirectorRecord | null> {
    if (!ctx || scan.status !== 'complete') return null;
    const matched = (scan.requestId && ctx.watchRequestIds.has(scan.requestId)) || ctx.watchAssets.has(scan.assetId);
    if (!matched) return null;
    if (ctx.autoReplans >= MAX_AUTO_REPLANS) {
      deps.broadcast('director_note', { chainId: ctx.chainId, note: `Auto re-plan limit (${MAX_AUTO_REPLANS}) reached — run the director again to continue.` });
      return null;
    }
    if (running) await running.catch(() => undefined);
    const c = ctx;
    c.autoReplans++;

    // apply the scan to the director's own snapshot with the same mapping the dashboard uses
    const scenario = scenarios.find((s) => s.id === c.input.scenarioId) ?? scenarios[0];
    const readings = simulateScenario({ facility, scenario, seedReadings: seedReadings() }).readingsAt(c.input.t);
    const ev = scanToEvidence(scan, { t: c.input.t, incidents: c.input.incidents, readings, sessionCount: 0 });
    const incidents = ev.incident && ev.session
      ? c.input.incidents.map((i) => (i.id === ev.incident!.id ? { ...i, evidence: ev.session!.verdict } : i))
      : c.input.incidents;
    const next: DirectorInput = {
      ...c.input,
      incidents,
      scans: [...c.input.scans.filter((s) => s.id !== scan.id), scan],
      question: `Re-plan: the scan you requested came back. ${ev.summary}. Update the plan: what changed, what is the next scan or action?`,
    };
    deps.broadcast('director_pending', { chainId: c.chainId, generation: c.generation + 1, trigger: `scan:${scan.id}` });
    const p = run(next, `scan:${scan.id}`, c.generation + 1, c.chainId);
    running = p;
    try { return await p; } finally { if (running === p) running = null; }
  }

  async function decide(id: string, decision: 'approve' | 'reject', by: string): Promise<PendingAction | null> {
    const a = deps.actions.find((x) => x.id === id);
    if (!a || a.status !== 'pending') return a ?? null;
    a.decidedBy = by.slice(0, 60);
    a.decidedAt = new Date().toISOString();
    if (decision === 'reject') {
      a.status = 'rejected';
    } else if (a.kind === 'rig_command') {
      const cmd = (a.payload as { cmd: string }).cmd;
      const r = deps.sendCommand(cmd);
      a.status = r.ok ? 'executed' : 'failed';
      a.result = r.reply;
    } else {
      const payload = a.payload as { title: string; body: string; labels: string[] };
      if (services.ticketsConfigured) {
        try { const { url } = await createGithubIssue(http, deps.env, payload); a.status = 'executed'; a.url = url; a.result = 'GitHub issue created'; }
        catch (e) { a.status = 'failed'; a.result = (e as Error).message; }
      } else {
        a.status = 'executed';
        a.result = 'Recorded locally — set GITHUB_TOKEN and TICKET_REPO to file it on GitHub';
      }
    }
    deps.save();
    deps.broadcast('action', a);
    return a;
  }

  return { plan, onScan, decide, latest: () => log.at(-1) ?? null, history: () => [...log] };
}
