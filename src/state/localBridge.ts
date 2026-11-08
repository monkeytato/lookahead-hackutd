/**
 * In-page stand-in for the bridge (server/index.ts), used by the static demo build
 * (`npm run build:artifact`, VITE_LOCAL_BRIDGE=1). That build is published as a claude.ai artifact,
 * where there is no server, no serial port and no NVIDIA key.
 *
 * Same API and the same events as the real bridge, built from the same modules:
 *   SimRig (frames at 1 Hz) → diagnose/followUp (rig rules) → summarizeScan (hold-to-scan)
 *   → agent hub with the deterministic local planner (Nemotron needs the key, which never ships).
 * Outside services (api.weather.gov, GitHub) are reported as unavailable, not faked.
 * Scans, requests, rig events and approvals persist in this browser's localStorage only.
 */
import { createAgentHub } from '../../server/agentHub';
import type { HttpLike } from '../../server/director/external';
import type { PendingAction } from '../../server/director/types';
import { DEFAULT_MODEL, DEFAULT_BASE_URL } from '../../server/director/nemotron';
import { diagnose, followUp } from '../domain/rig/diagnose';
import { MIN_HOLD_S, TARGET_HOLD_S, type BridgeStatus, type RigEvent, type RigFrame, type Scan, type ScanRequest, type StampedFrame } from '../domain/rig/protocol';
import { summarizeScan } from '../domain/rig/scan';
import { SimRig } from '../domain/rig/simDevice';

export type BridgeListener = (event: string, data: unknown) => void;
export interface LocalResponse { status: number; body: unknown }

const STORE_KEY = 'lookahead.localBridge.v1';
const MAX_FRAMES = 900;

const RIG_CMD = /^(flap (open|close)|valve (open|close)|fan \d{1,3} \d{1,3}|auto (on|off)|cal|ping)$/;
const SIM_CMD = /^sim (power (off|on)|fault (inlet_top|clear)|heat (high|normal)|fan_a (fail|ok)|block outlet|unblock|supply (loss|ok)|leak (remote|stop)|spill|dry)$/;

interface Store { scans: Scan[]; requests: ScanRequest[]; events: RigEvent[]; actions: PendingAction[] }

function loadStore(): Store {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Store | null;
    if (s) return { scans: s.scans ?? [], requests: s.requests ?? [], events: s.events ?? [], actions: s.actions ?? [] };
  } catch { /* private window or blocked storage: start empty */ }
  return { scans: [], requests: [], events: [], actions: [] };
}

const str = (v: unknown, max = 120) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);
const uid = () => globalThis.crypto.randomUUID();

/** Outside services cannot be reached from the static page; tools say so instead of inventing data. */
const offlineHttp: HttpLike = async (url) => { throw new Error(`${new URL(url).host} is not reachable from the static demo`); };

export function createLocalBridge() {
  const listeners = new Set<BridgeListener>();
  const frames: StampedFrame[] = [];
  const store = loadStore();
  const sim = new SimRig(7);
  let framesReceived = 0;
  let device: BridgeStatus['device'] = { mode: 'simulated', port: null, deviceId: null, firmware: null, lastFrameAt: null, framesReceived: 0 };
  let active: { id: string; assetId: string; point: string; operator: string; requestId?: string; startedAt: string; autoStop: number } | null = null;
  let saveTimer: number | undefined;

  const broadcast = (event: string, data: unknown) => { for (const l of listeners) l(event, data); };
  const save = () => {
    if (saveTimer !== undefined) return;
    saveTimer = window.setTimeout(() => {
      saveTimer = undefined;
      try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* storage unavailable: keep in memory */ }
    }, 500);
  };
  const status = (): BridgeStatus => ({
    device: { ...device, framesReceived },
    nemotron: { configured: false, model: DEFAULT_MODEL, baseUrl: DEFAULT_BASE_URL },
    scanning: active ? { id: active.id, assetId: active.assetId, startedAt: active.startedAt } : null,
  });

  function ingest(frame: RigFrame) {
    const stamped: StampedFrame = { ...frame, source: 'simulated', at: new Date().toISOString() };
    frames.push(stamped);
    if (frames.length > MAX_FRAMES) frames.splice(0, frames.length - MAX_FRAMES);
    framesReceived++;
    device = { ...device, deviceId: frame.dev, firmware: frame.fw, lastFrameAt: stamped.at };
    broadcast('frame', stamped);
    const cutoff = Date.now() - 60_000;
    const win = frames.filter((f) => Date.parse(f.at) >= cutoff);
    try {
      const fresh = diagnose(win, store.events.slice(-50), stamped.at);
      for (const ev of fresh) { store.events.push(ev); broadcast('rig_event', ev); }
      const confirmed = followUp(win, store.events.slice(-50));
      for (const ev of confirmed) {
        const i = store.events.findIndex((x) => x.id === ev.id);
        if (i >= 0) store.events[i] = ev;
        broadcast('rig_event', ev);
      }
      if (fresh.length || confirmed.length) { store.events = store.events.slice(-500); save(); }
    } catch (e) { console.error('[local bridge] diagnose failed', e); }
  }

  function sendCommand(raw: string): { ok: boolean; reply: string } {
    const cmd = raw.trim().toLowerCase();
    if (SIM_CMD.test(cmd) || RIG_CMD.test(cmd)) return { ok: true, reply: sim.command(cmd) };
    return { ok: false, reply: 'unknown command' };
  }

  function createRequest(b: { assetId: string; point: string; reason: string; incidentId?: string; taskId?: string; requestedBy: string }): ScanRequest {
    const dup = store.requests.find((r) => r.status === 'open' && r.assetId === b.assetId && r.point === b.point);
    if (dup) return dup;
    const r: ScanRequest = { id: `REQ-${uid().slice(0, 6)}`, createdAt: new Date().toISOString(), requestedBy: b.requestedBy, reason: b.reason, assetId: b.assetId, point: b.point, incidentId: b.incidentId, taskId: b.taskId, status: 'open' };
    store.requests.push(r); save(); broadcast('request', r);
    return r;
  }

  const hub = createAgentHub({
    broadcast,
    latestFrame: () => frames.at(-1) ?? null,
    recentEvents: () => store.events.slice(-10),
    deviceMode: () => device.mode,
    createRequest,
    sendCommand,
    actions: store.actions,
    save,
    env: {}, // no key in a published page: the director runs the local planner and says so
    http: offlineHttp,
  });

  function finishScan(id: string, reason: 'released' | 'auto'): Scan | null {
    if (!active || active.id !== id) return null;
    const a = active;
    window.clearTimeout(a.autoStop);
    active = null;
    const endedAt = new Date().toISOString();
    const win = frames.filter((f) => f.at >= a.startedAt && f.at <= endedAt);
    const scan = summarizeScan(win, {
      id: a.id, point: { assetId: a.assetId, point: a.point }, operator: a.operator,
      deviceId: device.deviceId ?? 'unknown', firmware: device.firmware ?? 'unknown',
      startedAt: a.startedAt, endedAt, requestId: a.requestId,
    });
    if (reason === 'auto' && scan.status === 'complete') scan.quality = [...scan.quality, 'auto_completed'];
    if (scan.status === 'complete') {
      store.scans.push(scan);
      store.scans = store.scans.slice(-300);
      const req = a.requestId ? store.requests.find((r) => r.id === a.requestId) : undefined;
      if (req) { req.status = 'done'; req.scanId = scan.id; broadcast('request', req); }
      save();
      broadcast('scan', scan);
      hub.onScan(scan).catch((e) => console.error('[local bridge] auto re-plan failed', e));
    }
    broadcast('status', status());
    return scan;
  }

  async function handle(method: string, path: string, b: Record<string, unknown>): Promise<LocalResponse> {
    const ok = (body: unknown): LocalResponse => ({ status: 200, body });
    const err = (code: number, error: string): LocalResponse => ({ status: code, body: { error } });
    if (method === 'GET') {
      if (path === '/api/status') return ok({ ...status(), badLines: 0 });
      if (path === '/api/scans') return ok(store.scans.slice(-100));
      if (path === '/api/events') return ok(store.events.slice(-100));
      if (path === '/api/requests') return ok(store.requests.filter((r) => r.status === 'open'));
      if (path === '/api/actions') return ok(store.actions.slice(-50));
      if (path === '/api/director/latest') return ok(hub.latest());
      if (path.startsWith('/api/frames')) return ok(frames.slice(-120));
      return err(404, 'not found');
    }
    if (path === '/api/scans/start') {
      const assetId = str(b.assetId, 24), point = str(b.point), operator = str(b.operator, 60) ?? 'unknown';
      if (!assetId || !point) return err(400, 'assetId and point are required');
      if (active) {
        const age = (Date.now() - Date.parse(active.startedAt)) / 1000;
        if (age < TARGET_HOLD_S + 5) return err(409, `scan ${active.id} already running`);
        finishScan(active.id, 'auto');
      }
      if (!device.lastFrameAt || Date.now() - Date.parse(device.lastFrameAt) > 5000) return err(503, 'no recent frames from the rig');
      const id = `SCN-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}-${uid().slice(0, 4)}`;
      const startedAt = new Date().toISOString();
      const autoStop = window.setTimeout(() => finishScan(id, 'auto'), (TARGET_HOLD_S + 0.5) * 1000);
      active = { id, assetId, point, operator, requestId: str(b.requestId, 60) ?? undefined, startedAt, autoStop };
      broadcast('status', status());
      return ok({ id, startedAt, minHoldS: MIN_HOLD_S, targetHoldS: TARGET_HOLD_S });
    }
    const stop = path.match(/^\/api\/scans\/([\w-]+)\/stop$/);
    if (stop) {
      const scan = finishScan(stop[1], 'released');
      if (scan) return ok(scan);
      const done = store.scans.find((s) => s.id === stop[1]);
      return done ? ok(done) : err(404, 'no such running scan');
    }
    if (path === '/api/requests') {
      const assetId = str(b.assetId, 24), point = str(b.point), reason = str(b.reason, 400);
      if (!assetId || !point || !reason) return err(400, 'assetId, point and reason are required');
      return ok(createRequest({ assetId, point, reason, requestedBy: str(b.requestedBy, 60) ?? 'dashboard', incidentId: str(b.incidentId, 24) ?? undefined, taskId: str(b.taskId, 24) ?? undefined }));
    }
    const cancel = path.match(/^\/api\/requests\/([\w-]+)\/cancel$/);
    if (cancel) {
      const r = store.requests.find((x) => x.id === cancel[1]);
      if (!r) return err(404, 'not found');
      r.status = 'cancelled'; save(); broadcast('request', r);
      return ok(r);
    }
    if (path === '/api/rig/command') {
      const r = sendCommand(String(b.cmd ?? ''));
      return { status: r.ok ? 200 : 400, body: r };
    }
    if (path === '/api/director') {
      const rec = await hub.plan({
        scenarioId: String(b.scenarioId ?? 'scn-riser-leak'), t: Number(b.t ?? 0),
        incidents: Array.isArray(b.incidents) ? b.incidents : [],
        scans: Array.isArray(b.scans) ? b.scans : store.scans.slice(-20),
        confirmedEdgeIds: Array.isArray(b.confirmedEdgeIds) ? b.confirmedEdgeIds : [],
        question: str(b.question, 500) ?? undefined,
      });
      return ok({ ...rec.result, recordId: rec.id, chainId: rec.chainId });
    }
    const decide = path.match(/^\/api\/actions\/([\w-]+)\/(approve|reject)$/);
    if (decide) {
      const a = await hub.decide(decide[1], decide[2] as 'approve' | 'reject', str(b.by, 60) ?? 'operator');
      return a ? ok(a) : err(404, 'no such action');
    }
    if (path === '/api/reset') {
      store.scans = []; store.requests = []; store.events = []; store.actions.length = 0; save();
      broadcast('hello', { frames: frames.slice(-120), scans: [], requests: [], events: [] });
      return ok({ ok: true });
    }
    return err(404, 'not found');
  }

  // warm-up: a minute of history so charts and rig rules have data on first paint
  const t0 = Date.now() - 60_000;
  for (let i = 0; i < 60; i++) {
    const f = sim.tick(1);
    const stamped: StampedFrame = { ...f, source: 'simulated', at: new Date(t0 + i * 1000).toISOString() };
    frames.push(stamped);
    framesReceived++;
    device = { ...device, deviceId: f.dev, firmware: f.fw, lastFrameAt: stamped.at };
  }
  window.setInterval(() => ingest(sim.tick(1)), 1000);

  return {
    /** Like opening /api/stream: replays status + hello, then live events. */
    subscribe(l: BridgeListener): () => void {
      listeners.add(l);
      l('status', status());
      l('hello', { frames: frames.slice(-120), scans: store.scans.slice(-30), requests: store.requests.filter((r) => r.status === 'open'), events: store.events.slice(-20), actions: store.actions.slice(-20), director: hub.latest() });
      return () => { listeners.delete(l); };
    },
    request(method: string, path: string, body?: unknown): Promise<LocalResponse> {
      // round-trip through JSON so callers can't share mutable objects with the store
      const b = body === undefined ? {} : (JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
      return handle(method, path.split('?')[0], b).then((r) => JSON.parse(JSON.stringify(r)) as LocalResponse);
    },
  };
}

let singleton: ReturnType<typeof createLocalBridge> | null = null;
/** One rig per page: it survives route changes (#/app ↔ #/scan ↔ #/m) like the real bridge does. */
export function getLocalBridge() {
  singleton ??= createLocalBridge();
  return singleton;
}
