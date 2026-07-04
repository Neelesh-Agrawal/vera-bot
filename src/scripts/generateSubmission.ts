/**
 * Generates submission.jsonl — the 30-line artifact challenge-brief.md §7.2
 * asks for, one line per canonical (merchant, trigger[, customer]) test
 * pair — by calling compose() directly (no HTTP round-trip, no running
 * server needed). Useful both as the required deliverable and as a fast
 * way to eyeball message quality across all 30 pairs at once.
 *
 * Usage: npm run generate-submission
 * Writes: ./submission.jsonl
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compose } from "../composer.js";
import type { CategoryContext, CustomerContext, MerchantContext, TriggerContext } from "../types.js";

const DATASET_DIR = fileURLToPath(new URL("../../dataset", import.meta.url));

function loadJSON<T>(rel: string): T {
  return JSON.parse(readFileSync(join(DATASET_DIR, rel), "utf-8")) as T;
}

interface TestPair {
  test_id: string;
  trigger_id: string;
  merchant_id: string;
  customer_id: string | null;
}

/**
 * JSON.stringify leaves Unicode as raw UTF-8 (₹, –, Hindi). That garbles in
 * some terminals (PowerShell default encoding). Escape non-ASCII to \\uXXXX
 * per JSON spec — parsers still decode to the correct characters.
 */
function stringifyAsciiSafe(value: unknown): string {
  const json = JSON.stringify(value);
  return json.replace(/[^\x20-\x7E]/g, (ch) => {
    const cp = ch.codePointAt(0)!;
    if (cp > 0xffff) {
      const u = cp - 0x10000;
      const high = (u >> 10) + 0xd800;
      const low = (u & 0x3ff) + 0xdc00;
      return `\\u${high.toString(16).padStart(4, "0")}\\u${low.toString(16).padStart(4, "0")}`;
    }
    return `\\u${cp.toString(16).padStart(4, "0")}`;
  });
}

async function main() {
  const { pairs } = loadJSON<{ pairs: TestPair[] }>("test_pairs.json");

  const lines: string[] = [];
  let ok = 0;

  for (const pair of pairs) {
    try {
      const trigger = loadJSON<TriggerContext>(`triggers/${pair.trigger_id}.json`);
      const merchant = loadJSON<MerchantContext>(`merchants/${pair.merchant_id}.json`);
      const category = loadJSON<CategoryContext>(`categories/${merchant.category_slug}.json`);
      const customer = pair.customer_id
        ? loadJSON<CustomerContext>(`customers/${pair.customer_id}.json`)
        : undefined;

      const composed = await compose(category, merchant, trigger, customer);

      lines.push(
        stringifyAsciiSafe({
          test_id: pair.test_id,
          body: composed.body,
          cta: composed.cta,
          send_as: composed.send_as,
          suppression_key: composed.suppression_key,
          rationale: composed.rationale,
        })
      );
      ok++;
      console.log(`[${pair.test_id}] ok (${composed.send_as}, ${composed.cta})`);
      // Groq free tier: 30 RPM — pace requests to avoid rate-limit fallbacks
      await new Promise((r) => setTimeout(r, 2600));
    } catch (e) {
      console.error(`[${pair.test_id}] FAILED:`, (e as Error).message);
    }
  }

  writeFileSync("submission.jsonl", lines.join("\n") + "\n", "utf-8");
  console.log(`\nWrote ${ok}/${pairs.length} lines to submission.jsonl`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
