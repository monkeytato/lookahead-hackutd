/**
 * The bridge's stage: one authoritative StageState for every screen on the LAN (laptop/projector,
 * phone remote, desktop workspace). Commands are validated, applied with the shared reducer and
 * broadcast whole with the server's clock, so each client can re-anchor time to its own clock.
 */
import { getScenario } from '../src/domain/scenarios';
import { applyStageCommand, initialStage, parseStageCommand, parseStageState, type StageState } from '../src/stage/protocol';

export interface StagePayload { state: StageState; now: number; screens: number }

export interface StageHubDeps {
  initial?: unknown;
  save(state: StageState): void;
  broadcast(payload: StagePayload): void;
  screens(): number;
  now?: () => number;
}

export function createStageHub(deps: StageHubDeps) {
  const now = deps.now ?? Date.now;
  let state: StageState = parseStageState(deps.initial) ?? initialStage('scn-riser-leak', now());
  const payload = (): StagePayload => ({ state, now: now(), screens: deps.screens() });
  return {
    get: () => state,
    payload,
    /** Apply a raw (untrusted) command. Returns the new payload, or an error string. */
    command(raw: unknown): { ok: true; payload: StagePayload } | { ok: false; error: string } {
      const cmd = parseStageCommand(raw);
      if (!cmd) return { ok: false, error: 'invalid stage command' };
      const horizon = getScenario(cmd.type === 'scenario' ? cmd.scenarioId : state.scenarioId).horizonMin;
      const next = applyStageCommand(state, cmd, horizon, now());
      if (next !== state) { state = next; deps.save(state); }
      const p = payload();
      deps.broadcast(p);
      return { ok: true, payload: p };
    },
    /** Re-announce (e.g. screen count changed). */
    announce() { deps.broadcast(payload()); },
  };
}
