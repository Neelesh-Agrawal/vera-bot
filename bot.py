"""
bot.py — magicpin AI Challenge submission shim.

The live judged surface is the HTTP API (challenge-testing-brief.md):
  POST /v1/context, /v1/tick, /v1/reply
  GET  /v1/healthz, /v1/metadata

This module exposes the offline compose() contract from challenge-brief.md §7.1
for batch evaluation (submission.jsonl). The TypeScript implementation in
src/composer.ts is the source of truth; run `npm run generate-submission`
to produce submission.jsonl.

Deploy the HTTP server (npm run build && npm start) and submit the public URL.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
DATASET = ROOT / "dataset"


def compose(
    category: dict,
    merchant: dict,
    trigger: dict,
    customer: dict | None = None,
) -> dict:
    """
    Offline compose hook. Requires Node.js and `npm install` once.
    For production judging, use the HTTP server instead.
    """
    payload = {
        "category": category,
        "merchant": merchant,
        "trigger": trigger,
        "customer": customer,
    }
    script = """
import { compose } from './composer.js';
const input = JSON.parse(process.argv[1]);
const result = await compose(input.category, input.merchant, input.trigger, input.customer ?? undefined);
console.log(JSON.stringify(result));
"""
    # Inline one-shot via tsx
    proc = subprocess.run(
        ["npx", "tsx", "-e", script, json.dumps(payload)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        shell=sys.platform == "win32",
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr or "compose failed")
    return json.loads(proc.stdout.strip())


if __name__ == "__main__":
    print("vera-bot HTTP server: npm run dev  (default :8787)")
    print("Generate submission.jsonl: npm run generate-submission")
    print("Local judge (replay): npm run judge-replay")
