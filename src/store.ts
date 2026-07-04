import type {
  CategoryContext,
  ContextEnvelope,
  ContextScope,
  CustomerContext,
  MerchantContext,
  TriggerContext,
} from "./types.js";

interface StoredEntry<T> {
  version: number;
  payload: T;
}

export type UpsertResult =
  | { status: "accepted" }
  | { status: "noop_same_version" }
  | { status: "stale"; current_version: number };

/**
 * Single-process in-memory store, matching challenge-testing-brief.md §2.1:
 * - same version as stored -> no-op (still a successful ack)
 * - lower version than stored -> "stale" (409)
 * - higher version -> replace
 *
 * Resets on process restart, which is fine within one 60-min test window
 * (testing-brief §12: "in-memory is fine; no restarts during test").
 */
class ContextStore {
  private categories = new Map<string, StoredEntry<CategoryContext>>();
  private merchants = new Map<string, StoredEntry<MerchantContext>>();
  private customers = new Map<string, StoredEntry<CustomerContext>>();
  private triggers = new Map<string, StoredEntry<TriggerContext>>();

  // suppression_key -> sent (per test run; brief doesn't specify a cadence
  // window beyond "dedup", so once sent within this run, suppressed until
  // teardown)
  private sentSuppressionKeys = new Set<string>();

  // conversation_id -> full turn history (both sides)
  private conversations = new Map<string, Array<{ from: string; message: string; ts: string }>>();

  // merchant_id -> recent inbound message texts (normalized), for
  // cross-conversation auto-reply detection (judge_simulator.py issues a
  // NEW conversation_id per turn in its auto-reply-hell scenario, so
  // detection must be keyed by merchant, not by conversation)
  private merchantInboundHistory = new Map<string, string[]>();

  private mapFor(scope: ContextScope) {
    switch (scope) {
      case "category":
        return this.categories;
      case "merchant":
        return this.merchants;
      case "customer":
        return this.customers;
      case "trigger":
        return this.triggers;
    }
  }

  upsert(envelope: ContextEnvelope): UpsertResult {
    const map = this.mapFor(envelope.scope) as Map<string, StoredEntry<unknown>>;
    const existing = map.get(envelope.context_id);
    if (existing) {
      if (envelope.version === existing.version) return { status: "noop_same_version" };
      if (envelope.version < existing.version) {
        return { status: "stale", current_version: existing.version };
      }
    }
    map.set(envelope.context_id, { version: envelope.version, payload: envelope.payload });
    return { status: "accepted" };
  }

  getCategory(slug: string): CategoryContext | undefined {
    return this.categories.get(slug)?.payload;
  }
  getMerchant(id: string): MerchantContext | undefined {
    return this.merchants.get(id)?.payload;
  }
  getCustomer(id: string): CustomerContext | undefined {
    return this.customers.get(id)?.payload;
  }
  getTrigger(id: string): TriggerContext | undefined {
    return this.triggers.get(id)?.payload;
  }
  allMerchants(): MerchantContext[] {
    return [...this.merchants.values()].map((e) => e.payload);
  }

  counts() {
    return {
      category: this.categories.size,
      merchant: this.merchants.size,
      customer: this.customers.size,
      trigger: this.triggers.size,
    };
  }

  // ---- suppression ----
  isSuppressed(key: string): boolean {
    return this.sentSuppressionKeys.has(key);
  }
  markSuppressed(key: string) {
    this.sentSuppressionKeys.add(key);
  }

  // ---- conversation + auto-reply tracking ----
  recordTurn(conversationId: string, from: string, message: string) {
    const turns = this.conversations.get(conversationId) ?? [];
    turns.push({ from, message, ts: new Date().toISOString() });
    this.conversations.set(conversationId, turns);
  }
  getConversation(conversationId: string) {
    return this.conversations.get(conversationId) ?? [];
  }

  /** Returns how many times (including this one) this exact text has been
   * seen from this merchant across ALL conversations. */
  recordInboundAndCount(merchantId: string, message: string): number {
    const norm = message.trim().toLowerCase();
    const history = this.merchantInboundHistory.get(merchantId) ?? [];
    history.push(norm);
    this.merchantInboundHistory.set(merchantId, history);
    return history.filter((m) => m === norm).length;
  }

  /** Wipe all state — called on POST /v1/teardown. */
  reset() {
    this.categories.clear();
    this.merchants.clear();
    this.customers.clear();
    this.triggers.clear();
    this.sentSuppressionKeys.clear();
    this.conversations.clear();
    this.merchantInboundHistory.clear();
  }
}

export const store = new ContextStore();
