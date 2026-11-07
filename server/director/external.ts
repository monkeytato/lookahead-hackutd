/**
 * External tools for the simulation director: everything that reaches OUTSIDE the deterministic engine.
 *
 *   get_weather          → api.weather.gov (US National Weather Service, public, no key)
 *   get_rig_status       → the Rack Monitor on USB, through the bridge (live or simulated rig, labeled)
 *   request_scan         → the scan queue on technicians' phones (low risk: a person still takes the scan)
 *   propose_rig_action   → approval queue. Safe-direction commands only; nothing runs until a person approves
 *   open_ticket          → approval queue → GitHub Issues on approval (or a local record if not configured)
 *
 * The model never gets raw network access: each tool is a fixed, validated request. Results are data,
 * never instructions. Weather is context only — the cascade engine does not consume it.
 */
import type { ScanRequest, RigEvent, StampedFrame } from '../../src/domain/rig/protocol';
import { facility } from '../../src/domain/fixture';
import { ToolError, cleanText, type Session, type ToolOutcome } from './tools';
import type { ExternalService, PendingAction } from './types';

export type HttpLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** What the bridge provides to the director. Tests pass fakes. */
export interface ExternalServices {
  http?: HttpLike;
  rigStatus(): { frame: StampedFrame | null; events: RigEvent[]; mode: string } | null;
  requestScan(r: { assetId: string; point: string; reason: string; incidentId?: string; requestedBy: string }): ScanRequest;
  proposeAction(a: Omit<PendingAction, 'id' | 'createdAt' | 'status'>): PendingAction;
  /** Already-proposed actions (to avoid duplicates) */
  pendingActions(): PendingAction[];
  ticketsConfigured: boolean;
}

/** Demo site location: the HackUTD venue, Richardson TX (the facility itself is simulated). */
export const SITE = { name: 'DAL-1 (simulated) · Richardson, TX', lat: 32.9857, lon: -96.7502 };
const UA = 'Lookahead-HackUTD-prototype (github.com/monkeytato/lookahead-hackutd)';

/** Commands the director may propose. Only directions that reduce risk; never open a valve or disarm safety. */
export const SAFE_RIG_COMMANDS = /^(valve close|flap close|auto on|fan (\d{1,2}|70) (\d{1,2}|70))$/;

export const EXTERNAL_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: `Hourly outdoor forecast for the site (${SITE.name}) from the US National Weather Service (api.weather.gov). Context for cooling-plant risk (heat reduces chiller / dry-cooler margin; storms raise utility-loss and roof-water risk). The engine does not use weather — never turn it into clock numbers.`,
      parameters: { type: 'object', properties: { hours: { type: 'number', description: '1–24, default 6' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_rig_status',
      description: 'Latest frame and recent root-cause events from the Rack Monitor rig on USB (acoustic inlet/outlet temperatures, reference probe, reservoir and floor water, pack voltage, flap/valve state, firmware flags). Use it to check whether the rig is trustworthy (sensor_fault, ref_disagree) before relying on a scan.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_scan',
      description: 'Queue a scan on the technicians\' scanner app (they place the rig and hold for 10 s). Low risk: a person still performs it. Call this for the scan you recommend, before recommend. When the result arrives you will be re-run automatically with the new evidence.',
      parameters: { type: 'object', properties: { assetId: { type: 'string' }, point: { type: 'string' }, reason: { type: 'string' }, incidentId: { type: 'string' } }, required: ['assetId', 'point', 'reason'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_rig_action',
      description: 'Propose a command to the Rack Monitor rig. It is NOT executed: it waits for a person to approve it on the dashboard. Allowed: "valve close", "flap close", "auto on", "fan A B" (0–70 %). Only propose after evidence supports it (e.g. a wet floor scan with the valve open).',
      parameters: { type: 'object', properties: { cmd: { type: 'string' }, reason: { type: 'string' }, incidentId: { type: 'string' } }, required: ['cmd', 'reason'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_ticket',
      description: 'Propose a facilities/IT ticket for an incident (GitHub Issues). It waits for human approval before it is created. Use for corroborated, critical incidents that need follow-up beyond this shift. Body must cite run ids / scan ids for any numbers.',
      parameters: { type: 'object', properties: { incidentId: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'warning', 'advisory'] } }, required: ['incidentId', 'title', 'body'] },
    },
  },
] as const;

export const EXTERNAL_TOOL_NAMES: string[] = EXTERNAL_TOOL_DEFS.map((t) => t.function.name);

// ------------------------------------------------------------------ weather

interface WeatherSummary {
  site: string; source: string; fetchedAt: string;
  hours: { start: string; tempC: number; rh: number | null; forecast: string }[];
  maxTempC: number; minTempC: number;
  note: string;
}
let weatherCache: { at: number; data: WeatherSummary } | null = null;
const WEATHER_TTL_MS = 15 * 60_000;

async function httpJson(http: HttpLike, url: string, timeoutMs = 6000): Promise<any> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await http(url, { method: 'GET', headers: { 'User-Agent': UA, Accept: 'application/geo+json' }, signal: ac.signal });
    const text = await r.text();
    if (!r.ok) throw new ToolError(`${new URL(url).host} HTTP ${r.status}`);
    return JSON.parse(text);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(`${new URL(url).host} unreachable: ${(e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message}`);
  } finally { clearTimeout(timer); }
}

export async function fetchWeather(http: HttpLike, hours = 6): Promise<WeatherSummary> {
  if (weatherCache && Date.now() - weatherCache.at < WEATHER_TTL_MS) return { ...weatherCache.data, hours: weatherCache.data.hours.slice(0, hours) };
  const point = await httpJson(http, `https://api.weather.gov/points/${SITE.lat},${SITE.lon}`);
  const hourlyUrl = point?.properties?.forecastHourly;
  if (typeof hourlyUrl !== 'string' || !hourlyUrl.startsWith('https://api.weather.gov/')) throw new ToolError('api.weather.gov returned no hourly forecast URL');
  const fc = await httpJson(http, hourlyUrl);
  const periods: any[] = Array.isArray(fc?.properties?.periods) ? fc.properties.periods.slice(0, 24) : [];
  if (!periods.length) throw new ToolError('api.weather.gov returned no forecast periods');
  const toC = (v: number, unit: string) => +(unit === 'F' ? (v - 32) * 5 / 9 : v).toFixed(1);
  const all = periods.map((p) => ({ start: String(p.startTime), tempC: toC(Number(p.temperature), String(p.temperatureUnit)), rh: typeof p.relativeHumidity?.value === 'number' ? p.relativeHumidity.value : null, forecast: String(p.shortForecast ?? '').slice(0, 60) }));
  const temps = all.map((h) => h.tempC);
  const data: WeatherSummary = {
    site: SITE.name, source: 'api.weather.gov (NWS hourly forecast)', fetchedAt: new Date().toISOString(),
    hours: all, maxTempC: Math.max(...temps), minTempC: Math.min(...temps),
    note: Math.max(...temps) >= 35 ? 'Heat ahead: reduced chiller/dry-cooler margin — weight cooling what-ifs higher.' : /thunder|storm/i.test(all.map((h) => h.forecast).join(' ')) ? 'Storms in the forecast: utility-loss and roof-water risk up.' : 'No weather stress on the cooling plant in this window.',
  };
  weatherCache = { at: Date.now(), data };
  return { ...data, hours: data.hours.slice(0, hours) };
}

export const resetWeatherCache = () => { weatherCache = null; };

// ----------------------------------------------------------------- dispatch

const assetIds = new Set(facility.assets.map((a) => a.id));
const svc = (out: ToolOutcome, service: ExternalService): ToolOutcome & { service: ExternalService } => ({ ...out, service });

/**
 * Handle an external tool. Returns null for names that are not external (the caller then uses the
 * engine dispatcher). Never throws: failures become tool errors the model can react to.
 */
export async function dispatchExternal(session: Session, ext: ExternalServices | undefined, name: string, rawArgs: unknown, proposedBy: string): Promise<(ToolOutcome & { service: ExternalService }) | null> {
  if (!EXTERNAL_TOOL_NAMES.includes(name)) return null;
  const service: ExternalService = name === 'get_weather' ? 'api.weather.gov' : name === 'get_rig_status' ? 'rack-monitor' : name === 'request_scan' ? 'scan-queue' : name === 'open_ticket' ? 'github' : 'approval-queue';
  if (!ext) return svc({ ok: false, content: { error: 'external services are not connected in this run' }, summary: `rejected: ${name} unavailable` }, service);
  let args: Record<string, unknown> = {};
  if (typeof rawArgs === 'string') {
    try { args = rawArgs.trim() ? JSON.parse(rawArgs) : {}; } catch { return svc({ ok: false, invalidJson: true, content: { error: 'arguments are not valid JSON' }, summary: `rejected: invalid JSON arguments for ${name}` }, service); }
  } else if (rawArgs && typeof rawArgs === 'object') args = rawArgs as Record<string, unknown>;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return svc({ ok: false, invalidJson: true, content: { error: 'arguments must be a JSON object' }, summary: 'rejected: arguments not an object' }, service);
  const incidentOk = (v: unknown) => v === undefined || (typeof v === 'string' && session.incidents.some((i) => i.id === v));

  try {
    switch (name) {
      case 'get_weather': {
        if (!ext.http) throw new ToolError('no HTTP client');
        const hours = Math.max(1, Math.min(24, Math.round(Number(args.hours ?? 6)) || 6));
        const w = await fetchWeather(ext.http, hours);
        return svc({ ok: true, content: w, summary: `NWS forecast ${w.site}: ${w.minTempC}–${w.maxTempC} °C next ${w.hours.length} h, "${w.hours[0]?.forecast ?? ''}" — ${w.note}` }, service);
      }
      case 'get_rig_status': {
        const st = ext.rigStatus();
        if (!st || !st.frame) throw new ToolError('no recent frame from the Rack Monitor');
        const f = st.frame;
        const content = {
          source: f.source, mode: st.mode, device: f.dev, firmware: f.fw, at: f.at,
          inlet_top_c: f.inlet_top_c, inlet_bottom_c: f.inlet_bottom_c, outlet_c: f.outlet_c, ref_c: f.ref_c,
          reservoir_raw: f.reservoir_raw, floor_raw: f.floor_raw, pack_v: f.pack_v, flap: f.flap, valve: f.valve, fan_pct: f.fan_pct, auto: f.auto, flags: f.flags,
          recentEvents: st.events.slice(-5).map((e) => ({ kind: e.kind, confidence: e.confidence, rootCause: e.rootCause, route: e.route, at: e.at })),
          trust: f.flags.some((x) => /ref_disagree|timeout|obstructed|uncalibrated/.test(x)) ? 'check the rig before trusting its scans' : 'rig self-checks clear',
        };
        return svc({ ok: true, content, summary: `${f.source === 'live' ? 'LIVE' : 'SIMULATED'} rig ${f.dev}: inlet ${f.inlet_bottom_c ?? '—'} °C, floor ${f.floor_raw >= 120 ? 'wet' : 'dry'}, valve ${f.valve}, flags ${f.flags.join(', ') || 'none'}; ${content.trust}` }, service);
      }
      case 'request_scan': {
        const assetId = typeof args.assetId === 'string' ? args.assetId : '';
        if (!assetIds.has(assetId)) throw new ToolError(`unknown asset id ${JSON.stringify(args.assetId)}`);
        const point = cleanText(args.point, 120); const reason = cleanText(args.reason, 400);
        if (!point || !reason) throw new ToolError('point and reason are required');
        if (!incidentOk(args.incidentId)) throw new ToolError(`unknown incident id ${JSON.stringify(args.incidentId)}`);
        const req = ext.requestScan({ assetId, point, reason, incidentId: args.incidentId as string | undefined, requestedBy: proposedBy });
        return svc({ ok: true, content: { queued: true, requestId: req.id, status: req.status }, summary: `queued ${req.id} on the scanner: ${assetId} — ${point}` }, service);
      }
      case 'propose_rig_action': {
        const cmd = String(args.cmd ?? '').trim().toLowerCase();
        if (!SAFE_RIG_COMMANDS.test(cmd)) throw new ToolError(`"${cmd.slice(0, 40)}" is not allowed. The director may only propose: valve close, flap close, auto on, fan A B (0–70)`);
        const reason = cleanText(args.reason, 400);
        if (!reason) throw new ToolError('reason is required');
        if (!incidentOk(args.incidentId)) throw new ToolError(`unknown incident id ${JSON.stringify(args.incidentId)}`);
        const dup = ext.pendingActions().find((a) => a.status === 'pending' && a.kind === 'rig_command' && (a.payload as { cmd: string }).cmd === cmd);
        if (dup) return svc({ ok: true, content: { pendingApproval: true, actionId: dup.id, duplicate: true }, summary: `already awaiting approval: ${dup.id} "${cmd}"` }, service);
        const a = ext.proposeAction({ kind: 'rig_command', proposedBy, reason, incidentId: args.incidentId as string | undefined, payload: { cmd } });
        return svc({ ok: true, content: { pendingApproval: true, actionId: a.id, note: 'Not executed. A person must approve it on the dashboard.' }, summary: `proposed "${cmd}" → awaiting human approval (${a.id})` }, service);
      }
      case 'open_ticket': {
        if (!incidentOk(args.incidentId) || typeof args.incidentId !== 'string') throw new ToolError(`unknown incident id ${JSON.stringify(args.incidentId)}`);
        const title = cleanText(args.title, 120); const body = cleanText(args.body, 3000);
        if (!title || !body) throw new ToolError('title and body are required');
        const dup = ext.pendingActions().find((a) => a.kind === 'ticket' && a.incidentId === args.incidentId && a.status !== 'rejected' && a.status !== 'failed');
        if (dup) return svc({ ok: true, content: { actionId: dup.id, status: dup.status, duplicate: true }, summary: `ticket for ${args.incidentId} already ${dup.status} (${dup.id})` }, service);
        const severity = ['critical', 'warning', 'advisory'].includes(String(args.severity)) ? String(args.severity) : 'warning';
        const a = ext.proposeAction({ kind: 'ticket', proposedBy, reason: `Ticket for ${args.incidentId}`, incidentId: args.incidentId, payload: { title, body, labels: ['lookahead', `severity:${severity}`, args.incidentId] } });
        return svc({ ok: true, content: { pendingApproval: true, actionId: a.id, destination: ext.ticketsConfigured ? 'GitHub Issues' : 'local record (GITHUB_TOKEN / TICKET_REPO not set)' }, summary: `drafted ticket "${title.slice(0, 60)}" → awaiting human approval (${a.id})` }, service);
      }
    }
  } catch (e) {
    if (e instanceof ToolError) return svc({ ok: false, content: { error: e.message }, summary: `rejected: ${e.message.slice(0, 160)}` }, service);
    throw e;
  }
  return null;
}

// ------------------------------------------------------------------ tickets

/** Create a GitHub issue. Only called by the bridge AFTER a person approves the action. */
export async function createGithubIssue(http: HttpLike, env: Record<string, string | undefined>, payload: { title: string; body: string; labels: string[] }): Promise<{ url: string }> {
  const token = env.GITHUB_TOKEN?.trim(); const repo = env.TICKET_REPO?.trim();
  if (!token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_TOKEN / TICKET_REPO not configured');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const r = await http(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST', signal: ac.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': UA, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`GitHub HTTP ${r.status}: ${text.slice(0, 160)}`);
    return { url: String(JSON.parse(text).html_url ?? '') };
  } finally { clearTimeout(timer); }
}
