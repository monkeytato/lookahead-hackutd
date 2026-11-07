/**
 * NVIDIA Nemotron as the SIMULATION DIRECTOR.
 *
 * Nemotron plans; the engine computes. Given the live situation, the model forms competing
 * hypotheses, calls the deterministic engine through whitelisted tools to simulate each one,
 * compares time-to-impact clocks and incident ranking, and ends by calling `recommend` with the
 * single next scan of highest decision value. Every number in its text must come from a tool
 * result and is post-validated against the cited runs.
 *
 * Falls back to the deterministic local planner (same tools) on: no API key, timeout, HTTP /
 * network error, malformed responses, repeated invalid tool JSON, no recommend, or step cap.
 */
import type { ChatMessage, Env, FetchLike, NemotronConfig } from './nemotron';
import { NemotronError, chatCompletion, nemotronConfigFromEnv, thinkingPrefix } from './nemotron';
import { runLocalPlanner } from './planner';
import { MAX_RUNS_PER_SESSION, TOOL_DEFS, createSession, dispatchTool } from './tools';
import type { DirectorInput, DirectorResult, DirectorStep, DirectorUsage } from './types';
import { validateRecommendation } from './validate';

export const MAX_TOOL_TURNS = 8;
const MAX_INVALID_JSON = 2;

export interface DirectorOptions {
  fetchImpl?: FetchLike;
  env?: Env;
  maxTurns?: number;
}

export const SYSTEM_PROMPT = `You are the simulation director for a data-center operations team (night shift, simulated facility DAL-1).
You do not compute numbers. A deterministic engine does, through your tools. Your job: decide WHICH simulations to run and WHICH physical scan the team should take next.

Method:
1. Call get_situation. Read the open incidents, their evidence states, the latest rig scans and the baseline run (run-1).
2. Form competing hypotheses (e.g. "the alarm is real" vs "sensor fault"; "the fan trips in 10 min"; "the leak also reaches BATT-B"). Test them with run_scenario and scan_value; compare with compare_runs.
3. Prefer the scan with the highest decision value: the reading whose result would most change what the team does first (top-ranked incident, earliest clocks). Do not recommend a scan the rig cannot measure, or one already taken, unless conditions changed.
4. Prefer verification before irreversible action (valve isolation, battery/UPS work, suppressing alarms).
5. Finish by calling recommend exactly once.

Rules:
- Every number you write (minutes, T+/T− times) must be copied from a tool result. Cite the run id (e.g. run-3) next to it. Never estimate, interpolate or invent a number.
- Clock fields p10/p50/p90/inMin are minutes from now; atMin/atP50 are absolute scenario minutes.
- Use only asset, incident and edge ids that appear in tool results.
- At most ${MAX_RUNS_PER_SESSION} engine runs and ${MAX_TOOL_TURNS} tool turns. Be concise.`;

function userPrompt(input: DirectorInput): string {
  return [
    `Scenario ${input.scenarioId}, now = scenario minute ${input.t}.`,
    input.question ? `Operator question: ${input.question}` : 'Operator question: what should we scan next, and what do we do first?',
    'Start with get_situation.',
  ].join('\n');
}

const addUsage = (u: DirectorUsage, x: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null) => {
  u.requests++;
  if (!x) return;
  u.promptTokens += x.prompt_tokens ?? 0;
  u.completionTokens += x.completion_tokens ?? 0;
  u.totalTokens += x.total_tokens ?? (x.prompt_tokens ?? 0) + (x.completion_tokens ?? 0);
};

class Fallback extends Error {}

export async function runDirector(input: DirectorInput, opts: DirectorOptions = {}): Promise<DirectorResult> {
  const started = Date.now();
  const env = opts.env ?? (process.env as Env);
  const cfg = nemotronConfigFromEnv(env);
  if (!cfg) return runLocalPlanner(input, 'NVIDIA_API_KEY not set — deterministic local planner', started);
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (typeof fetchImpl !== 'function') return runLocalPlanner(input, 'no fetch implementation available', started);

  const session = createSession(input); // throws DirectorInputError on a bad scenario / t
  const steps: DirectorStep[] = [];
  const usage: DirectorUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };
  try {
    await agentLoop(cfg, session.input, fetchImpl, opts.maxTurns ?? MAX_TOOL_TURNS, started, usage, steps, session);
    const { recommendation, warnings } = validateRecommendation(session.recommendation!, session);
    return {
      provider: 'nemotron',
      model: cfg.model,
      steps,
      recommendation,
      runs: Object.fromEntries(session.runs),
      usage,
      warnings: [...session.notes, ...warnings],
      elapsedMs: Date.now() - started,
    };
  } catch (e) {
    if (!(e instanceof Fallback) && !(e instanceof NemotronError)) throw e;
    const reason = e instanceof NemotronError ? `Nemotron ${e.kind}: ${e.message}` : e.message;
    const res = runLocalPlanner(input, `${reason} (${cfg.model}) — deterministic local planner`, started);
    return { ...res, usage: usage.requests ? usage : undefined, nemotronSteps: steps };
  }
}

async function agentLoop(
  cfg: NemotronConfig, input: DirectorInput, fetchImpl: FetchLike, maxTurns: number, started: number,
  usage: DirectorUsage, steps: DirectorStep[], session: ReturnType<typeof createSession>,
): Promise<void> {
  const messages: ChatMessage[] = [
    { role: 'system', content: thinkingPrefix(cfg) + SYSTEM_PROMPT },
    { role: 'user', content: userPrompt(input) },
  ];
  let invalidJson = 0;
  let nudged = false;
  let templateKwargs = true;

  for (let turn = 0; turn < maxTurns; turn++) {
    const left = cfg.budgetMs - (Date.now() - started);
    if (left <= 0) throw new Fallback(`time budget of ${cfg.budgetMs} ms exhausted after ${turn} turns`);
    let res;
    try {
      res = await chatCompletion(cfg, messages, TOOL_DEFS, { fetchImpl, timeoutMs: Math.min(cfg.timeoutMs, left), withTemplateKwargs: templateKwargs });
    } catch (e) {
      // Some hosted deployments reject chat_template_kwargs: retry this turn once without it.
      if (e instanceof NemotronError && e.kind === 'http' && (e.status === 400 || e.status === 422) && templateKwargs && /chat_template|kwargs|extra/i.test(e.message)) {
        templateKwargs = false;
        turn--;
        continue;
      }
      throw e;
    }
    addUsage(usage, res.usage);

    if (!res.toolCalls.length) {
      if (nudged) throw new Fallback('Nemotron ended without calling recommend');
      nudged = true;
      messages.push({ role: 'assistant', content: res.content ?? '' });
      messages.push({ role: 'user', content: 'Respond only with tool calls. If you have enough runs, call recommend now; every number must come from a tool result with its run id.' });
      continue;
    }

    messages.push({ role: 'assistant', content: res.content ?? null, tool_calls: res.toolCalls });
    for (const tc of res.toolCalls) {
      const out = dispatchTool(session, tc.function.name, tc.function.arguments);
      let args: unknown = tc.function.arguments;
      try { args = JSON.parse(tc.function.arguments); } catch { /* keep the raw (invalid) string for the log */ }
      steps.push({ tool: tc.function.name, args, summary: out.summary, runId: out.runId, runIds: out.runIds, ok: out.ok });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out.content) });
      if (out.invalidJson && ++invalidJson > MAX_INVALID_JSON) throw new Fallback(`Nemotron sent invalid tool JSON ${invalidJson} times`);
      if (out.ok && out.terminal) return;
    }
  }
  throw new Fallback(`step cap: no recommend after ${maxTurns} tool turns`);
}
