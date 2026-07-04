/**
 * Warmup loader: pushes the base dataset (categories + merchants + customers,
 * NOT triggers — triggers arrive during the test window per
 * challenge-testing-brief.md §4 Phase 1) to a running bot instance.
 *
 * Usage:
 *   npm run dev                              # in one terminal
 *   BOT_URL=http://localhost:8787 npm run load-dataset   # in another
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BOT_URL = process.env.BOT_URL ?? "http://localhost:8787";
const DATASET_DIR = fileURLToPath(new URL("../../dataset", import.meta.url));

async function pushContext(scope: string, contextId: string, payload: unknown) {
  const res = await fetch(`${BOT_URL}/v1/context`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope,
      context_id: contextId,
      version: 1,
      payload,
      delivered_at: new Date().toISOString(),
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.accepted) {
    console.error(`  FAIL ${scope}/${contextId}: ${res.status}`, data);
  }
  return res.ok;
}

async function loadDir(scope: string, dirName: string, idField: string) {
  const dir = join(DATASET_DIR, dirName);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  let ok = 0;
  for (const file of files) {
    const payload = JSON.parse(readFileSync(join(dir, file), "utf-8"));
    const id = payload[idField];
    if (!id) {
      console.warn(`  skip ${file}: no ${idField}`);
      continue;
    }
    if (await pushContext(scope, id, payload)) ok++;
  }
  console.log(`Loaded ${ok}/${files.length} ${scope} contexts`);
}

async function main() {
  await loadDir("category", "categories", "slug");
  await loadDir("merchant", "merchants", "merchant_id");
  await loadDir("customer", "customers", "customer_id");

  const healthz = await fetch(`${BOT_URL}/v1/healthz`).then((r) => r.json());
  console.log("healthz after load:", healthz);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
