/**
 * Stage transports. Every transport carries ABSOLUTE StageState (never deltas), so a dropped or
 * repeated message can't put a screen out of step. Which one is live is picked by StageProvider:
 *
 *   bridge  `npm run dev` / `dev:lan`: the bridge server owns the state (server/stageHub.ts).
 *           Commands go up as POST /api/stage; states come down on the SSE stream (bridge.tsx).
 *   room    the static artifact build inside the claude.ai viewer: `room` emits each new state to
 *           everyone viewing right now, and a `db` doc ("stage/current") holds it for late joiners.
 *   local   always on underneath: BroadcastChannel between tabs of this browser + localStorage, so
 *           one laptop with two tabs works with no server and no network.
 */
import { parseStageState, reanchor, type StageState } from './protocol';

const STORAGE_KEY = 'lookahead.stage.v1';
const CHANNEL = 'lookahead.stage';

// ------------------------------------------------------------------ local

export function loadLocalStage(): StageState | null {
  try { return parseStageState(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')); } catch { return null; }
}

export function createLocalTransport(onState: (s: StageState) => void) {
  let bc: BroadcastChannel | null = null;
  try {
    bc = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
    if (bc) bc.onmessage = (m) => { const s = parseStageState(m.data); if (s) onState(s); };
  } catch { bc = null; } // sandboxed frames may refuse it
  return {
    publish(s: StageState) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
      try { bc?.postMessage(s); } catch { /* channel closed */ }
    },
    /** Persist without telling other tabs (used for states that came from elsewhere) */
    remember(s: StageState) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
    },
    close() { try { bc?.close(); } catch { /* already closed */ } },
  };
}

// ------------------------------------------------------------------- room

// Minimal shapes of the claude.ai capabilities we use (authoritative: artifact-capabilities d.ts).
interface RoomMessage { data?: unknown; sameTab: boolean }
interface RoomPeer { isMe: boolean; sameTab: boolean; presence: Readonly<Record<string, unknown>> }
interface RoomLike {
  emit(topic: string, data?: unknown): Promise<void>;
  on(topic: string, handler: (m: RoomMessage) => void, onError?: (e: { code: string }) => void): () => void;
  presence(patch: Record<string, unknown>): Promise<void>;
  onPeers(handler: (c: { peers: readonly RoomPeer[] }) => void, onError?: (e: { code: string }) => void): () => void;
}
interface DocSnap { exists: boolean; data(): Record<string, unknown> | undefined }
interface DbLike { doc(path: string): { set(d: Record<string, unknown>): Promise<void>; onSnapshot(next: (s: DocSnap) => void, error?: (e: unknown) => void): () => void } }
interface ClaudeLike { use(name: string): Promise<unknown> }

export interface RoomLink {
  publish(s: StageState): void;
  close(): void;
  /** true once room or db is actually answering */
  hasRoom: boolean;
  hasDb: boolean;
}

/**
 * Connect to the claude.ai room + db. Resolves null when this view has neither (outside the
 * claude.ai viewer, signed out, not granted). Never throws; never blocks first paint.
 */
export async function connectRoom(opts: {
  role: 'remote' | 'screen';
  onState: (s: StageState) => void;
  onPeers: (others: number) => void;
}): Promise<RoomLink | null> {
  const claude = (globalThis as { claude?: ClaudeLike }).claude;
  if (!claude || typeof claude.use !== 'function') return null;
  let room: RoomLike | null = null;
  let db: DbLike | null = null;
  try {
    [room, db] = (await Promise.all([claude.use('room').catch(() => null), claude.use('db').catch(() => null)])) as [RoomLike | null, DbLike | null];
  } catch { return null; }
  if (!room && !db) return null;

  const offs: (() => void)[] = [];
  if (room) {
    offs.push(room.on('stage', (m) => {
      if (m.sameTab) return;
      const d = m.data as { state?: unknown; now?: unknown } | undefined;
      const s = parseStageState(d?.state);
      if (s) opts.onState(typeof d?.now === 'number' ? reanchor(s, d.now) : s);
    }, () => { /* terminal: db (if any) still carries state */ }));
    offs.push(room.onPeers((c) => opts.onPeers(c.peers.filter((p) => !p.sameTab).length), () => opts.onPeers(0)));
    room.presence({ role: opts.role }).catch(() => { /* presence is display only */ });
  }

  const ref = db?.doc('stage/current');
  if (ref) {
    // db snapshots can be old: use the state as written (devices' clocks are NTP-close), no re-anchor
    offs.push(ref.onSnapshot((snap) => {
      if (!snap.exists) return;
      const s = parseStageState(snap.data()?.state);
      if (s) opts.onState(s);
    }, () => { /* terminal; room (if any) still carries live moments */ }));
  }

  // one db write at a time, latest wins (coalesced)
  let writing = false;
  let pending: StageState | null = null;
  const flush = async () => {
    if (writing || !ref || !pending) return;
    writing = true;
    const s = pending;
    pending = null;
    try { await ref.set({ state: JSON.parse(JSON.stringify(s)), now: Date.now() }); } catch { /* viewer may lack write access */ }
    writing = false;
    if (pending) void flush();
  };

  return {
    hasRoom: !!room,
    hasDb: !!db,
    publish(s) {
      room?.emit('stage', { state: s, now: Date.now() }).catch(() => { /* not permitted / disconnected: db still carries it */ });
      pending = s;
      void flush();
    },
    close() { for (const off of offs) off(); },
  };
}
