// Optional, best-effort LLM assist. Talks to an OpenAI-compatible endpoint
// (default: local vLLM at http://localhost:8000/v1) to classify PR size and
// write the one-sentence summaries. Everything here is fail-safe: any error or
// unreachable endpoint degrades to "unavailable", and the app then shows counts
// and diffstats with no insights rather than guessing.

import type { LlmConfig } from "./config.js";

export interface LlmStatus {
  available: boolean;
  model: string | null;
}

let cfg: LlmConfig | null = null;
let status: LlmStatus = { available: false, model: null };
let timer: ReturnType<typeof setInterval> | null = null;

const POLL_MS = 25_000;
const MODELS_TIMEOUT_MS = 4_000;
// Classification is a background job — nothing is blocked on it, so a local
// reasoning model on a contended GPU is allowed to take its time.
const ASK_TIMEOUT_MS = 60_000;
/** Every request is retried once: endpoints fail transiently, and the caller's
 * only fallback is to leave a PR unclassified. */
const RETRY_DELAY_MS = 250;

function url(path: string): string {
  const base = (cfg?.baseUrl ?? "").replace(/\/+$/, "");
  return `${base}/${path}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(
  target: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(target, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Resolve the model to use: the configured name, unless it's "default"/empty,
 * in which case the first model the endpoint advertises. Doubles as the health
 * probe — throws if the endpoint is down or lists no models. */
async function resolveModel(): Promise<string> {
  const data = (await fetchJson(
    url("models"),
    { method: "GET" },
    MODELS_TIMEOUT_MS,
  )) as { data?: { id?: string }[] };
  const configured = (cfg?.model ?? "").trim();
  if (configured && configured !== "default") return configured;
  const first = data?.data?.[0]?.id;
  if (!first) throw new Error("no models advertised");
  return first;
}

async function poll(): Promise<void> {
  try {
    status = { available: true, model: await resolveModel() };
  } catch {
    status = { available: false, model: null };
  }
}

export function startLlmPolling(config: LlmConfig): void {
  cfg = config;
  if (timer) clearInterval(timer);
  void poll();
  timer = setInterval(() => void poll(), POLL_MS);
  timer.unref?.(); // don't keep the process alive just for polling
}

export function llmStatus(): LlmStatus {
  return status;
}

/** One chat completion. Returns null on any failure — callers must treat a
 * null as "no opinion", never as a default answer. */
export async function ask(
  system: string,
  user: string,
): Promise<{ text: string; model: string } | null> {
  if (!cfg) return null;
  const model = status.model ?? cfg.model;
  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0,
    max_tokens: 400,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = (await fetchJson(
        url("chat/completions"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        },
        ASK_TIMEOUT_MS,
      )) as { choices?: { message?: { content?: string } }[] };
      const text = res?.choices?.[0]?.message?.content;
      if (typeof text === "string" && text.trim()) return { text, model };
    } catch {
      // fall through to the retry
    }
    if (attempt === 0) await sleep(RETRY_DELAY_MS);
  }
  return null;
}
