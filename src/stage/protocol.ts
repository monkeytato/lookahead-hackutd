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
export const MIN_PER_SEC = 2.5;
export const SPEEDS = [0.5, 1, 2, 4] as const;

export interface StageState {
  /** Increases on every command; transports keep the highest */
  rev: number;
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
  /** Short note of the last command, for the remote's status line ("Fix ordered: close riser valve") */
  last: string;
}

export type StageCommand =
  | { type: 'scenario'; scenarioId: ID; autoplay?: boolean }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; t: number }
  | { type: 'jump'; dt: number }
  | { type: 'speed'; speed: number }
  | { type: 'fix'; fix: Fix }
  | { type: 'unfix'; fixId: ID }
  | { type: 'lookahead'; min: number }
  | { type: 'focus'; assetId: ID | null }
  | { type: 'reset' };

export function initialStage(scenarioId: ID, now = Date.now()): StageState {
  return { rev: 0, scenarioId, fixes: [], playing: false, t0: 0, at: now, speed: 1, lookaheadMin: 0, focusAssetId: null, last: 'Ready' };
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
      return { ...initialStage(cmd.scenarioId, now), rev: s.rev + 1, speed: s.speed, playing: !!cmd.autoplay, last: `Scenario: ${cmd.scenarioId}` };
    case 'play':
      return { ...base, playing: t < horizonMin, t0: t >= horizonMin ? 0 : t, at: now, last: 'Playing' };
    case 'pause':
      return { ...base, playing: false, t0: t, at: now, last: 'Paused' };
    case 'seek':
      return { ...base, t0: clamp(cmd.t, 0, horizonMin), at: now, last: `Jumped to T+${Math.round(cmd.t)}` };
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
      return { ...initialStage(s.scenarioId, now), rev: s.rev + 1, speed: s.speed, last: 'Reset' };
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Keep the newer of two states (transports can deliver out of order). */
export const newer = (a: StageState | null, b: StageState): StageState => (!a || b.rev > a.rev || (b.rev === a.rev && b.at > a.at) ? b : a);
