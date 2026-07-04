import type {
  CategoryContext,
  ComposedMessage,
  CtaShape,
  CustomerContext,
  MerchantContext,
  SendAs,
  TriggerContext,
} from "./types.js";
import { buildFactSheet, COMPOSER_SYSTEM_PROMPT } from "./promptBuilder.js";
import { completeJSON, llmAvailable } from "./llm.js";
import { COMPOSE_TIMEOUT_MS } from "./timeouts.js";

interface LLMComposeOutput {
  body: string;
  cta: CtaShape;
  rationale: string;
}

const VALID_CTAS: CtaShape[] = ["yes_no", "open_ended", "multi_choice", "none"];
const DEBUG = process.env.DEBUG_LLM === "1";

/** Returns the first taboo word found in body, or null if clean. */
function findTaboo(body: string, category: CategoryContext): string | null {
  const lower = body.toLowerCase();
  const hit = (category.voice.vocab_taboo ?? []).find((t) => lower.includes(t.toLowerCase()));
  return hit ?? null;
}

/**
 * Validates raw LLM output and returns either the accepted message or a
 * specific failure reason — so a fallback's cause is traceable instead of
 * a blanket "failed validation". Run with DEBUG_LLM=1 to see these reasons
 * printed alongside the raw model output logged in llm.ts.
 */
function validate(
  result: LLMComposeOutput | null,
  category: CategoryContext
): { ok: true; body: string; cta: CtaShape } | { ok: false; reason: string } {
  if (!result) return { ok: false, reason: "llm_call_or_json_parse_failed" };
  if (typeof result.body !== "string" || result.body.trim().length === 0) {
    return { ok: false, reason: "empty_or_missing_body" };
  }
  if (!VALID_CTAS.includes(result.cta)) {
    return { ok: false, reason: `invalid_cta:${String(result.cta)}` };
  }
  const taboo = findTaboo(result.body, category);
  if (taboo) return { ok: false, reason: `taboo_word:${taboo}` };
  return { ok: true, body: result.body.trim(), cta: result.cta };
}

/**
 * Deterministic fallback composer — always succeeds, no external calls.
 * Used when no LLM key is set, or if the LLM call fails/produces
 * an invalid/taboo-violating output. Intentionally generic: it favors
 * "correct and grounded" over "maximally compelling" since it's the safety
 * net, not the primary path.
 */
function composeTemplate(
  category: CategoryContext,
  merchant: MerchantContext,
  trigger: TriggerContext,
  customer?: CustomerContext
): { body: string; cta: CtaShape } {
  const name = customer
    ? customer.identity.name
    : merchant.identity.owner_first_name ?? merchant.identity.name;

  const digestItemId = trigger.payload?.top_item_id as string | undefined;
  const digestItem = digestItemId ? category.digest.find((d) => d.id === digestItemId) : undefined;

  const activeOffer = (merchant.offers ?? []).find((o) => o.status === "active");

  const parts: string[] = [];
  if (digestItem) {
    const cite = digestItem.source ? ` — ${digestItem.source}` : "";
    const trial = digestItem.trial_n ? ` (${digestItem.trial_n}-patient trial)` : "";
    parts.push(`${digestItem.title}${trial}${cite}.`);
  } else if (merchant.performance?.ctr != null && category.peer_stats?.median_ctr != null) {
    parts.push(
      `Your CTR is ${merchant.performance.ctr}% vs peer median ${category.peer_stats.median_ctr}% over the last ${merchant.performance.window_days ?? 30} days.`
    );
  } else {
    parts.push(`Update on your ${trigger.kind.replace(/_/g, " ")}.`);
  }
  if (activeOffer) parts.push(`Active offer: ${activeOffer.title}.`);

  const greeting = customer ? `Hi ${name}` : `Hi ${name}`;
  const cta =
    trigger.kind.includes("recall") || trigger.kind.includes("appointment")
      ? ("multi_choice" as CtaShape)
      : ("open_ended" as CtaShape);

  return {
    body: `${greeting}, ${parts.join(" ")} Want me to draft the next step?`,
    cta,
  };
}

export async function compose(
  category: CategoryContext,
  merchant: MerchantContext,
  trigger: TriggerContext,
  customer?: CustomerContext,
  options?: { timeoutMs?: number; fastPath?: boolean }
): Promise<ComposedMessage> {
  const send_as: SendAs = customer ? "merchant_on_behalf" : "vera";

  if (llmAvailable() && !options?.fastPath) {
    const factSheet = buildFactSheet(category, merchant, trigger, customer);
    const result = await completeJSON<LLMComposeOutput>(
      COMPOSER_SYSTEM_PROMPT,
      JSON.stringify(factSheet),
      options?.timeoutMs ?? COMPOSE_TIMEOUT_MS
    );

    const validated = validate(result, category);
    if (validated.ok) {
      return {
        body: validated.body,
        cta: validated.cta,
        send_as,
        suppression_key: trigger.suppression_key,
        rationale: result?.rationale ?? `Composed from trigger=${trigger.kind}`,
      };
    }

    if (DEBUG) {
      console.error(
        `[composer debug] trigger=${trigger.id} kind=${trigger.kind} merchant=${merchant.merchant_id} ` +
          `fallback_reason=${validated.reason}`
      );
    }

    const templated = composeTemplate(category, merchant, trigger, customer);
    return {
      body: templated.body,
      cta: templated.cta,
      send_as,
      suppression_key: trigger.suppression_key,
      rationale: `Deterministic template fallback for trigger=${trigger.kind} (${validated.reason}). Run with DEBUG_LLM=1 for the raw model output.`,
    };
  }

  const templated = composeTemplate(category, merchant, trigger, customer);
  return {
    body: templated.body,
    cta: templated.cta,
    send_as,
    suppression_key: trigger.suppression_key,
    rationale: `Deterministic template fallback for trigger=${trigger.kind} (no LLM API key set).`,
  };
}