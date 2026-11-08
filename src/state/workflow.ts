import { useCallback, useEffect, useRef, useState } from 'react';
import { emptyWork, type WorkState } from '../domain/workflow';
import type { StampedFrame } from '../domain/rig/protocol';
import { api, LOCAL_BRIDGE } from './bridge';

export interface WorkSnapshot extends WorkState { prototype: StampedFrame | null; analyzing: boolean }
export function useWorkflow() {
  const [data, setData] = useState<WorkSnapshot>({ ...emptyWork(), prototype: null, analyzing: false });
  const [online, setOnline] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const accept = useCallback((d: WorkSnapshot) => { if (mounted.current) setData(p => d.revision >= p.revision ? d : p); }, []);
  useEffect(() => {
    mounted.current = true;
    let running = false;
    const refresh = async () => {
      if (running) return; running = true;
      // LOCAL_BRIDGE: the in-page bridge mounts the same workflow hub (verify_scan and evaluate included)
      try { accept(await api<WorkSnapshot>('/api/workflow')); if (mounted.current) setOnline(true); }
      catch { if (mounted.current) setOnline(false); }
      finally { running = false; }
    };
    void refresh(); const timer = window.setInterval(refresh, 1800);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [accept]);
  const command = async (cmd: Record<string, unknown>) => {
    if (busy) return false;
    setBusy(true); setError('');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), cmd.type === 'evaluate' ? 90_000 : 12_000);
    try {
      accept(await api<WorkSnapshot>('/api/workflow', { ...cmd, actor: LOCAL_BRIDGE ? 'Demo operator' : 'Priya Raman' }, controller.signal));
      return true;
    } catch (e) { setError(controller.signal.aborted ? 'The request timed out. Check the bridge; an evaluation may still be running on the laptop.' : (e as Error).message); return false; }
    finally { window.clearTimeout(timeout); if (mounted.current) setBusy(false); }
  };
  return { data, online, error, busy, command };
}
