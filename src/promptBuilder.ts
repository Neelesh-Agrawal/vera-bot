import type { CategoryContext, CustomerContext, MerchantContext, TriggerContext } from "./types.js";

/** Pull the digest item referenced by trigger.payload.top_item_id, if any. */
function resolveDigestItem(category: CategoryContext, trigger: TriggerContext) {
  const topItemId = trigger.payload?.top_item_id as string | undefined;
  if (!topItemId) return undefined;
  return category.digest.find((d) => d.id === topItemId);
}

function activeOffers(merchant: MerchantContext) {
  return (merchant.offers ?? []).filter((o) => o.status === "active");
}

/**
 * Assembles ONLY the facts relevant to this composition into a compact JSON
 * object. Deliberately excludes irrelevant category/merchant fields so the
 * LLM has less surface area to hallucinate from, and so token usage stays
 * small enough to keep /v1/tick well under the 30s budget.
 */
export function buildFactSheet(
  category: CategoryContext,
  merchant: MerchantContext,
  trigger: TriggerContext,
  customer?: CustomerContext
) {
  const digestItem = resolveDigestItem(category, trigger);

  return {
    category: {
      slug: category.slug,
      voice: category.voice,
      relevant_offers: category.offer_catalog.slice(0, 6),
      peer_stats: category.peer_stats,
    },
    merchant: {
      name: merchant.identity.name,
      owner_first_name: merchant.identity.owner_first_name,
      locality: merchant.identity.locality,
      city: merchant.identity.city,
      languages: merchant.identity.languages,
      performance: merchant.performance,
      active_offers: activeOffers(merchant),
      signals: merchant.signals,
      customer_aggregate: merchant.customer_aggregate,
      review_themes: merchant.review_themes,
      last_conversation_turns: (merchant.conversation_history ?? []).slice(-2),
    },
    trigger: {
      kind: trigger.kind,
      scope: trigger.scope,
      source: trigger.source,
      urgency: trigger.urgency,
      payload: trigger.payload,
      digest_item: digestItem,
    },
    customer: customer
      ? {
          name: customer.identity.name,
          language_pref: customer.identity.language_pref,
          state: customer.state,
          relationship: customer.relationship,
          preferences: customer.preferences,
        }
      : null,
  };
}

export const COMPOSER_SYSTEM_PROMPT = `You are the composition engine for "Vera," magicpin's merchant-growth WhatsApp assistant.

You will be given a JSON "fact sheet" assembled from four context layers: category, merchant, trigger, and (optionally) customer. Produce ONE outbound WhatsApp message.

HARD RULES (violating any of these is scored as a failure):
1. Never invent a number, date, name, offer, citation, or claim that is not present in the fact sheet. If the fact sheet doesn't have it, don't say it.
2. Anchor the message on a concrete, verifiable fact from the fact sheet (a number, date, headline, or source) — never generic framing like "boost your sales" or "X% off".
3. Exactly one call-to-action, placed at the end. Never stack multiple asks ("Reply YES for X, NO for Y").
4. Match category voice exactly: use category.voice.vocab_allowed where natural, and NEVER use any word in category.voice.vocab_taboo.
5. If "customer" is present in the fact sheet, you are drafting a message the MERCHANT sends to THEIR OWN customer — write it in the merchant's voice, honor customer.language_pref (Hindi-English code-mix is expected when language_pref includes "hi"), and never use clinical/medical guarantee language toward customers regardless of category.
6. If "customer" is null, you are messaging the merchant directly as Vera — peer-to-peer tone, technical vocabulary from vocab_allowed is welcome.
7. Use the owner's first name or merchant name when available — never a bare "Hi".
8. No long preambles ("I hope you're doing well..."). No re-introducing yourself if last_conversation_turns shows prior contact.
9. Keep it WhatsApp-length: a few sentences, not a paragraph wall.
10. If trigger.source is "external" and cites research/compliance, include the source (e.g. journal + date + page, or regulation name) — an uncited claim scores near zero on specificity.

Respond ONLY with this JSON (no markdown fences, no preamble):
{
  "body": "<the message text>",
  "cta": "yes_no" | "open_ended" | "multi_choice" | "none",
  "rationale": "<one sentence: why this message, why now, grounded in which fact>"
}`;
