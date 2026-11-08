/**
 * One way for every view to drive the presentation. With a StageProvider above (the normal case)
 * commands go through the shared stage, so the projector and the phone remote follow; without one
 * (e.g. an older route) they fall back to the local store.
 */
import { useCallback } from 'react';
import { useOps } from '../state/store';
import { useStageOptional, type StageLink } from '../stage/StageProvider';
import type { StageCommand } from '../stage/protocol';
import type { Fix } from '../domain/types';

export interface Controls {
  send: (cmd: StageCommand) => void;
  playing: boolean;
  speed: number;
  lookaheadMin: number;
  fixes: Fix[];
  link: StageLink | null;
  last: string;
  /** True when commands reach other screens (stage present) */
  shared: boolean;
}

export function useControls(): Controls {
  const stage = useStageOptional();
  const { state, dispatch } = useOps();
  const send = useCallback((cmd: StageCommand) => {
    if (stage) { stage.send(cmd); return; }
    switch (cmd.type) {
      case 'play': dispatch({ type: 'play', playing: true }); break;
      case 'pause': dispatch({ type: 'play', playing: false }); break;
      case 'seek': dispatch({ type: 'set_t', t: cmd.t }); break;
      case 'jump': dispatch({ type: 'set_t', t: Math.max(0, state.t + cmd.dt) }); break;
      case 'reset': dispatch({ type: 'reset' }); break;
      case 'scenario': dispatch({ type: 'reset', scenarioId: cmd.scenarioId }); if (cmd.autoplay) dispatch({ type: 'play', playing: true }); break;
      default: break; // fixes, prediction, focus and speed need the stage
    }
  }, [stage, dispatch, state.t]);
  return {
    send,
    playing: stage ? stage.state.playing : state.playing,
    speed: stage?.state.speed ?? 1,
    lookaheadMin: stage?.state.lookaheadMin ?? 0,
    fixes: stage?.state.fixes ?? [],
    link: stage?.link ?? null,
    last: stage?.state.last ?? '',
    shared: !!stage,
  };
}
