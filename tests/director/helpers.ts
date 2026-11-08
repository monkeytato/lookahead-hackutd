import { seedIncidents } from '../../src/domain/fixture';
import type { Incident } from '../../src/domain/types';
import type { Scan } from '../../src/domain/rig/protocol';
import type { DirectorInput, FetchLike } from '../../server/director';

/** Incidents as the dashboard holds them at T+25 in scn-riser-leak (mirrors src/state/store.tsx derivedIncidents). */
export function leakIncidents(): Incident[] {
  return [
    ...seedIncidents(),
    { id: 'INC-1044', title: 'Possible leak — loop make-up flow +6 %', rootAssetId: 'PIPE-L2', alertAssetIds: ['PIPE-L2', 'BATT-A', 'UPS-B', 'BATT-B', 'UPS-A', 'ATS-1'], severity: 'warning', status: 'open', evidence: 'unverified', shiftLeadId: 'emp-priya', openedAt: 11, summary: 'Make-up flow mismatch.', recentChanges: [], runbookId: 'RB-LEAK' },
    { id: 'INC-1045', title: 'Water reached BATT-A — battery/UPS exposure', rootAssetId: 'BATT-A', alertAssetIds: ['BATT-A', 'UPS-B', 'BATT-B', 'UPS-A'], severity: 'critical', status: 'open', evidence: 'unverified', shiftLeadId: 'emp-priya', openedAt: 12, summary: 'Water layer shows the wet front at UPS/battery equipment.', recentChanges: [], runbookId: 'RB-BATT' },
  ];
}

export const leakInput = (over: Partial<DirectorInput> = {}): DirectorInput => ({
  scenarioId: 'scn-riser-leak', t: 25, incidents: leakIncidents(), scans: [], confirmedEdgeIds: [], ...over,
});

export function floorScan(assetId: string, wet: number): Scan {
  return {
    id: `SCAN-${assetId}`, assetId, point: 'Drip tray at battery room threshold', deviceId: 'RACKMON-01', firmware: '2.0.0', source: 'simulated',
    operator: 'emp-sofia', startedAt: '2026-11-07T08:35:00Z', endedAt: '2026-11-07T08:35:10Z', durationS: 10, frames: 10, status: 'complete',
    channels: { drip_wet: { n: 10, mean: wet, min: wet, max: wet, sd: 0, slopePerMin: 0, unit: 'fraction' } }, quality: ['simulated_device'],
  };
}

export type ToolCallSpec = { name: string; arguments: string };
export type MockReply = { toolCalls?: ToolCallSpec[]; content?: string } | { status: number; body: string };

/** A fake OpenAI-compatible endpoint that replays scripted assistant turns and records every request. */
export function scriptedFetch(script: MockReply[]) {
  const requests: { url: string; headers: Record<string, string>; body: { model: string; messages: { role: string; content: string | null; tool_call_id?: string }[]; tools: unknown[] } }[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const reply = script[Math.min(i++, script.length - 1)];
    if ('status' in reply) return { ok: reply.status < 400, status: reply.status, text: async () => reply.body };
    const message = {
      role: 'assistant',
      content: reply.content ?? null,
      tool_calls: reply.toolCalls?.map((c, k) => ({ id: `call_${i}_${k}`, type: 'function', function: c })),
    };
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message, finish_reason: reply.toolCalls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }) };
  };
  return { fetchImpl, requests };
}

export const KEY_ENV = { NVIDIA_API_KEY: 'test-key-not-real', NEMOTRON_MODEL: 'nvidia/nemotron-3-super-120b-a12b', NEMOTRON_TIMEOUT_MS: '2000' };
