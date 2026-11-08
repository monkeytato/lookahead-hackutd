/**
 * Lookahead bridge — the only process that touches the Rack Monitor's serial port.
 *
 *   Rack Monitor (USB, JSON lines @1 Hz) ─┐
 *                                         ├─► bridge ─► SSE /api/stream ─► dashboard, scanner app
 *   SimRig (when no device is attached) ──┘     │
 *                                               ├─ scans are computed HERE from buffered frames
 *                                               │  (a client can start/stop a scan, never send numbers)
 *                                               ├─ rig rules (ten situations) → rig events
 *                                               └─ /api/director → Nemotron simulation director
 *
 * Binds to 127.0.0.1 unless BRIDGE_HOST is set. No auth: a LAN demo only, never expose publicly.
 */
import http from 'node:http';
import { createWorkflowHub } from './workflowHub';
import type { WorkState } from '../src/domain/workflow';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import {
  BAUD, MIN_HOLD_S, TARGET_HOLD_S,
  type BridgeStatus, type RigEvent, type RigFrame, type Scan, type ScanRequest, type StampedFrame,
} from '../src/domain/rig/protocol';
import { SimRig } from '../src/domain/rig/simDevice';
import { summarizeScan } from '../src/domain/rig/scan';
import { diagnose, followUp } from '../src/domain/rig/diagnose';
import { createAgentHub } from './agentHub';
import { createStageHub } from './stageHub';
import { phoneFixCommand, phoneRandomCommand, phoneSummary } from './phoneSummary';
import type { StageState } from '../src/stage/protocol';
import type { PendingAction } from './director/types';
import { loadEnv } from './env';
import { DEFAULT_MODEL } from './director/nemotron';

loadEnv();
const PORT = Number(process.env.BRIDGE_PORT ?? 8787);
const HOST = process.env.BRIDGE_HOST ?? '127.0.0.1';
const SIM_MODE = process.env.RACKMON_SIM ?? 'auto'; // auto | 1 (force sim) | 0 (never sim)
const here = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(here, '.data', 'store.json');

// ------------------------------------------------------------------ state

const frames: StampedFrame[] = [];
const MAX_FRAMES = 900; // 15 min at 1 Hz
let framesReceived = 0;
let badLines = 0;

interface Store { scans: Scan[]; requests: ScanRequest[]; events: RigEvent[]; actions: PendingAction[]; stage?: StageState; workflow?: WorkState }
const store: Store = loadStore();

let device: BridgeStatus['device'] = { mode: 'disconnected', port: null, deviceId: null, firmware: null, lastFrameAt: null, framesReceived: 0 };
let serial: SerialPort | null = null;
let sim: SimRig | null = null;
let simTimer: NodeJS.Timeout | null = null;

interface ActiveScan { id: string; assetId: string; point: string; operator: string; requestId?: string; startedAt: string; autoStop: NodeJS.Timeout }
let active: ActiveScan | null = null;

function loadStore(): Store {
  try { const s = JSON.parse(readFileSync(DATA_FILE, 'utf8')) as Store; return { ...s, actions: s.actions ?? [] }; } catch { return { scans: [], requests: [], events: [], actions: [] }; }
}
let saveTimer: NodeJS.Timeout | null = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { mkdirSync(dirname(DATA_FILE), { recursive: true }); writeFileSync(DATA_FILE, JSON.stringify(store, null, 1)); } catch (e) { console.error('[bridge] save failed', e); }
  }, 500);
}

// ------------------------------------------------------------------- SSE

const clients = new Set<http.ServerResponse>();
function broadcast(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
function status(): BridgeStatus {
  return {
    device: { ...device, framesReceived },
    nemotron: {
      configured: !!process.env.NVIDIA_API_KEY,
      model: process.env.NEMOTRON_MODEL || DEFAULT_MODEL,
      baseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    },
    scanning: active ? { id: active.id, assetId: active.assetId, startedAt: active.startedAt } : null,
  };
}

// ---------------------------------------------------------------- frames

function ingest(frame: RigFrame, source: StampedFrame['source']) {
  const stamped: StampedFrame = { ...frame, source, at: new Date().toISOString() };
  frames.push(stamped);
  if (frames.length > MAX_FRAMES) frames.splice(0, frames.length - MAX_FRAMES);
  framesReceived++;
  device = { ...device, deviceId: frame.dev, firmware: frame.fw, lastFrameAt: stamped.at };
  broadcast('frame', stamped);

  // rig rules over the last 60 s
  const cutoff = Date.now() - 60_000;
  const window = frames.filter((f) => Date.parse(f.at) >= cutoff);
  try {
    const fresh = diagnose(window, store.events.slice(-50), stamped.at);
    for (const ev of fresh) { store.events.push(ev); broadcast('rig_event', ev); }
    // confirm earlier fixes (flap closed → top inlet recovered; valve closed → reservoir stopped dropping)
    const confirmed = followUp(window, store.events.slice(-50));
    for (const ev of confirmed) {
      const i = store.events.findIndex((x) => x.id === ev.id);
      if (i >= 0) store.events[i] = ev;
      broadcast('rig_event', ev);
    }
    if (fresh.length || confirmed.length) { store.events = store.events.slice(-500); save(); }
  } catch (e) { console.error('[bridge] diagnose failed', e); }
}

function isFrame(x: unknown): x is RigFrame {
  const f = x as RigFrame;
  return !!f && f.v === 1 && typeof f.dev === 'string' && typeof f.seq === 'number' && Array.isArray(f.flags);
}

// ---------------------------------------------------------------- device

async function findArduino(): Promise<string | null> {
  if (process.env.RACKMON_PORT) return process.env.RACKMON_PORT;
  const ports = await SerialPort.list();
  const hit = ports.find((p) => p.vendorId?.toLowerCase() === '2341' || /arduino/i.test(p.manufacturer ?? ''));
  return hit?.path ?? null;
}

function startSim() {
  if (sim || SIM_MODE === '0') return;
  sim = new SimRig(7);
  device = { ...device, mode: 'simulated', port: null };
  simTimer = setInterval(() => ingest(sim!.tick(1), 'simulated'), 1000);
  console.log('[bridge] no Rack Monitor found — running the SIMULATED rig (frames are labeled "simulated")');
  broadcast('status', status());
}
function stopSim() {
  if (simTimer) clearInterval(simTimer);
  simTimer = null; sim = null;
}

async function connectSerial(path: string) {
  stopSim();
  const port = new SerialPort({ path, baudRate: BAUD });
  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
  serial = port;
  device = { ...device, mode: 'serial', port: path };
  console.log(`[bridge] Rack Monitor on ${path} @ ${BAUD}`);
  parser.on('data', (line: string) => {
    const s = line.trim();
    if (!s.startsWith('{')) { if (s) console.log('[rig]', s); return; }
    try {
      const obj = JSON.parse(s);
      if (isFrame(obj)) ingest(obj, 'live'); else badLines++;
    } catch { badLines++; }
  });
  port.on('close', () => {
    console.log('[bridge] serial closed');
    serial = null;
    device = { ...device, mode: 'disconnected', port: null };
    broadcast('status', status());
    if (SIM_MODE !== '0') startSim();
  });
  port.on('error', (e) => console.error('[bridge] serial error', e.message));
  broadcast('status', status());
}

async function watchDevice() {
  if (SIM_MODE === '1') { startSim(); return; }
  const tick = async () => {
    if (serial) return;
    try {
      const path = await findArduino();
      if (path) await connectSerial(path);
      else startSim();
    } catch (e) { console.error('[bridge] device scan failed', (e as Error).message); startSim(); }
  };
  await tick();
  setInterval(tick, 5000); // hot-plug: switch from sim to the real rig when it appears
}

const RIG_CMD = /^(flap (open|close)|valve (open|close)|fan \d{1,3} \d{1,3}|auto (on|off)|cal|ping)$/;
const SIM_CMD = /^sim (power (off|on)|fault (inlet_top|clear)|heat (high|normal)|fan_a (fail|ok)|block outlet|unblock|supply (loss|ok)|leak (remote|stop)|spill|dry)$/;

function sendCommand(raw: string): { ok: boolean; reply: string } {
  const cmd = raw.trim().toLowerCase();
  if (SIM_CMD.test(cmd)) {
    if (!sim) return { ok: false, reply: 'sim commands only work on the simulated rig' };
    return { ok: true, reply: sim.command(cmd) };
  }
  if (!RIG_CMD.test(cmd)) return { ok: false, reply: 'unknown command' };
  if (serial) { serial.write(cmd + '\n'); return { ok: true, reply: `sent "${cmd}" to ${device.port}` }; }
  if (sim) return { ok: true, reply: sim.command(cmd) };
  return { ok: false, reply: 'no device' };
}

// ----------------------------------------------------------------- scans

function finishScan(id: string, reason: 'released' | 'auto'): Scan | null {
  if (!active || active.id !== id) return null;
  const a = active;
  clearTimeout(a.autoStop);
  active = null;
  const endedAt = new Date().toISOString();
  const window = frames.filter((f) => f.at >= a.startedAt && f.at <= endedAt);
  const scan = summarizeScan(window, {
    id: a.id, point: { assetId: a.assetId, point: a.point }, operator: a.operator,
    deviceId: device.deviceId ?? 'unknown', firmware: device.firmware ?? 'unknown',
    startedAt: a.startedAt, endedAt, requestId: a.requestId,
  });
  if (sim) for (const c of workflow.simulatedTruth(a.assetId)?.after ?? []) sim.command(c);
  if (reason === 'auto' && scan.status === 'complete') scan.quality = [...scan.quality, 'auto_completed'];
  if (scan.status === 'complete') {
    store.scans.push(scan);
    store.scans = store.scans.slice(-300);
    const req = a.requestId ? store.requests.find((r) => r.id === a.requestId) : undefined;
    if (req) { req.status = 'done'; req.scanId = scan.id; broadcast('request', req); }
    save();
    broadcast('scan', scan);
    hub.onScan(scan).catch((e) => console.error('[bridge] auto re-plan failed', e));
  }
  broadcast('status', status());
  return scan;
}

// -------------------------------------------------------- requests + agent

function createRequest(b: { assetId: string; point: string; reason: string; incidentId?: string; taskId?: string; requestedBy: string }): ScanRequest {
  const dup = store.requests.find((r) => r.status === 'open' && r.assetId === b.assetId && r.point === b.point);
  if (dup) return dup;
  const r: ScanRequest = { id: `REQ-${randomUUID().slice(0, 6)}`, createdAt: new Date().toISOString(), requestedBy: b.requestedBy, reason: b.reason, assetId: b.assetId, point: b.point, incidentId: b.incidentId, taskId: b.taskId, status: 'open' };
  store.requests.push(r); save(); broadcast('request', r);
  return r;
}

const hub = createAgentHub({
  broadcast,
  latestFrame: () => frames.at(-1) ?? null,
  recentEvents: () => store.events.slice(-10),
  deviceMode: () => device.mode,
  createRequest,
  sendCommand: (cmd) => sendCommand(cmd),
  actions: store.actions,
  save,
  env: process.env,
});

// ----------------------------------------------------------------- stage

const stage = createStageHub({
  initial: store.stage,
  save: (st) => { store.stage = st; save(); },
  broadcast: (payload) => broadcast('stage', payload),
  screens: () => clients.size,
});

const phonePayload = () => phoneSummary(stage.get(), Date.now(), {
  latestFrame: () => frames.at(-1) ?? null,
  deviceMode: () => device.mode,
  director: { configured: !!process.env.NVIDIA_API_KEY, model: process.env.NEMOTRON_MODEL || DEFAULT_MODEL },
});

const workflow = createWorkflowHub({
  initial: store.workflow,
  save: (s) => { store.workflow = s; save(); broadcast('workflow', { revision: s.revision }); },
  latest: () => frames.at(-1) ?? null,
  scans: () => store.scans,
  plan: async (input) => (await hub.plan(input)).result,
});

// ------------------------------------------------------------------ http

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readBody(req: http.IncomingMessage, limit = 256_000): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) { size += (c as Buffer).length; if (size > limit) throw new Error('body too large'); chunks.push(c as Buffer); }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const str = (v: unknown, max = 120) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`);
      clients.add(res);
      res.write(`event: hello\ndata: ${JSON.stringify({ frames: frames.slice(-120), scans: store.scans.slice(-30), requests: store.requests.filter((r) => r.status === 'open'), events: store.events.slice(-20), actions: store.actions.slice(-20), director: hub.latest(), stage: stage.payload() })}\n\n`);
      stage.announce(); // screen count changed
      const ka = setInterval(() => res.write(': ka\n\n'), 15000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); stage.announce(); });
      return;
    }
    if (req.method === 'GET' && p === '/api/workflow') return json(res, 200, workflow.snapshot());
    if (req.method === 'POST' && p === '/api/workflow') {
      try { await workflow.command(await readBody(req, 16_000)); return json(res, 200, workflow.snapshot()); }
      catch (e) { return json(res, 400, { error: (e as Error).message }); }
    }
    if (req.method === 'GET' && p === '/api/status') return json(res, 200, { ...status(), badLines });
    if (req.method === 'GET' && p === '/api/frames') return json(res, 200, frames.slice(-Math.min(900, Number(url.searchParams.get('n') ?? 120))));
    if (req.method === 'GET' && p === '/api/scans') return json(res, 200, store.scans.slice(-100));
    if (req.method === 'GET' && p === '/api/events') return json(res, 200, store.events.slice(-100));
    if (req.method === 'GET' && p === '/api/requests') return json(res, 200, store.requests.filter((r) => r.status === 'open'));

    if (req.method === 'POST' && p === '/api/scans/start') {
      const b = await readBody(req);
      const assetId = str(b.assetId, 24), point = str(b.point), operator = str(b.operator, 60) ?? 'unknown';
      if (!assetId || !point) return json(res, 400, { error: 'assetId and point are required' });
      if (active) {
        const age = (Date.now() - Date.parse(active.startedAt)) / 1000;
        if (age < TARGET_HOLD_S + 5) return json(res, 409, { error: `scan ${active.id} already running` });
        finishScan(active.id, 'auto');
      }
      if (!device.lastFrameAt || Date.now() - Date.parse(device.lastFrameAt) > 5000) return json(res, 503, { error: 'no recent frames from the rig' });
      const id = `SCN-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}-${randomUUID().slice(0, 4)}`;
      const startedAt = new Date().toISOString();
      // server-side cap: the scan completes at TARGET_HOLD_S even if the client never releases
      const autoStop = setTimeout(() => finishScan(id, 'auto'), (TARGET_HOLD_S + 0.5) * 1000);
      active = { id, assetId, point, operator, requestId: str(b.requestId, 60) ?? undefined, startedAt, autoStop };
      // simulated device only: respond to the scanned asset's injected demo incident (audit C4)
      if (sim) for (const c of workflow.simulatedTruth(assetId)?.before ?? []) sim.command(c);
      broadcast('status', status());
      return json(res, 200, { id, startedAt, minHoldS: MIN_HOLD_S, targetHoldS: TARGET_HOLD_S });
    }
    const stop = p.match(/^\/api\/scans\/([\w-]+)\/stop$/);
    if (req.method === 'POST' && stop) {
      const scan = finishScan(stop[1], 'released');
      if (!scan) {
        const done = store.scans.find((s) => s.id === stop[1]);
        return done ? json(res, 200, done) : json(res, 404, { error: 'no such running scan' });
      }
      return json(res, 200, scan);
    }

    if (req.method === 'POST' && p === '/api/requests') {
      const b = await readBody(req);
      const assetId = str(b.assetId, 24), point = str(b.point), reason = str(b.reason, 400);
      if (!assetId || !point || !reason) return json(res, 400, { error: 'assetId, point and reason are required' });
      return json(res, 200, createRequest({ assetId, point, reason, requestedBy: str(b.requestedBy, 60) ?? 'dashboard', incidentId: str(b.incidentId, 24) ?? undefined, taskId: str(b.taskId, 24) ?? undefined }));
    }
    const cancel = p.match(/^\/api\/requests\/([\w-]+)\/cancel$/);
    if (req.method === 'POST' && cancel) {
      const r = store.requests.find((x) => x.id === cancel[1]);
      if (!r) return json(res, 404, { error: 'not found' });
      r.status = 'cancelled'; save(); broadcast('request', r);
      return json(res, 200, r);
    }

    if (req.method === 'POST' && p === '/api/rig/command') {
      const b = await readBody(req);
      const r = sendCommand(String(b.cmd ?? ''));
      return json(res, r.ok ? 200 : 400, r);
    }

    if (req.method === 'POST' && p === '/api/director') {
      const b = await readBody(req, 1_000_000);
      const rec = await hub.plan({
        scenarioId: String(b.scenarioId ?? 'scn-riser-leak'), t: Number(b.t ?? 0),
        incidents: Array.isArray(b.incidents) ? b.incidents : [],
        scans: Array.isArray(b.scans) ? b.scans : store.scans.slice(-20),
        confirmedEdgeIds: Array.isArray(b.confirmedEdgeIds) ? b.confirmedEdgeIds : [],
        question: str(b.question, 500) ?? undefined,
      });
      return json(res, 200, { ...rec.result, recordId: rec.id, chainId: rec.chainId });
    }
    if (req.method === 'GET' && p === '/api/stage') return json(res, 200, stage.payload());
    if (req.method === 'POST' && p === '/api/stage') {
      const b = await readBody(req, 16_000);
      const r = stage.command(b.cmd);
      return r.ok ? json(res, 200, r.payload) : json(res, 400, { error: r.error });
    }
    // ---- native iPhone app (ios/): one compact payload; the engine runs here
    if (req.method === 'GET' && p === '/api/phone') return json(res, 200, phonePayload());
    if (req.method === 'POST' && p === '/api/phone/random') {
      const r = stage.command(phoneRandomCommand());
      return r.ok ? json(res, 200, phonePayload()) : json(res, 400, { error: r.error });
    }
    if (req.method === 'POST' && p === '/api/phone/fix') {
      const b = await readBody(req, 4_000);
      const c = phoneFixCommand(stage.get(), Date.now(), b);
      if (!c.ok) return json(res, 400, { error: c.error });
      const r = stage.command(c.cmd);
      return r.ok ? json(res, 200, phonePayload()) : json(res, 400, { error: r.error });
    }
    if (req.method === 'GET' && p === '/api/director/latest') return json(res, 200, hub.latest());
    if (req.method === 'GET' && p === '/api/actions') return json(res, 200, store.actions.slice(-50));
    const decide = p.match(/^\/api\/actions\/([\w-]+)\/(approve|reject)$/);
    if (req.method === 'POST' && decide) {
      const b = await readBody(req);
      const a = await hub.decide(decide[1], decide[2] as 'approve' | 'reject', str(b.by, 60) ?? 'operator');
      return a ? json(res, 200, a) : json(res, 404, { error: 'no such action' });
    }

    if (req.method === 'POST' && p === '/api/reset') {
      store.scans = []; store.requests = []; store.events = []; store.actions.length = 0; save();
      broadcast('hello', { frames: frames.slice(-120), scans: [], requests: [], events: [] });
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[bridge]', p, e);
    json(res, 500, { error: (e as Error).message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[bridge] http://${HOST}:${PORT}  (SSE /api/stream)  nemotron=${process.env.NVIDIA_API_KEY ? 'configured' : 'not configured → local planner'}`);
  void watchDevice();
});
if (!existsSync(dirname(DATA_FILE))) mkdirSync(dirname(DATA_FILE), { recursive: true });
