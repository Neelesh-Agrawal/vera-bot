/**
 * Spec edge-case stress tests — no LLM key required.
 * Usage: BOT_URL=http://localhost:8787 npm run stress-test
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CategoryContext, MerchantContext, TriggerContext } from "../types.js";

const BOT_URL = process.env.BOT_URL ?? "http://localhost:8787";
const DATASET = fileURLToPath(new URL("../../dataset", import.meta.url));

let passed = 0;
let failed = 0;

function ok(label: string) {
  passed++;
  console.log(`  [PASS] ${label}`);
}
function fail(label: string, detail?: string) {
  failed++;
  console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${BOT_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function get(path: string) {
  const res = await fetch(`${BOT_URL}${path}`);
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function loadJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(DATASET, rel), "utf-8")) as T;
}

async function main() {
  console.log(`\nStress tests against ${BOT_URL}\n`);

  // Reset
  await post("/v1/teardown", {});

  // 1. Malformed context -> 400
  {
    const { status } = await post("/v1/context", { scope: "merchant" });
    status === 400 ? ok("malformed context returns 400") : fail("malformed context", `got ${status}`);
  }

  // 2. Stale version -> 409
  {
    const merchant = loadJson<Record<string, unknown>>("merchants/m_001_drmeera_dentist_delhi.json");
    await post("/v1/context", {
      scope: "merchant",
      context_id: merchant.merchant_id,
      version: 2,
      payload: merchant,
      delivered_at: new Date().toISOString(),
    });
    const { status, data } = await post("/v1/context", {
      scope: "merchant",
      context_id: merchant.merchant_id,
      version: 1,
      payload: merchant,
      delivered_at: new Date().toISOString(),
    });
    status === 409 && data?.reason === "stale_version"
      ? ok("stale version returns 409")
      : fail("stale version", `status=${status}`);
  }

  // 3. Tick with unknown merchant trigger -> empty actions, no crash
  {
    const trigger = loadJson<Record<string, unknown>>("triggers/trg_001_research_digest_dentists.json");
    await post("/v1/context", { scope: "trigger", context_id: trigger.id, version: 1, payload: trigger, delivered_at: new Date().toISOString() });
    const { status, data } = await post("/v1/tick", { now: new Date().toISOString(), available_triggers: [trigger.id] });
    status === 200 && Array.isArray(data?.actions) && data.actions.length === 0
      ? ok("tick skips trigger when merchant context missing (no crash)")
      : fail("tick unknown merchant", JSON.stringify(data));
  }

  // 4. Load minimal contexts and tick
  await post("/v1/teardown", {});
  const category = loadJson<CategoryContext>("categories/dentists.json");
  const merchant = loadJson<MerchantContext>("merchants/m_001_drmeera_dentist_delhi.json");
  const trigger = loadJson<TriggerContext>("triggers/trg_001_research_digest_dentists.json");
  for (const [scope, id, payload] of [
    ["category", "dentists", category],
    ["merchant", merchant.merchant_id, merchant],
    ["trigger", trigger.id, trigger],
  ] as const) {
    await post("/v1/context", { scope, context_id: id, version: 1, payload, delivered_at: new Date().toISOString() });
  }

  // 5. Merchant with no offers / performance stripped
  {
    const bare = { ...merchant, offers: [], performance: undefined, signals: undefined };
    await post("/v1/context", { scope: "merchant", context_id: merchant.merchant_id, version: 2, payload: bare, delivered_at: new Date().toISOString() });
    const { status, data } = await post("/v1/tick", { now: new Date().toISOString(), available_triggers: [trigger.id] });
    status === 200 && data?.actions?.[0]?.body
      ? ok("tick works with merchant missing offers/performance")
      : fail("bare merchant tick", JSON.stringify(data));
  }

  // 6. 25 triggers -> cap at 20 actions
  {
    await post("/v1/teardown", {});
    const merchants = readdirSync(join(DATASET, "merchants")).filter((f) => f.endsWith(".json")).slice(0, 25);
    const triggerIds: string[] = [];
    for (const file of merchants) {
      const m = loadJson<MerchantContext>(`merchants/${file}`);
      const cat = loadJson<CategoryContext>(`categories/${m.category_slug}.json`);
      await post("/v1/context", { scope: "category", context_id: m.category_slug, version: 1, payload: cat, delivered_at: new Date().toISOString() });
      await post("/v1/context", { scope: "merchant", context_id: m.merchant_id, version: 1, payload: m, delivered_at: new Date().toISOString() });
      const tid = `trg_stress_${m.merchant_id}`;
      const t = { ...trigger, id: tid, merchant_id: m.merchant_id, suppression_key: `stress:${m.merchant_id}` } as TriggerContext;
      await post("/v1/context", { scope: "trigger", context_id: tid, version: 1, payload: t, delivered_at: new Date().toISOString() });
      triggerIds.push(tid);
    }
    const { status, data } = await post("/v1/tick", { now: new Date().toISOString(), available_triggers: triggerIds });
    const n = data?.actions?.length ?? 0;
    status === 200 && n <= 20 ? ok(`tick caps actions at 20 (got ${n})`) : fail("20-action cap", `got ${n}`);
  }

  // 7. Reply on unknown conversation_id
  {
    const { status, data } = await post("/v1/reply", {
      conversation_id: "conv_never_seen",
      merchant_id: "m_001_drmeera_dentist_delhi",
      customer_id: null,
      from_role: "merchant",
      message: "What are my options?",
      received_at: new Date().toISOString(),
      turn_number: 1,
    });
    status === 200 && ["send", "wait", "end"].includes(data?.action)
      ? ok(`reply on unknown conversation returns action=${data.action}`)
      : fail("unknown conversation reply", JSON.stringify(data));
  }

  // 8. Taboo words — scan template-mode submission bodies
  {
    const cats = readdirSync(join(DATASET, "categories")).filter((f) => f.endsWith(".json"));
    let tabooHits = 0;
    for (const file of cats) {
      const cat = loadJson<CategoryContext>(`categories/${file}`);
      const taboos = cat.voice.vocab_taboo ?? [];
      // sample one merchant + trigger per category
      const mFile = readdirSync(join(DATASET, "merchants")).find((f) => {
        const m = loadJson<{ category_slug: string }>(`merchants/${f}`);
        return m.category_slug === cat.slug;
      });
      if (!mFile) continue;
      const m = loadJson<MerchantContext>(`merchants/${mFile}`);
      const tFile = readdirSync(join(DATASET, "triggers")).find((f) => {
        const t = loadJson<TriggerContext>(`triggers/${f}`);
        return t.merchant_id === m.merchant_id;
      });
      if (!tFile) continue;
      const t = loadJson<TriggerContext>(`triggers/${tFile}`);
      const { compose } = await import("../composer.js");
      const msg = await compose(cat, m, t);
      const lower = msg.body.toLowerCase();
      for (const taboo of taboos) {
        if (lower.includes(taboo.toLowerCase())) tabooHits++;
      }
    }
    tabooHits === 0 ? ok("no category taboo words in template compositions") : fail("taboo leak", `${tabooHits} hits`);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
