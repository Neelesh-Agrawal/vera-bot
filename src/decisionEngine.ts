import type { TriggerContext } from "./types.js";
import { store } from "./store.js";

export interface RankedTrigger {
  trigger: TriggerContext;
}

/**
 * Ranks the judge-provided `available_triggers` by urgency (1-5, from the
 * trigger context itself — no need to invent our own weighting scheme
 * since the dataset already encodes it). Keeps at most ONE trigger per
 * merchant per tick (testing-brief §14 FAQ: "only one action per
 * (merchant_id, conversation_id) pair per tick" — since /v1/tick always
 * starts a new conversation, this collapses to one per merchant), and
 * drops anything whose suppression_key has already fired this test run.
 */
export function rankTriggers(availableTriggerIds: string[]): RankedTrigger[] {
  const candidates = availableTriggerIds
    .map((id) => store.getTrigger(id))
    .filter((t): t is TriggerContext => Boolean(t))
    .filter((t) => !store.isSuppressed(t.suppression_key));

  const bestPerMerchant = new Map<string, TriggerContext>();
  for (const t of candidates) {
    const current = bestPerMerchant.get(t.merchant_id);
    if (!current || t.urgency > current.urgency) {
      bestPerMerchant.set(t.merchant_id, t);
    }
  }

  return [...bestPerMerchant.values()]
    .sort((a, b) => b.urgency - a.urgency)
    .map((trigger) => ({ trigger }));
}
