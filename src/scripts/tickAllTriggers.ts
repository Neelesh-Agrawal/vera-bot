/** Tick all 100 triggers in batches — checks for timeouts/errors. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BOT_URL = process.env.BOT_URL ?? "http://localhost:8787";
const DATASET = fileURLToPath(new URL("../../dataset", import.meta.url));

function load<T>(rel: string): T {
  return JSON.parse(readFileSync(join(DATASET, rel), "utf-8")) as T;
}

async function post(path: string, body: unknown) {
  const start = Date.now();
  const res = await fetch(`${BOT_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data, ms: Date.now() - start };
}

async function main() {
  await post("/v1/teardown", {});

  for (const f of readdirSync(join(DATASET, "categories")).filter((x) => x.endsWith(".json"))) {
    const p = load<{ slug: string }>(`categories/${f}`);
    await post("/v1/context", { scope: "category", context_id: p.slug, version: 1, payload: p, delivered_at: new Date().toISOString() });
  }
  for (const f of readdirSync(join(DATASET, "merchants")).filter((x) => x.endsWith(".json"))) {
    const p = load<{ merchant_id: string }>(`merchants/${f}`);
    await post("/v1/context", { scope: "merchant", context_id: p.merchant_id, version: 1, payload: p, delivered_at: new Date().toISOString() });
  }
  for (const f of readdirSync(join(DATASET, "customers")).filter((x) => x.endsWith(".json"))) {
    const p = load<{ customer_id: string }>(`customers/${f}`);
    await post("/v1/context", { scope: "customer", context_id: p.customer_id, version: 1, payload: p, delivered_at: new Date().toISOString() });
  }
  const triggerIds = readdirSync(join(DATASET, "triggers"))
    .filter((x) => x.endsWith(".json"))
    .map((f) => {
      const p = load<{ id: string }>(`triggers/${f}`);
      return p.id;
    });

  for (const f of readdirSync(join(DATASET, "triggers")).filter((x) => x.endsWith(".json"))) {
    const p = load<{ id: string }>(`triggers/${f}`);
    await post("/v1/context", { scope: "trigger", context_id: p.id, version: 1, payload: p, delivered_at: new Date().toISOString() });
  }

  let errors = 0;
  let maxMs = 0;
  let totalActions = 0;

  for (let i = 0; i < triggerIds.length; i += 10) {
    const batch = triggerIds.slice(i, i + 10);
    const { status, data, ms } = await post("/v1/tick", { now: new Date().toISOString(), available_triggers: batch });
    maxMs = Math.max(maxMs, ms);
    if (status !== 200) {
      console.error(`Batch ${i / 10 + 1} HTTP ${status}`);
      errors++;
      continue;
    }
    const n = data?.actions?.length ?? 0;
    totalActions += n;
    console.log(`Batch ${i / 10 + 1}: ${n} actions in ${ms}ms`);
  }

  console.log(`\nDone: ${errors} errors, ${totalActions} total actions, max tick latency ${maxMs}ms`);
  process.exit(errors > 0 ? 1 : 0);
}

main();