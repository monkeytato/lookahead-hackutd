/**
 * Minimal client for NVIDIA's OpenAI-compatible endpoint (build.nvidia.com →
 * https://integrate.api.nvidia.com/v1/chat/completions). No SDK, global fetch only.
 *
 * Model output is untrusted: this module only extracts text and tool calls (name + raw argument
 * string). It never evaluates anything; the director dispatches tool calls to a whitelist and
 * JSON-parses arguments with guards.
 */

export const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
/** Nemotron 3.5 Lightning (30B / 3B active, function calling). Verified live on integrate.api.nvidia.com 2026-11-07. */
export const DEFAULT_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
export const DEFAULT_TIMEOUT_MS = 15000;

export type ThinkingMode = 'off' | 'on' | 'default';

export interface NemotronConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  thinking: ThinkingMode;
  /** Upper bound on the whole agent loop */
  budgetMs: number;
}

export type Env = Record<string, string | undefined>;

/** Returns null when no API key is configured (the director then uses the local planner). */
export function nemotronConfigFromEnv(env: Env): NemotronConfig | null {
  const apiKey = (env.NVIDIA_API_KEY ?? '').trim();
  if (!apiKey) return null;
  const timeoutMs = clampInt(env.NEMOTRON_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1, 120000);
  const t = (env.NEMOTRON_THINKING ?? 'off').trim().toLowerCase();
  return {
    apiKey,
    baseUrl: (env.NVIDIA_BASE_URL ?? '').trim().replace(/\/+$/, '') || DEFAULT_BASE_URL,
    model: (env.NEMOTRON_MODEL ?? '').trim() || DEFAULT_MODEL,
    timeoutMs,
    thinking: t === 'on' || t === 'default' ? t : 'off',
    budgetMs: clampInt(env.NEMOTRON_BUDGET_MS, timeoutMs * 4, 1, 600000),
  };
}

function clampInt(v: string | undefined, dflt: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
}

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatUsage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: ChatUsage | null;
}

export type NemotronErrorKind = 'timeout' | 'http' | 'network' | 'bad_response';
export class NemotronError extends Error {
  kind: NemotronErrorKind;
  status?: number;
  constructor(kind: NemotronErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Llama-3.3-Nemotron (v1/v1.5) toggles reasoning with a system-prompt switch; Nemotron 3 / Nano v2 use the chat template flag. */
const usesSystemSwitch = (model: string) => /llama-3[._]3-nemotron/i.test(model);

/** System prompt prefix for the reasoning toggle on models that use one. */
export function thinkingPrefix(cfg: NemotronConfig): string {
  if (cfg.thinking === 'default' || !usesSystemSwitch(cfg.model)) return '';
  return cfg.thinking === 'off' ? '/no_think\n' : '/think\n';
}

/** 'auto', or force one named function (used on the last turn to force `recommend`). */
export type ToolChoice = 'auto' | { type: 'function'; function: { name: string } };

let callSeq = 0;

export async function chatCompletion(
  cfg: NemotronConfig,
  messages: ChatMessage[],
  tools: readonly unknown[],
  opts: { fetchImpl: FetchLike; timeoutMs?: number; withTemplateKwargs?: boolean; toolChoice?: ToolChoice },
): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    tools,
    tool_choice: opts.toolChoice ?? 'auto',
    temperature: 0.6,
    top_p: 0.95,
    max_tokens: cfg.thinking === 'on' ? 4096 : 1536,
    stream: false,
  };
  if (opts.withTemplateKwargs !== false && cfg.thinking !== 'default' && !usesSystemSwitch(cfg.model)) {
    body.chat_template_kwargs = { enable_thinking: cfg.thinking === 'on' };
  }
  const ctl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs;
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let status = 0;
  let text = '';
  try {
    const res = await opts.fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    status = res.status;
    text = await res.text();
    if (!res.ok) throw new NemotronError('http', `HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
  } catch (e) {
    if (e instanceof NemotronError) throw e;
    if (ctl.signal.aborted) throw new NemotronError('timeout', `no response within ${timeoutMs} ms`);
    throw new NemotronError('network', `request failed: ${(e as Error)?.message ?? String(e)}`.slice(0, 200));
  } finally {
    clearTimeout(timer);
  }
  return parseResponse(text, status);
}

export function parseResponse(text: string, status = 200): ChatResult {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new NemotronError('bad_response', `response is not JSON (HTTP ${status})`); }
  const d = data as { choices?: { message?: Record<string, unknown>; finish_reason?: string }[]; usage?: ChatUsage };
  const choice = d?.choices?.[0];
  const msg = choice?.message;
  if (!msg || typeof msg !== 'object') throw new NemotronError('bad_response', 'response has no choices[0].message');
  let content = typeof msg.content === 'string' ? msg.content : null;
  const toolCalls: ToolCall[] = [];
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls as Record<string, unknown>[]) {
      const fn = (tc?.function ?? {}) as Record<string, unknown>;
      if (typeof fn.name !== 'string') continue;
      const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
      toolCalls.push({ id: typeof tc.id === 'string' && tc.id ? tc.id.slice(0, 64) : `call_${++callSeq}`, type: 'function', function: { name: fn.name.slice(0, 64), arguments: args } });
    }
  }
  if (content) {
    content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    // Some Nemotron deployments return tool calls inline when the server-side parser is off.
    if (!toolCalls.length) {
      const m = content.match(/<TOOLCALL>\s*(\[[\s\S]*?\])\s*<\/TOOLCALL>/);
      if (m) {
        try {
          const arr = JSON.parse(m[1]) as { name?: unknown; arguments?: unknown }[];
          for (const c of Array.isArray(arr) ? arr : []) {
            if (typeof c?.name !== 'string') continue;
            toolCalls.push({ id: `call_${++callSeq}`, type: 'function', function: { name: c.name.slice(0, 64), arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}) } });
          }
        } catch { /* leave as text */ }
        if (toolCalls.length) content = content.replace(m[0], '').trim();
      }
    }
    if (!content) content = null;
  }
  return { content, toolCalls, finishReason: choice?.finish_reason ?? null, usage: d.usage ?? null };
}
