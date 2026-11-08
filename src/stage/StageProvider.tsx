/**
 * React access to the shared stage.
 *   <StageProvider>  wraps every route that shows or drives the presentation (inside BridgeProvider)
 *   useStage()       → { state, send, t, link, scenario, others }
 *     state   StageState (absolute, see protocol.ts)
 *     send    apply a command here at once AND relay it to every other screen
 *     t       current scenario minute, re-rendered 5×/s while playing
 *     link    which transport carries it: 'bridge' | 'room' | 'local' (see transport.ts)
 *     others  other screens connected right now, when the transport can tell (else null)
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getScenario } from '../domain/scenarios';
import type { Scenario } from '../domain/types';
import { api, LOCAL_BRIDGE, useBridge } from '../state/bridge';
import { applyStageCommand, initialStage, newer, parseStageState, stageTime, type StageCommand, type StageState } from './protocol';
import { connectRoom, createLocalTransport, loadLocalStage, type RoomLink } from './transport';

export type StageLink = 'bridge' | 'room' | 'local';
interface StageCtx { state: StageState; send: (cmd: StageCommand) => void; t: number; link: StageLink; scenario: Scenario; others: number | null }

const Ctx = createContext<StageCtx | null>(null);

export function StageProvider({ children, role = 'screen' }: { children: ReactNode; role?: 'remote' | 'screen' }) {
  const bridge = useBridge();
  const [state, setState] = useState<StageState>(() => loadLocalStage() ?? initialStage('scn-riser-leak'));
  const stateRef = useRef(state);
  const [room, setRoom] = useState<RoomLink | null>(null);
  const [roomPeers, setRoomPeers] = useState<number | null>(null);
  const localRef = useRef<ReturnType<typeof createLocalTransport> | null>(null);

  const adopt = useCallback((incoming: StageState, authoritative: boolean) => {
    const next = authoritative ? incoming : newer(stateRef.current, incoming);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
    localRef.current?.remember(next);
  }, []);

  // local: other tabs of this browser (always on)
  useEffect(() => {
    const local = createLocalTransport((s) => adopt(s, false));
    localRef.current = local;
    return () => { local.close(); if (localRef.current === local) localRef.current = null; };
  }, [adopt]);

  // bridge: the server's state is authoritative; re-anchor its clock to ours
  const bridgeStage = bridge.stage;
  useEffect(() => {
    if (LOCAL_BRIDGE || !bridgeStage) return;
    const s = parseStageState(bridgeStage.state);
    if (s) adopt({ ...s, at: s.at + (bridgeStage.receivedAt - bridgeStage.now) }, true);
  }, [bridgeStage, adopt]);

  // room: only in the static artifact build (the in-page bridge is per page, so it can't share)
  useEffect(() => {
    if (!LOCAL_BRIDGE) return;
    let alive = true;
    let link: RoomLink | null = null;
    connectRoom({ role, onState: (s) => adopt(s, false), onPeers: (n) => alive && setRoomPeers(n) }).then((r) => {
      if (!alive) { r?.close(); return; }
      link = r;
      setRoom(r);
    });
    return () => { alive = false; link?.close(); };
  }, [adopt, role]);

  const link: StageLink = LOCAL_BRIDGE ? (room ? 'room' : 'local') : bridge.online ? 'bridge' : 'local';
  const linkRef = useRef(link);
  const roomRef = useRef(room);
  useEffect(() => { linkRef.current = link; roomRef.current = room; }, [link, room]);

  const send = useCallback((cmd: StageCommand) => {
    const cur = stateRef.current;
    const horizon = getScenario(cmd.type === 'scenario' ? cmd.scenarioId : cur.scenarioId).horizonMin;
    const next = applyStageCommand(cur, cmd, horizon);
    if (next === cur) return;
    stateRef.current = next;
    setState(next);
    localRef.current?.publish(next);
    if (linkRef.current === 'bridge') api('/api/stage', { cmd }).catch((e) => console.warn('[stage] bridge rejected command', e));
    else if (linkRef.current === 'room') roomRef.current?.publish(next);
  }, []);

  const scenario = useMemo(() => getScenario(state.scenarioId), [state.scenarioId]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!state.playing) return;
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [state.playing]);
  const t = stageTime(state, scenario.horizonMin, state.playing ? Math.max(now, state.at) : undefined);

  const others = link === 'bridge' ? (bridgeStage ? Math.max(0, bridgeStage.screens - 1) : null) : link === 'room' ? roomPeers : null;
  const value = useMemo<StageCtx>(() => ({ state, send, t, link, scenario, others }), [state, send, t, link, scenario, others]);
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
