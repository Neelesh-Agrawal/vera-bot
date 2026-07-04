import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { store } from "./store.js";
import { rankTriggers } from "./decisionEngine.js";
import { compose } from "./composer.js";
import { handleReply } from "./replyEngine.js";
import { llmAvailable, llmModelName, warmUpLlm } from "./llm.js";
import {
  composeTimeoutForDeadline,
  FAST_PATH_REMAINING_MS,
  remainingMs,
  REPLY_DEADLINE_MS,
  TICK_DEADLINE_MS,
} from "./timeouts.js";
import type {
  ContextEnvelope,
  HealthzResponseBody,
  MetadataResponseBody,
  ReplyRequestBody,
  ReplyResponseBody,
  TickAction,
  TickRequestBody,
  TickResponseBody,
} from "./types.js";

const app = express();
app.use(express.json({ limit: "500kb" })); // testing-brief §5: 500 KB context payload cap

const startedAt = Date.now();
const MAX_ACTIONS_PER_TICK = 20; // testing-brief §5

// ---------------------------------------------------------------------------
// POST /v1/context
// ---------------------------------------------------------------------------
app.post("/v1/context", (req, res) => {
  const envelope = req.body as ContextEnvelope;
  if (
    !envelope?.scope ||
    !envelope?.context_id ||
    envelope?.version == null ||
    envelope?.payload == null
  ) {
    return res.status(400).json({
      accepted: false,
      reason: "invalid_scope",
      details: "missing one of scope/context_id/version/payload",
    });
  }
  if (!["category", "merchant", "customer", "trigger"].includes(envelope.scope)) {
    return res.status(400).json({
      accepted: false,
      reason: "invalid_scope",
      details: `unknown scope "${envelope.scope}"`,
    });
  }

  const result = store.upsert(envelope);

  if (result.status === "stale") {
    return res.status(409).json({
      accepted: false,
      reason: "stale_version",
      current_version: result.current_version,
    });
  }

  return res.status(200).json({
    accepted: true,
    ack_id: `ack_${envelope.context_id}_v${envelope.version}`,
    stored_at: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// POST /v1/tick
// ---------------------------------------------------------------------------
app.post("/v1/tick", async (req, res) => {
  const body = req.body as TickRequestBody;
  const availableTriggers = body?.available_triggers ?? [];
  const deadlineAt = Date.now() + TICK_DEADLINE_MS;

  const ranked = rankTriggers(availableTriggers).slice(0, MAX_ACTIONS_PER_TICK);
  const actions: TickAction[] = [];

  for (const { trigger } of ranked) {
    if (remainingMs(deadlineAt) < 500) break;

    const merchant = store.getMerchant(trigger.merchant_id);
    if (!merchant) continue;
    const category = store.getCategory(merchant.category_slug);
    if (!category) continue;
    const customer =
      trigger.scope === "customer" && trigger.customer_id
        ? store.getCustomer(trigger.customer_id)
        : undefined;
    if (trigger.scope === "customer" && !customer) continue;

    const fastPath = remainingMs(deadlineAt) < FAST_PATH_REMAINING_MS;
    const composed = await compose(category, merchant, trigger, customer, {
      timeoutMs: composeTimeoutForDeadline(deadlineAt),
      fastPath,
    });

    // /v1/tick always opens a NEW conversation (testing-brief §2.2), which
    // means this is always the first outbound in the 24h WhatsApp session
    // window -> must use a pre-approved template shape (challenge-brief.md
    // §5 constraint 1). We don't call Meta; we just report a sensible
    // template name/params as instructed.
    const conversationId = `conv_${trigger.merchant_id}_${trigger.id}_${randomUUID().slice(0, 8)}`;

    actions.push({
      conversation_id: conversationId,
      merchant_id: trigger.merchant_id,
      customer_id: customer?.customer_id ?? null,
      send_as: composed.send_as,
      trigger_id: trigger.id,
      template_name: `vera_${trigger.kind}_v1`,
      template_params: [merchant.identity.owner_first_name ?? merchant.identity.name, trigger.kind],
      body: composed.body,
      cta: composed.cta,
      suppression_key: composed.suppression_key,
      rationale: composed.rationale,
    });

    store.markSuppressed(composed.suppression_key);
    store.recordTurn(conversationId, composed.send_as, composed.body);
  }

  const response: TickResponseBody = { actions };
  return res.status(200).json(response);
});

// ---------------------------------------------------------------------------
// POST /v1/reply
// ---------------------------------------------------------------------------
app.post("/v1/reply", async (req, res) => {
  const body = req.body as ReplyRequestBody;
  if (!body?.conversation_id || !body?.message) {
    return res.status(400).json({ action: "wait", rationale: "malformed reply payload" });
  }
  const result = await new Promise<ReplyResponseBody>((resolve) => {
    const timer = setTimeout(
      () =>
        resolve({
          action: "wait",
          wait_seconds: 300,
          rationale: "Reply budget exceeded; waiting rather than risking judge timeout.",
        }),
      REPLY_DEADLINE_MS
    );
    handleReply(body, REPLY_DEADLINE_MS - 500)
      .then((r) => {
        clearTimeout(timer);
        resolve(r);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve({
          action: "wait",
          wait_seconds: 300,
          rationale: "Reply handler error; waiting to stay within judge timeout budget.",
        });
      });
  });
  return res.status(200).json(result);
});

// ---------------------------------------------------------------------------
// GET /v1/healthz
// ---------------------------------------------------------------------------
app.get("/v1/healthz", (_req, res) => {
  const response: HealthzResponseBody = {
    status: "ok",
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    contexts_loaded: store.counts(),
  };
  return res.status(200).json(response);
});

// ---------------------------------------------------------------------------
// GET /v1/metadata
// ---------------------------------------------------------------------------
app.get("/v1/metadata", (_req, res) => {
  const response: MetadataResponseBody = {
    team_name: process.env.TEAM_NAME ?? "vera-bot",
    team_members: [process.env.TEAM_MEMBER ?? process.env.TEAM_NAME ?? "vera-bot"],
    model: llmModelName(),
    approach:
      "Grounded fact-sheet assembly -> temperature-0 Groq LLM composition with hard-rule system prompt " +
      "(no fabrication, single CTA, category voice/taboo) -> validation -> template fallback. " +
      "Urgency-ranked trigger selection, dataset suppression_key used verbatim, one action per merchant per tick.",
    contact_email: process.env.CONTACT_EMAIL ?? "team@example.com",
    version: "2.0.0",
    submitted_at: new Date().toISOString(),
  };
  return res.status(200).json(response);
});

// ---------------------------------------------------------------------------
// POST /v1/teardown (optional, testing-brief §11)
// ---------------------------------------------------------------------------
app.post("/v1/teardown", (_req, res) => {
  store.reset();
  return res.status(200).json({ ok: true });
});

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`vera-bot listening on ${HOST}:${PORT} (llm=${llmAvailable() ? "on" : "off, template-only"})`);
  if (process.env.WARMUP_LLM !== "0" && llmAvailable()) {
    void warmUpLlm();
  }
});
