import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runDirector, runLocalPlanner } from '../../server/director';
import { createSession } from '../../server/director/tools';
import { dispatchExternal, resetWeatherCache, type ExternalServices, type HttpLike } from '../../server/director/external';
import { createAgentHub } from '../../server/agentHub';
import type { PendingAction } from '../../server/director/types';
import type { ScanRequest, StampedFrame } from '../../src/domain/rig/protocol';
import { SimRig, stamp } from '../../src/domain/rig/simDevice';
import { KEY_ENV, floorScan, leakIncidents, leakInput, scriptedFetch } from './helpers';

/** Fake api.weather.gov: /points → forecastHourly URL → periods in °F. */
function weatherHttp(tempF = 68, calls = { n: 0 }): HttpLike {
  return async (url) => {
    calls.n++;
    if (url.startsWith('https://api.weather.gov/points/')) return { ok: true, status: 200, text: async () => JSON.stringify({ properties: { forecastHourly: 'https://api.weather.gov/gridpoints/FWD/89,113/forecast/hourly' } }) };
    if (url.includes('/forecast/hourly')) return { ok: true, status: 200, text: async () => JSON.stringify({ properties: { periods: Array.from({ length: 8 }, (_, i) => ({ startTime: `2026-11-08T0${i}:00:00-06:00`, temperature: tempF + i, temperatureUnit: 'F', relativeHumidity: { value: 60 }, shortForecast: 'Clear' })) } }) };
    return { ok: false, status: 404, text: async () => 'nope' };
  };
}

function frame(over: Partial<StampedFrame> = {}): StampedFrame {
  const f = stamp(new SimRig(3).tick(1), new Date().toISOString(), 'simulated');
  return { ...f, ...over };
}

function fakeServices(over: Partial<ExternalServices> = {}) {
  const requests: ScanRequest[] = [];
  const actions: PendingAction[] = [];
  const ext: ExternalServices = {
    http: weatherHttp(),
    rigStatus: () => ({ frame: frame(), events: [], mode: 'simulated' }),
    requestScan: (r) => { const q: ScanRequest = { ...r, id: `REQ-${requests.length + 1}`, createdAt: 'now', status: 'open' }; requests.push(q); return q; },
    proposeAction: (a) => { const p: PendingAction = { ...a, id: `ACT-${actions.length + 1}`, createdAt: 'now', status: 'pending' }; actions.push(p); return p; },
    pendingActions: () => actions,
    ticketsConfigured: false,
    ...over,
  };
  return { ext, requests, actions };
}

beforeEach(() => resetWeatherCache());

describe('external tools', () => {
  it('get_weather calls api.weather.gov, converts °F → °C and caches', async () => {
    const calls = { n: 0 };
    const { ext } = fakeServices({ http: weatherHttp(95, calls) });
    const s = createSession(leakInput());
    const out = (await dispatchExternal(s, ext, 'get_weather', { hours: 3 }, 'test'))!;
    expect(out.ok).toBe(true);
    expect(out.service).toBe('api.weather.gov');
    const w = out.content as { hours: { tempC: number }[]; maxTempC: number; note: string };
    expect(w.hours).toHaveLength(3);
    expect(w.hours[0].tempC).toBeCloseTo(35, 0);
    expect(w.note).toMatch(/Heat ahead/);
    await dispatchExternal(s, ext, 'get_weather', {}, 'test');
    expect(calls.n).toBe(2); // second call served from cache
  });

  it('weather outage becomes a tool error, not a crash', async () => {
    const { ext } = fakeServices({ http: async () => { throw new Error('ENOTFOUND'); } });
    const out = (await dispatchExternal(createSession(leakInput()), ext, 'get_weather', {}, 'test'))!;
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out.content)).toMatch(/unreachable/);
  });

  it('propose_rig_action only allows safe-direction commands and never executes', async () => {
    const send = vi.fn();
    const { ext, actions } = fakeServices();
    const s = createSession(leakInput());
    for (const bad of ['valve open', 'auto off', 'flap open', 'fan 100 100', 'sim power off']) {
      const out = (await dispatchExternal(s, ext, 'propose_rig_action', { cmd: bad, reason: 'x' }, 'test'))!;
      expect(out.ok, bad).toBe(false);
    }
    const ok = (await dispatchExternal(s, ext, 'propose_rig_action', { cmd: 'valve close', reason: 'wet floor', incidentId: 'INC-1045' }, 'test'))!;
    expect(ok.ok).toBe(true);
    expect(actions).toHaveLength(1);
    expect(actions[0].status).toBe('pending');
    expect(send).not.toHaveBeenCalled();
    const dup = (await dispatchExternal(s, ext, 'propose_rig_action', { cmd: 'valve close', reason: 'again' }, 'test'))!;
    expect((dup.content as { duplicate: boolean }).duplicate).toBe(true);
    expect(actions).toHaveLength(1);
  });

  it('request_scan validates ids and queues', async () => {
    const { ext, requests } = fakeServices();
    const s = createSession(leakInput());
    expect((await dispatchExternal(s, ext, 'request_scan', { assetId: 'RACK-999', point: 'x', reason: 'y' }, 't'))!.ok).toBe(false);
    expect((await dispatchExternal(s, ext, 'request_scan', { assetId: 'BATT-B', point: 'Floor · leak probe', reason: 'y', incidentId: 'INC-9' }, 't'))!.ok).toBe(false);
    expect((await dispatchExternal(s, ext, 'request_scan', '{"assetId":"BATT-B","point":"Floor · leak probe","reason":"decides run-2 vs run-3"}', 't'))!.ok).toBe(true);
    expect(requests).toHaveLength(1);
  });
});

describe('local planner with external services', () => {
  it('checks the rig and the weather, then queues its recommended scan itself', async () => {
    const { ext, requests } = fakeServices();
    const r = await runLocalPlanner(leakInput(), 'test', Date.now(), ext);
    const tools = r.steps.map((s) => s.tool);
    expect(tools.slice(0, 3)).toEqual(['get_situation', 'get_rig_status', 'get_weather']);
    expect(tools).toContain('request_scan');
    expect(tools.at(-1)).toBe('recommend');
    expect(requests).toHaveLength(1);
    expect(requests[0].assetId).toBe(r.recommendation.nextScan!.assetId);
    expect(r.steps.filter((s) => s.service).map((s) => s.service)).toEqual(['rack-monitor', 'api.weather.gov', 'scan-queue']);
  });

  it('wet floor scan + open valve → proposes "valve close" and a ticket, both awaiting approval', async () => {
    const { ext, actions } = fakeServices({ rigStatus: () => ({ frame: frame({ valve: 'open', floor_raw: 600 }), events: [], mode: 'simulated' }) });
    const incidents = leakIncidents().map((i) => (i.id === 'INC-1045' ? { ...i, evidence: 'corroborated_abnormal' as const } : i));
    await runLocalPlanner(leakInput({ incidents, scans: [floorScan('BATT-B', 1)] }), 'test', Date.now(), ext);
    expect(actions.map((a) => a.kind).sort()).toEqual(['rig_command', 'ticket']);
    expect(actions.every((a) => a.status === 'pending')).toBe(true);
    expect((actions.find((a) => a.kind === 'rig_command')!.payload as { cmd: string }).cmd).toBe('valve close');
  });
});

describe('Nemotron with external tools', () => {
  it('can call weather + rig + request_scan; steps carry their service', async () => {
    const { ext, requests } = fakeServices();
    const { fetchImpl, requests: calls } = scriptedFetch([
      { toolCalls: [{ name: 'get_situation', arguments: '{}' }, { name: 'get_rig_status', arguments: '{}' }, { name: 'get_weather', arguments: '{"hours":4}' }] },
      { toolCalls: [{ name: 'scan_value', arguments: '{"assetId":"BATT-B","metric":"leak"}' }] },
      { toolCalls: [{ name: 'request_scan', arguments: '{"assetId":"BATT-B","point":"Floor · leak probe","reason":"decides run-2 vs run-3","incidentId":"INC-1045"}' }] },
      { toolCalls: [{ name: 'recommend', arguments: JSON.stringify({ nextScan: { assetId: 'BATT-B', point: 'Floor · leak probe', reason: 'decides run-2 vs run-3' }, nextAction: 'Stage a barrier.', hypotheses: [{ label: 'wet', support: 'see run-2', runIds: ['run-2'] }], summary: 'Scan BATT-B (run-2/run-3).' }) }] },
    ]);
    const r = await runDirector(leakInput(), { env: KEY_ENV, fetchImpl, ext });
    expect(r.provider).toBe('nemotron');
    expect(r.steps.filter((s) => s.service).map((s) => s.service)).toEqual(['rack-monitor', 'api.weather.gov', 'scan-queue']);
    expect(requests).toHaveLength(1);
    expect(r.queuedRequests).toHaveLength(1);
    // external tools were offered to the model
    const offered = (calls[0].body.tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(offered).toEqual(expect.arrayContaining(['get_weather', 'get_rig_status', 'request_scan', 'propose_rig_action', 'open_ticket']));
  });
});

describe('agent hub: automatic re-plan and approvals', () => {
  function hub(over: { send?: (c: string) => { ok: boolean; reply: string } } = {}) {
    const requests: ScanRequest[] = [];
    const actions: PendingAction[] = [];
    const events: { e: string; d: unknown }[] = [];
    const send = vi.fn(over.send ?? ((c: string) => ({ ok: true, reply: `ok ${c}` })));
    const h = createAgentHub({
      broadcast: (e, d) => events.push({ e, d }),
      latestFrame: () => frame(),
      recentEvents: () => [],
      deviceMode: () => 'simulated',
      createRequest: (r) => { const q: ScanRequest = { ...r, id: `REQ-${requests.length + 1}`, createdAt: 'now', status: 'open' }; requests.push(q); return q; },
      sendCommand: send,
      actions,
      save: () => {},
      env: {},
      http: weatherHttp(),
    });
    return { h, requests, actions, events, send };
  }

  it('re-plans by itself when the requested scan lands, with the new evidence applied', async () => {
    const { h, requests, events } = hub();
    const first = await h.plan(leakInput());
    expect(first.generation).toBe(1);
    expect(requests).toHaveLength(1);
    const req = requests[0];
    const scan = { ...floorScan(req.assetId, 1), id: 'SCN-TEST', requestId: req.id, point: 'Floor · leak probe' };
    const second = await h.onScan(scan);
    expect(second).not.toBeNull();
    expect(second!.generation).toBe(2);
    expect(second!.trigger).toBe('scan:SCN-TEST');
    expect(second!.chainId).toBe(first.chainId);
    expect(events.map((x) => x.e)).toEqual(expect.arrayContaining(['director', 'director_pending']));
    // the wet scan is now evidence the planner sees: it does not ask for the same scan again
    expect(second!.result.recommendation.nextScan?.assetId).not.toBe(req.assetId);
  });

  it('ignores unrelated scans', async () => {
    const { h } = hub();
    await h.plan(leakInput());
    expect(await h.onScan({ ...floorScan('A-01', 0), id: 'SCN-X', point: 'Front inlet · both beams' })).toBeNull();
  });

  it('rig commands run only after approval; rejection never runs them', async () => {
    const { h, actions, send } = hub();
    actions.push({ id: 'ACT-1', kind: 'rig_command', createdAt: 'now', proposedBy: 'Nemotron', reason: 'r', payload: { cmd: 'valve close' }, status: 'pending' });
    actions.push({ id: 'ACT-2', kind: 'rig_command', createdAt: 'now', proposedBy: 'Nemotron', reason: 'r', payload: { cmd: 'flap close' }, status: 'pending' });
    expect(send).not.toHaveBeenCalled();
    await h.decide('ACT-2', 'reject', 'Priya');
    expect(send).not.toHaveBeenCalled();
    const a = await h.decide('ACT-1', 'approve', 'Priya');
    expect(send).toHaveBeenCalledWith('valve close');
    expect(a!.status).toBe('executed');
    expect(a!.decidedBy).toBe('Priya');
  });

  it('tickets without GitHub config are recorded locally on approval', async () => {
    const { h, actions } = hub();
    actions.push({ id: 'ACT-3', kind: 'ticket', createdAt: 'now', proposedBy: 'Nemotron', reason: 'r', incidentId: 'INC-1045', payload: { title: 't', body: 'b', labels: [] }, status: 'pending' });
    const a = await h.decide('ACT-3', 'approve', 'Priya');
    expect(a!.status).toBe('executed');
    expect(a!.result).toMatch(/Recorded locally/);
  });
});
