/**
 * Stage: the shared presentation state every screen follows (laptop/projector, phone remote,
 * desktop workspace). Commands from ANY screen go through `applyStageCommand`; the result is an
 * absolute state, so a late joiner or a dropped message never leaves a screen out of step.
 *
 * Time is not streamed: a state carries an anchor (`t0` at wall time `at`) and a speed, and every
 * screen computes the current scenario minute itself with `stageTime`.
 *
 * Transports (src/stage/transport.ts): bridge (POST /api/stage + SSE "stage"), claude.ai artifact
 * (room for live messages + a db doc for late joiners), or same-browser only (BroadcastChannel).
 */
import type { Fix, ID } from '../domain/types';

/** Scenario minutes advanced per wall second at speed 1 (the old player did 0.5 min / 200 ms). */
export const MIN_PER_SEC = 1; // 60-minute scenario ≈ 1 minute at 1×: slow enough to narrate and order fixes
export const SPEEDS = [0.5, 1, 2, 4] as const;

export interface StageState {
  /** Increases on every command; transports keep the highest */
  rev: number;
  /** Changes when a new run starts (scenario switch or reset): screens clear their operator records */
  epoch: number;
  scenarioId: ID;
  fixes: Fix[];
  playing: boolean;
  /** Scenario minute at wall time `at` (ms since epoch, sender's clock) */
  t0: number;
  at: number;
  speed: number;
  /** "Show prediction": the 3D twin and clocks preview this many minutes ahead (0 = off) */
  lookaheadMin: number;
  /** Camera / inspector focus requested by the presenter */
  focusAssetId: ID | null;
  /** Pause every screen when a new incident opens, so the presenter can explain and order a fix */
  autoPause: boolean;
  /** Short note of the last command, for the remote's status line ("Fix ordered: close riser valve") */
  last: string;
}

export type StageCommand =
  | { type: 'scenario'; scenarioId: ID; autoplay?: boolean }
  | { type: 'play' }
  | { type: 'pause'; reason?: string }
  | { type: 'autopause'; on: boolean }
  | { type: 'seek'; t: number }
  | { type: 'jump'; dt: number }
  | { type: 'speed'; speed: number }
  | { type: 'fix'; fix: Fix }
  | { type: 'unfix'; fixId: ID }
  | { type: 'lookahead'; min: number }
  | { type: 'focus'; assetId: ID | null }
  | { type: 'reset' };

export function initialStage(scenarioId: ID, now = Date.now()): StageState {
  return { rev: 0, epoch: 0, scenarioId, fixes: [], playing: false, t0: 0, at: now, speed: 1, lookaheadMin: 0, focusAssetId: null, autoPause: true, last: 'Ready' };
}

/** Current scenario minute (0.1 min resolution), clamped to [0, horizon]. */
export function stageTime(s: StageState, horizonMin: number, now = Date.now()): number {
  const t = s.playing ? s.t0 + ((now - s.at) / 1000) * MIN_PER_SEC * s.speed : s.t0;
  return Math.round(Math.min(horizonMin, Math.max(0, t)) * 10) / 10;
}

/** Pure reducer shared by the bridge, the artifact transport and the local fallback. */
export function applyStageCommand(s: StageState, cmd: StageCommand, horizonMin: number, now = Date.now()): StageState {
  const t = stageTime(s, horizonMin, now);
  const base = { ...s, rev: s.rev + 1 };
  switch (cmd.type) {
    case 'scenario':
      return { ...initialStage(cmd.scenarioId, now), rev: s.rev + 1, epoch: s.rev + 1, speed: s.speed, autoPause: s.autoPause, playing: !!cmd.autoplay, last: `Scenario: ${cmd.scenarioId}` };
    case 'play':
      return { ...base, playing: t < horizonMin, t0: t >= horizonMin ? 0 : t, at: now, last: 'Playing' };
    case 'pause':
      return { ...base, playing: false, t0: t, at: now, last: cmd.reason ?? 'Paused' };
    case 'autopause':
      return { ...base, autoPause: cmd.on, last: cmd.on ? 'Pause on new incidents: on' : 'Pause on new incidents: off' };
    case 'seek':
      return { ...base, t0: clamp(cmd.t, 0, horizonMin), at: now, last: `Jumped to T+${Math.floor(cmd.t)}` };
    case 'jump':
      return { ...base, t0: clamp(t + cmd.dt, 0, horizonMin), at: now, last: `${cmd.dt > 0 ? '+' : ''}${cmd.dt} min` };
    case 'speed':
      return { ...base, t0: t, at: now, speed: clamp(cmd.speed, 0.25, 8), last: `Speed ${cmd.speed}×` };
    case 'fix':
      if (s.fixes.some((f) => f.id === cmd.fix.id)) return s;
      return { ...base, fixes: [...s.fixes, cmd.fix], last: `Fix ordered: ${cmd.fix.label}` };
    case 'unfix':
      return { ...base, fixes: s.fixes.filter((f) => f.id !== cmd.fixId), last: 'Fix cancelled' };
    case 'lookahead':
      return { ...base, lookaheadMin: clamp(cmd.min, 0, 60), last: cmd.min > 0 ? `Prediction +${cmd.min} min` : 'Prediction off' };
    case 'focus':
      return { ...base, focusAssetId: cmd.assetId, last: cmd.assetId ? `Focus ${cmd.assetId}` : 'Focus cleared' };
    case 'reset':
      return { ...initialStage(s.scenarioId, now), rev: s.rev + 1, epoch: s.rev + 1, speed: s.speed, autoPause: s.autoPause, last: 'Reset' };
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Keep the newer of two states (transports can deliver out of order). */
export const newer = (a: StageState | null, b: StageState): StageState => (!a || b.rev > a.rev || (b.rev === a.rev && b.at > a.at) ? b : a);

// ------------------------------------------------------------------ untrusted input
// Commands and states arrive from other devices (bridge POST, claude.ai room, db): validate shape
// and bounds before use. Anything malformed is dropped, never "fixed up".

const FIX_ACTIONS = new Set<Fix['action']>([
  'isolate_valve', 'restart_chiller', 'swap_crah', 'reset_fan', 'manual_gen_start',
  'transfer_ups', 'suppress_fire', 'reset_breaker', 'shed_load', 'deploy_portable_cooling',
]);
const isId = (v: unknown, max = 64): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && /^[\w.:-]+$/.test(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isText = (v: unknown, max = 160): v is string => typeof v === 'string' && v.length <= max;

export function parseFix(v: unknown): Fix | null {
  const f = v as Partial<Fix> | null;
  if (!f || typeof f !== 'object') return null;
  if (!isId(f.id, 96) || !isId(f.assetId) || !FIX_ACTIONS.has(f.action as Fix['action']) || !isText(f.label) || !isNum(f.orderedAt) || !isNum(f.effectiveAt)) return null;
  return { id: f.id, assetId: f.assetId, action: f.action as Fix['action'], label: f.label, orderedAt: f.orderedAt, effectiveAt: f.effectiveAt };
}

export function parseStageCommand(v: unknown): StageCommand | null {
  const c = v as Record<string, unknown> | null;
  if (!c || typeof c !== 'object') return null;
  switch (c.type) {
    case 'scenario': return isId(c.scenarioId) ? { type: 'scenario', scenarioId: c.scenarioId, autoplay: c.autoplay === true } : null;
    case 'play': case 'reset': return { type: c.type };
    case 'pause': return isText(c.reason) ? { type: 'pause', reason: c.reason } : { type: 'pause' };
    case 'autopause': return typeof c.on === 'boolean' ? { type: 'autopause', on: c.on } : null;
    case 'seek': return isNum(c.t) ? { type: 'seek', t: c.t } : null;
    case 'jump': return isNum(c.dt) ? { type: 'jump', dt: c.dt } : null;
    case 'speed': return isNum(c.speed) ? { type: 'speed', speed: c.speed } : null;
    case 'fix': { const fix = parseFix(c.fix); return fix ? { type: 'fix', fix } : null; }
    case 'unfix': return isId(c.fixId, 96) ? { type: 'unfix', fixId: c.fixId } : null;
    case 'lookahead': return isNum(c.min) ? { type: 'lookahead', min: c.min } : null;
    case 'focus': return c.assetId === null || isId(c.assetId) ? { type: 'focus', assetId: (c.assetId as string | null) } : null;
    default: return null;
  }
}

export function parseStageState(v: unknown): StageState | null {
  const s = v as Record<string, unknown> | null;
  if (!s || typeof s !== 'object') return null;
  if (!isNum(s.rev) || !isId(s.scenarioId) || typeof s.playing !== 'boolean' || !isNum(s.t0) || !isNum(s.at) || !isNum(s.speed) || !isNum(s.lookaheadMin)) return null;
  if (!Array.isArray(s.fixes) || s.fixes.length > 50) return null;
  const fixes = s.fixes.map(parseFix);
  if (fixes.some((f) => !f)) return null;
  if (!(s.focusAssetId === null || s.focusAssetId === undefined || isId(s.focusAssetId))) return null;
  return {
    rev: s.rev, epoch: isNum(s.epoch) ? s.epoch : 0, scenarioId: s.scenarioId, fixes: fixes as Fix[], playing: s.playing,
    t0: s.t0, at: s.at, speed: clamp(s.speed, 0.25, 8), lookaheadMin: clamp(s.lookaheadMin, 0, 60),
    focusAssetId: (s.focusAssetId as string | null | undefined) ?? null, autoPause: typeof s.autoPause === 'boolean' ? s.autoPause : true, last: isText(s.last) ? s.last : '',
  };
}

/** Re-anchor a state from another clock: `senderNow` is the sender's Date.now() when it sent. */
export function reanchor(s: StageState, senderNow: number, now = Date.now()): StageState {
  return isNum(senderNow) ? { ...s, at: s.at + (now - senderNow) } : s;
}
