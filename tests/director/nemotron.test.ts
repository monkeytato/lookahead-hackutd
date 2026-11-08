import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, nemotronConfigFromEnv, runDirector } from '../../server/director';
import type { FetchLike } from '../../server/director';
import { KEY_ENV, leakInput, scriptedFetch } from './helpers';

const recommendArgs = (summary: string) => JSON.stringify({
  nextScan: { assetId: 'BATT-B', point: 'Battery room threshold, floor', reason: 'If wet (run-2) the first rack loss is in 19 min; if dry (run-3) none within the horizon.' },
  nextAction: 'Hold the BATT-B module work and stage an absorbent barrier until the scan is in.',
  hypotheses: [
    { label: 'Water front has reached BATT-B as modeled', support: 'first rack loss in 19 min', runIds: ['run-2'] },
    { label: 'Water layer overestimates spread', support: 'no rack loss within the horizon', runIds: ['run-3'] },
  ],
  summary,
});

describe('Nemotron director path (mocked endpoint)', () => {
  it('dispatches tool calls, rejects an unknown asset id and malformed JSON, and ends with recommend', async () => {
    const { fetchImpl, requests } = scriptedFetch([
      { toolCalls: [{ name: 'get_situation', arguments: '{}' }] },
      { toolCalls: [
        { name: 'scan_value', arguments: JSON.stringify({ assetId: 'BATT-Z', metric: 'leak' }) },
        { name: 'scan_value', arguments: '{"assetId": "BATT-B", "metric": ' },
        { name: 'scan_value', arguments: JSON.stringify({ assetId: 'BATT-B', metric: 'leak' }) },
      ] },
      { toolCalls: [{ name: 'compare_runs', arguments: JSON.stringify({ a: 'run-2', b: 'run-3' }) }] },
      { toolCalls: [{ name: 'recommend', arguments: recommendArgs('Scan BATT-B: the hall clock is 19 min (run-2) if wet, none if dry (run-3).') }] },
    ]);
    const r = await runDirector(leakInput(), { env: KEY_ENV, fetchImpl });

    expect(r.provider).toBe('nemotron');
    expect(r.model).toBe('nvidia/nemotron-3-super-120b-a12b');
    expect(r.fallbackReason).toBeUndefined();
    expect(r.recommendation.nextScan).toMatchObject({ assetId: 'BATT-B', holdS: 10 });
    expect(r.warnings).toEqual([]);
    expect(r.usage).toEqual({ promptTokens: 400, completionTokens: 80, totalTokens: 480, requests: 4 });

    const rejected = r.steps.filter((s) => !s.ok);
    expect(rejected).toHaveLength(2);
    expect(rejected[0].summary).toMatch(/unknown asset id "BATT-Z"/);
    expect(rejected[1].summary).toMatch(/invalid JSON/);
    expect(r.runs['run-2'].label).toMatch(/BATT-B reads wet/);

    // wire format: OpenAI-compatible, bearer key, tools advertised, tool results fed back by id
    expect(requests[0].url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(requests[0].headers.authorization).toBe('Bearer test-key-not-real');
    expect(requests[0].body.tools).toHaveLength(5);
    expect(requests[0].body.messages[0].content).toMatch(/numbers/i);
    const toolMsgs = requests[2].body.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.some((m) => /unknown asset id/.test(m.content ?? ''))).toBe(true);
    expect(toolMsgs.some((m) => /not valid JSON/.test(m.content ?? ''))).toBe(true);
    expect(toolMsgs.every((m) => typeof m.tool_call_id === 'string')).toBe(true);
  });

  it('strips numbers the cited runs never produced', async () => {
    const { fetchImpl } = scriptedFetch([
      { toolCalls: [{ name: 'get_situation', arguments: '{}' }, { name: 'scan_value', arguments: JSON.stringify({ assetId: 'BATT-B', metric: 'leak' }) }] },
      { toolCalls: [{ name: 'recommend', arguments: recommendArgs('Hall lost in 19 min (run-2). CRAH-2 trips at T−7 and the UPS lasts 12 min.') }] },
    ]);
    const r = await runDirector(leakInput(), { env: KEY_ENV, fetchImpl });
    expect(r.provider).toBe('nemotron');
    expect(r.recommendation.summary).toContain('19 min (run-2)');
    expect(r.recommendation.summary).not.toMatch(/T−7|12 min/);
    expect(r.recommendation.summary.match(/\[unsupported\]/g)).toHaveLength(2);
    expect(r.warnings.filter((w) => w.startsWith('unsupported_number'))).toHaveLength(2);
  });

  it('accepts inline <TOOLCALL> output when the server-side parser is off', async () => {
    const { fetchImpl } = scriptedFetch([
      { content: '<TOOLCALL>[{"name": "get_situation", "arguments": {}}]</TOOLCALL>' },
      { content: `<TOOLCALL>[{"name": "recommend", "arguments": ${JSON.stringify({ nextScan: null, nextAction: 'Work INC-1043 first (run-1).', hypotheses: [{ label: 'as modeled', support: 'baseline', runIds: ['run-1'] }], summary: 'Baseline only (run-1).' })}}]</TOOLCALL>` },
    ]);
    const r = await runDirector(leakInput(), { env: KEY_ENV, fetchImpl });
    expect(r.provider).toBe('nemotron');
    expect(r.recommendation.nextScan).toBeNull();
  });
});

describe('Nemotron failures fall back to the local planner', () => {
  it('timeout → local planner with fallbackReason', async () => {
    const hang: FetchLike = (_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const r = await runDirector(leakInput(), { env: { ...KEY_ENV, NEMOTRON_TIMEOUT_MS: '30' }, fetchImpl: hang });
    expect(r.provider).toBe('local_planner');
    expect(r.fallbackReason).toMatch(/timeout/);
    expect(r.fallbackReason).toContain('nvidia/nemotron-3-super-120b-a12b');
    expect(r.recommendation.nextScan?.assetId).toBe('BATT-B');
  });

  it('HTTP error → local planner', async () => {
    const { fetchImpl } = scriptedFetch([{ status: 503, body: '{"error":"overloaded"}' }]);
    const r = await runDirector(leakInput(), { env: KEY_ENV, fetchImpl });
    expect(r.provider).toBe('local_planner');
    expect(r.fallbackReason).toMatch(/http: HTTP 503/);
  });

  it('repeated invalid tool JSON → local planner', async () => {
    const { fetchImpl } = scriptedFetch([{ toolCalls: [{ name: 'run_scenario', arguments: '{bad' }] }]);
    const r = await runDirector(leakInput(), { env: KEY_ENV, fetchImpl });
    expect(r.provider).toBe('local_planner');
    expect(r.fallbackReason).toMatch(/invalid tool JSON/);
    expect(r.nemotronSteps?.length).toBe(3);
  });

  it('step cap without recommend → local planner', async () => {
    const { fetchImpl } = scriptedFetch([{ toolCalls: [{ name: 'get_situation', arguments: '{}' }] }]);
    const r = await runDirector(leakInput(), { env: KEY_ENV, fetchImpl, maxTurns: 3 });
    expect(r.provider).toBe('local_planner');
    expect(r.fallbackReason).toMatch(/step cap/);
  });

  it('tells the model when turns run low and forces recommend on the last turn', async () => {
    const { fetchImpl, requests } = scriptedFetch([
      { toolCalls: [{ name: 'get_situation', arguments: '{}' }] },
      { toolCalls: [{ name: 'scan_value', arguments: JSON.stringify({ assetId: 'BATT-B', metric: 'leak' }) }] },
      { toolCalls: [{ name: 'compare_runs', arguments: JSON.stringify({ a: 'run-2', b: 'run-3' }) }] },
      { toolCalls: [{ name: 'recommend', arguments: recommendArgs('Scan BATT-B first (run-2 vs run-3).') }] },
    ]);
    const r = await runDirector(leakInput(), { env: KEY_ENV, fetchImpl, maxTurns: 4 });
    expect(r.provider).toBe('nemotron');
    const choice = (i: number) => (requests[i].body as unknown as { tool_choice: unknown }).tool_choice;
    expect(choice(0)).toBe('auto');
    expect(choice(2)).toBe('auto');
    expect(choice(3)).toEqual({ type: 'function', function: { name: 'recommend' } });
    const nudges = requests[3].body.messages.filter((m) => m.role === 'user' && /tool turns? left/.test(m.content ?? ''));
    expect(nudges).toHaveLength(1);
  });

  it('retries the last turn with tool_choice auto when the host rejects a named tool_choice', async () => {
    const { fetchImpl, requests } = scriptedFetch([
      { toolCalls: [{ name: 'scan_value', arguments: JSON.stringify({ assetId: 'BATT-B', metric: 'leak' }) }] },
      { status: 400, body: '{"detail":"tool_choice must be auto"}' },
      { toolCalls: [{ name: 'recommend', arguments: recommendArgs('Scan BATT-B first (run-2 vs run-3).') }] },
    ]);
    const r = await runDirector(leakInput(), { env: KEY_ENV, fetchImpl, maxTurns: 2 });
    expect(r.provider).toBe('nemotron');
    expect((requests[2].body as unknown as { tool_choice: unknown }).tool_choice).toBe('auto');
  });

  it('plain text twice (no tool calls) → local planner', async () => {
    const { fetchImpl } = scriptedFetch([{ content: 'I think you should scan BATT-B in 4 minutes.' }]);
    const r = await runDirector(leakInput(), { env: KEY_ENV, fetchImpl });
    expect(r.provider).toBe('local_planner');
    expect(r.fallbackReason).toMatch(/without calling recommend/);
  });
});

describe('config', () => {
  it('defaults and reasoning toggle', () => {
    expect(nemotronConfigFromEnv({})).toBeNull();
    const c = nemotronConfigFromEnv({ NVIDIA_API_KEY: 'k' })!;
    expect(c.model).toBe(DEFAULT_MODEL);
    expect(c.baseUrl).toBe('https://integrate.api.nvidia.com/v1');
    expect(c.timeoutMs).toBe(15000);
    expect(c.thinking).toBe('off');
  });

  it('sends chat_template_kwargs for Nemotron 3 and /no_think for Llama-3.3-Nemotron', async () => {
    const a = scriptedFetch([{ status: 500, body: 'x' }]);
    await runDirector(leakInput(), { env: KEY_ENV, fetchImpl: a.fetchImpl });
    expect((a.requests[0].body as unknown as { chat_template_kwargs: unknown }).chat_template_kwargs).toEqual({ enable_thinking: false });
    const b = scriptedFetch([{ status: 500, body: 'x' }]);
    await runDirector(leakInput(), { env: { ...KEY_ENV, NEMOTRON_MODEL: 'nvidia/llama-3.3-nemotron-super-49b-v1.5' }, fetchImpl: b.fetchImpl });
    expect(b.requests[0].body.messages[0].content?.startsWith('/no_think')).toBe(true);
    expect((b.requests[0].body as unknown as { chat_template_kwargs?: unknown }).chat_template_kwargs).toBeUndefined();
  });
});
