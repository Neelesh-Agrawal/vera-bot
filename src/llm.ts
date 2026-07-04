/**
 * Thin LLM wrapper — Groq (OpenAI-compatible) or Anthropic.
 * Set GROQ_API_KEY (preferred) or ANTHROPIC_API_KEY in .env.
 * Temperature is always 0 for deterministic output per challenge-brief §7.1.
 *
 * DEBUG_LLM=1 in .env logs the raw model output whenever completeJSON fails
 * to parse or the provider call fails — turn this on when chasing down why
 * a specific trigger kind keeps falling back to the template.
 */

import Anthropic from "@anthropic-ai/sdk";

type Provider = "groq" | "anthropic" | null;

const DEBUG = process.env.DEBUG_LLM === "1";
function debugLog(label: string, detail: string) {
  if (DEBUG) console.error(`[llm debug] ${label}:\n${detail.slice(0, 2000)}\n`);
}

/** Groq free tier ≈ 30 RPM — serialize calls to stay under limit. */
const GROQ_MIN_INTERVAL_MS = Number(process.env.GROQ_MIN_INTERVAL_MS ?? 2600);
let lastGroqCallAt = 0;

function resolveProvider(): Provider {
  if (process.env.LLM_PROVIDER === "anthropic" && process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.LLM_PROVIDER === "groq" && process.env.GROQ_API_KEY) return "groq";
  if (process.env.GROQ_API_KEY) return "groq";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}

let anthropicClient: Anthropic | null = null;
function getAnthropic(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropicClient;
}

export function llmAvailable(): boolean {
  return resolveProvider() !== null;
}

export function llmModelName(): string {
  const p = resolveProvider();
  if (p === "groq") return process.env.GROQ_MODEL ?? "qwen/qwen3.6-27b";
  if (p === "anthropic") return process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
  return "deterministic-template-only";
}

/** True for Groq's reasoning-capable models, which support reasoning_effort. */
function isReasoningModel(model: string): boolean {
  return /qwen3|gpt-oss/i.test(model);
}

function stripJsonFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
}

/** Scans forward from `start`, tracking string/escape state, and returns the
 * end index of the first balanced `{...}` span, or -1 if unbalanced. */
function findBalancedSpanEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === "\\") {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Reasoning models can wrap the JSON answer in chain-of-thought text, and
 * that preamble occasionally contains its OWN balanced brace pair (e.g.
 * "the {edge case} here" or a stray code snippet) — a single first-match
 * brace scan can grab that instead of the real JSON. So: try every `{`
 * position in order, extract its balanced span, and return the first one
 * that actually parses as JSON. Falls back to the naive first/last slice
 * if nothing parses (so the caller still gets a definitive parse error
 * rather than a silent empty string).
 */
function extractJsonObject(raw: string): string {
  const stripped = stripJsonFences(raw);

  let searchFrom = 0;
  while (true) {
    const start = stripped.indexOf("{", searchFrom);
    if (start === -1) break;
    const end = findBalancedSpanEnd(stripped, start);
    if (end !== -1) {
      const candidate = stripped.slice(start, end + 1);
      try {
        JSON.parse(candidate);
        return candidate; // first candidate that actually parses
      } catch {
        // not valid JSON — keep scanning from the next '{'
      }
    }
    searchFrom = start + 1;
  }

  // nothing parsed — return a best-effort slice so the caller's JSON.parse
  // produces a real error (helpful with DEBUG_LLM=1) instead of matching nothing
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  return start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function groqThrottle() {
  const now = Date.now();
  const wait = lastGroqCallAt + GROQ_MIN_INTERVAL_MS - now;
  if (wait > 0) await sleep(wait);
  lastGroqCallAt = Date.now();
}

/**
 * Fire-and-forget Groq ping so the first real /v1/tick isn't paying cold-start
 * latency on top of compose time. Safe to skip when no key is configured.
 */
export async function warmUpLlm(): Promise<void> {
  if (!llmAvailable() || resolveProvider() !== "groq") return;
  try {
    await completeGroq(
      "Reply with JSON only: {\"ok\":true}",
      "ping",
      15_000
    );
    console.log("[llm] warm-up complete");
  } catch {
    console.warn("[llm] warm-up failed (non-fatal)");
  }
}

async function completeGroq(system: string, userContent: string, timeoutMs: number): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const model = process.env.GROQ_MODEL ?? "qwen/qwen3.6-27b";

  for (let attempt = 0; attempt < 6; attempt++) {
    await groqThrottle();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "vera-bot/1.0",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 800,
          // Disable chain-of-thought on reasoning models so `content` is
          // pure JSON — without this, qwen3/gpt-oss models can prepend
          // reasoning text (sometimes containing braces) that breaks
          // naive JSON extraction and was the likely cause of the ~20%
          // fallback rate seen in the first submission.jsonl run.
          ...(isReasoningModel(model) ? { reasoning_effort: "none" } : {}),
          messages: [
            { role: "system", content: system },
            { role: "user", content: userContent },
          ],
        }),
        signal: controller.signal,
      });

      if (res.status === 429) {
        clearTimeout(timer);
        const retryAfter = Number(res.headers.get("retry-after") ?? 0);
        await sleep(Math.max(retryAfter * 1000, 4000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        clearTimeout(timer);
        const bodyText = await res.text().catch(() => "");
        debugLog(`groq HTTP ${res.status}`, bodyText);
        if (attempt < 5) {
          await sleep(2000 * (attempt + 1));
          continue;
        }
        return null;
      }

      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content?.trim();
      clearTimeout(timer);
      if (content) return content;
      debugLog("groq empty content", JSON.stringify(data));
      if (attempt < 5) await sleep(2000);
    } catch (e) {
      clearTimeout(timer);
      debugLog("groq fetch threw", String(e));
      if (attempt < 5) await sleep(3000 * (attempt + 1));
    }
  }
  return null;
}

async function completeAnthropic(system: string, userContent: string, timeoutMs: number): Promise<string | null> {
  const anthropic = getAnthropic();
  if (!anthropic) return null;

  try {
    const res = await anthropic.messages.create(
      {
        model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
        max_tokens: 600,
        temperature: 0,
        system,
        messages: [{ role: "user", content: userContent }],
      },
      { timeout: timeoutMs }
    );
    const textBlock = res.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return null;
    return textBlock.text;
  } catch (e) {
    debugLog("anthropic call threw", String(e));
    return null;
  }
}

/**
 * Calls the model with temperature 0 and parses the JSON response.
 * Returns null on any failure so callers can fall back to deterministic templates.
 * Set DEBUG_LLM=1 to see exactly what the model returned when this happens.
 */
export async function completeJSON<T>(
  system: string,
  userContent: string,
  timeoutMs = 45_000
): Promise<T | null> {
  const provider = resolveProvider();
  if (!provider) return null;

  const raw =
    provider === "groq"
      ? await completeGroq(system, userContent, timeoutMs)
      : await completeAnthropic(system, userContent, timeoutMs);

  if (!raw) return null;

  const extracted = extractJsonObject(raw);
  try {
    return JSON.parse(extracted) as T;
  } catch {
    debugLog("JSON.parse failed on extracted content", `RAW:\n${raw}\n\nEXTRACTED:\n${extracted}`);
    return null;
  }
}