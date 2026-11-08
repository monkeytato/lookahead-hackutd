/**
 * React access to the shared stage. CONTRACT (owned by the stage agent):
 *   <StageProvider>  wraps every route that shows or drives the presentation
 *   useStage()       → { state, send, t, link, scenario }
 *     state  StageState (absolute, see protocol.ts)
 *     send   apply a command locally AND relay it to every other screen
 *     t      current scenario minute, re-rendered ~5×/s while playing
 *     link   which transport is carrying it: 'bridge' | 'room' | 'local'
 *
 * This stub is same-browser only; the stage agent adds the bridge and claude.ai room transports.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getScenario } from '../domain/scenarios';
import type { Scenario } from '../domain/types';
import { applyStageCommand, initialStage, stageTime, type StageCommand, type StageState } from './protocol';

export type StageLink = 'bridge' | 'room' | 'local';
interface StageCtx { state: StageState; send: (cmd: StageCommand) => void; t: number; link: StageLink; scenario: Scenario }

const Ctx = createContext<StageCtx | null>(null);

export function StageProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StageState>(() => initialStage('scn-riser-leak'));
  const scenario = useMemo(() => getScenario(state.scenarioId), [state.scenarioId]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!state.playing) return;
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [state.playing]);
  const send = useCallback((cmd: StageCommand) => setState((s) => applyStageCommand(s, cmd, getScenario(s.scenarioId).horizonMin)), []);
  const t = stageTime(state, scenario.horizonMin, state.playing ? now : undefined);
  const value = useMemo<StageCtx>(() => ({ state, send, t, link: 'local', scenario }), [state, send, t, scenario]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStage(): StageCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useStage outside StageProvider');
  return c;
}

/** For components that also render outside a StageProvider (e.g. #/twin-lab): null there. */
export function useStageOptional(): StageCtx | null {
  return useContext(Ctx);
}
