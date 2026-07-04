/** One-off: re-encode submission.jsonl with \\uXXXX escapes (no LLM calls). */
import { readFileSync, writeFileSync } from "node:fs";

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

const lines = readFileSync("submission.jsonl", "utf-8").trim().split("\n");
writeFileSync(
  "submission.jsonl",
  lines.map((l) => stringifyAsciiSafe(JSON.parse(l))).join("\n") + "\n",
  "utf-8"
);
console.log(`Re-encoded ${lines.length} lines with \\uXXXX escapes`);
