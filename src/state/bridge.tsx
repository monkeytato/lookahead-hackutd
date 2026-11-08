/**
 * Client for the Lookahead bridge (server/index.ts). One EventSource per tab.
 * When the bridge is not running the app keeps working on fixtures and says "Bridge offline".
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BridgeStatus, RigEvent, Scan, ScanRequest, StampedFrame } from '../domain/rig/protocol';
import type { DirectorRecordView, PendingActionView } from '../views/directorTypes';
import { getLocalBridge } from './localBridge';

/** Static demo build (claude.ai artifact): no server, so an in-page bridge stands in. */
export const LOCAL_BRIDGE = import.meta.env.VITE_LOCAL_BRIDGE === '1';

export interface BridgeState {
  online: boolean;
  status: BridgeStatus | null;
  frames: StampedFrame[];
  latest: StampedFrame | null;
  scans: Scan[];
  requests: ScanRequest[];
  events: RigEvent[];
  /** Hardware commands / tickets the director proposed, awaiting (or past) human approval */
  actions: PendingActionView[];
  /** Director plans, newest last — includes automatic re-plans after requested scans */
  plans: DirectorRecordView[];
  /** A re-plan is running on the bridge right now */
  replanning: { chainId: string; generation: number; trigger: string } | null;
}

const empty: BridgeState = { online: false, status: null, frames: [], latest: null, scans: [], requests: [], events: [], actions: [], plans: [], replanning: null };
const Ctx = createContext<BridgeState>(empty);
const KEEP = 180;

export function BridgeProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState<BridgeState>(empty);
  const retry = useRef(0);

  useEffect(() => {
    let es: EventSource | null = null;
    let timer: number | undefined;
    let closed = false;
    let lastMsg = Date.now();
    const seen = () => { lastMsg = Date.now(); };
    // One handler per bridge event, shared by the real SSE stream and the in-page stand-in.
    const on: Record<string, (d: any) => void> = {
      status: (d) => setS((p) => ({ ...p, online: true, status: d })),
      hello: (d) => setS((p) => ({ ...p, online: true, frames: d.frames, latest: d.frames.at(-1) ?? null, scans: d.scans, requests: d.requests, events: d.events, actions: d.actions ?? [], plans: d.director && !p.plans.some((x) => x.id === d.director.id) ? [...p.plans, d.director] : p.plans })),
      frame: (f: StampedFrame) => setS((p) => ({ ...p, latest: f, frames: [...p.frames.slice(-(KEEP - 1)), f] })),
      scan: (sc: Scan) => setS((p) => ({ ...p, scans: [...p.scans.filter((x) => x.id !== sc.id), sc].slice(-60) })),
      request: (r: ScanRequest) => setS((p) => ({ ...p, requests: [...p.requests.filter((x) => x.id !== r.id), r].filter((x) => x.status === 'open') })),
      rig_event: (ev: RigEvent) => setS((p) => ({ ...p, events: p.events.some((x) => x.id === ev.id) ? p.events.map((x) => (x.id === ev.id ? ev : x)) : [...p.events, ev].slice(-50) })),
      action: (a: PendingActionView) => setS((p) => ({ ...p, actions: [...p.actions.filter((x) => x.id !== a.id), a].slice(-30) })),
      director: (r: DirectorRecordView) => setS((p) => ({ ...p, replanning: null, plans: [...p.plans.filter((x) => x.id !== r.id), r].slice(-12) })),
      director_pending: (d) => setS((p) => ({ ...p, replanning: d })),
    };
    if (LOCAL_BRIDGE) {
      const unsub = getLocalBridge().subscribe((event, data) => on[event]?.(data));
      return unsub;
    }
    const connect = () => {
      lastMsg = Date.now();
      es = new EventSource('/api/stream');
      es.addEventListener('open', () => { retry.current = 0; setS((p) => ({ ...p, online: true })); });
      for (const k of Object.keys(on)) es.addEventListener(k, (e) => { seen(); on[k](JSON.parse((e as MessageEvent).data)); });
      es.onerror = () => {
        es?.close();
        setS((p) => ({ ...p, online: false }));
        if (closed) return;
        retry.current = Math.min(retry.current + 1, 5);
        timer = window.setTimeout(connect, 1000 * retry.current);
      };
    };
    connect();
    // watchdog: frames arrive every second; a silent stream is a half-open proxy socket (e.g. the
    // bridge restarted, or the phone changed networks) — drop it and reconnect.
    const dog = window.setInterval(() => {
      if (!closed && es && Date.now() - lastMsg > 6000) { es.close(); setS((p) => ({ ...p, online: false })); connect(); }
    }, 2000);
    return () => { closed = true; es?.close(); window.clearTimeout(timer); window.clearInterval(dog); };
  }, []);

  return <Ctx.Provider value={s}>{children}</Ctx.Provider>;
}

export const useBridge = () => useContext(Ctx);

/** Age of the latest frame in seconds, re-rendering once a second. */
export function useFrameAge(latest: StampedFrame | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(id); }, []);
  return useMemo(() => (latest ? Math.max(0, (now - Date.parse(latest.at)) / 1000) : null), [latest, now]);
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  if (LOCAL_BRIDGE) {
    const r = await getLocalBridge().request(body === undefined ? 'GET' : 'POST', path, body);
    const d = r.body as { error?: string; reply?: string };
    if (r.status >= 400) throw new Error(d.error ?? d.reply ?? `HTTP ${r.status}`);
    return r.body as T;
  }
  const r = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string; reply?: string }).error ?? (data as { reply?: string }).reply ?? `HTTP ${r.status}`);
  return data as T;
}

export function deviceLabel(st: BridgeStatus | null, online: boolean): { text: string; kind: 'live' | 'sim' | 'off' } {
  if (!online || !st) return { text: 'Bridge offline', kind: 'off' };
  if (st.device.mode === 'serial') return { text: `LIVE · ${st.device.deviceId ?? 'Rack Monitor'} · ${st.device.port}`, kind: 'live' };
  if (st.device.mode === 'simulated') return { text: `SIMULATED RIG · ${st.device.deviceId ?? ''}`.trim(), kind: 'sim' };
  return { text: 'No device', kind: 'off' };
}
