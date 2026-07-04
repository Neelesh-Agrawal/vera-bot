# vera-bot — magicpin AI Challenge

**Team:** Neelesh · **Model:** Groq `qwen/qwen3.6-27b` (temp 0) · **Contact:** neeleshagrawal24@gmail.com

Live HTTP bot implementing the 5-endpoint contract from `challenge-testing-brief.md`. Primary judged surface is your **public URL**; this repo also ships `bot.py` + `submission.jsonl` per `challenge-brief.md` §7.

## Approach

1. **Context store** — in-memory upsert with version/409 semantics; suppression keys tracked per merchant.
2. **Tick** — rank triggers by dataset `urgency`, one action per merchant, skip suppressed keys; compose via grounded fact sheet → LLM (temp 0) → taboo/CTA validation → template fallback only on failure.
3. **Reply** — auto-reply detection (3+ identical texts across conversations), hostile/opt-out → end, explicit commitment → action mode, else on-mission follow-up.

## Tradeoffs

- **LLM-primary, template-fallback** — templates pass spec but can't hit case-study quality across 20+ trigger kinds; LLM path is default when `GROQ_API_KEY` is set.
- **In-memory store** — simple and fast for the 60-minute test window; no Redis (acceptable on free-tier always-on host if no restarts).
- **Groq free tier** — throttled to ~30 RPM in `llm.ts`; tick returns within 30s budget.

## What would have helped most

- Merchant conversation history in context (beyond inbound text in `/v1/reply`).
- Post-tick performance deltas (judge injects these; we handle via fresh `/v1/context` pushes).
- Explicit language-preference field usage per merchant.

---

## Deploy (Render)

**Cold starts are the #1 failure mode on free tier.** The judge calls `/v1/healthz` unpredictably; 3 failed probes = offline penalty.

### Option A — Always-on (recommended)

In `render.yaml`, switch `plan: free` → `plan: starter` (~$7/mo). No spin-down, no surprises.

### Option B — Free tier + keep-alive

1. Deploy on Render free as usual.
2. GitHub → **Settings → Secrets → Actions** → add `BOT_PUBLIC_URL` = `https://your-bot.onrender.com`
3. Enable Actions — `.github/workflows/keepalive.yml` pings `/v1/healthz` every **10 minutes** so the service never sleeps.

Alternative: [cron-job.org](https://cron-job.org) → GET your URL `/v1/healthz` every 10 min.

### Deploy steps

1. Push repo to GitHub.
2. [Render](https://render.com) → **New Blueprint** → connect repo.
3. Set env vars: `GROQ_API_KEY`, `TEAM_NAME`, `TEAM_MEMBER`, `CONTACT_EMAIL`.
4. Deploy → verify `curl https://YOUR-URL/v1/healthz`.
5. Enable keep-alive (Option B) or upgrade plan (Option A).
6. Submit **public URL** via the challenge portal.

### Built-in reliability

- **28s tick/reply deadline** — always responds before the judge's 30s timeout.
- **LLM warm-up on boot** — first tick after a restart is faster.
- **Fast-path templates** — if the tick clock is almost out, skips LLM rather than timing out.

## Local dev

```bash
npm install
cp .env.example .env    # add GROQ_API_KEY
npm run dev             # :8787
npm run load-dataset    # push base dataset to running bot
npm run judge-replay    # deterministic pass/fail (no LLM key needed)
npm run generate-submission   # writes submission.jsonl (30 lines)
```

## Submission checklist

- [ ] Bot deployed at public URL; `/v1/healthz` returns `status: ok`
- [ ] `/v1/metadata` has team name, model, contact email
- [ ] `npm run judge-replay` — all PASS
- [ ] `submission.jsonl` generated (`npm run generate-submission`) — 30/30 lines
- [ ] URL submitted via portal; attach `bot.py`, `submission.jsonl`, this README if requested

## Files

| File | Purpose |
|------|---------|
| `src/server.ts` | HTTP API (source of truth for judging) |
| `src/composer.ts` | `compose()` — LLM + validation + fallback |
| `bot.py` | Offline `compose()` shim for batch eval |
| `submission.jsonl` | 30 canonical test-pair outputs |
| `judge_simulator.py` | Local judge harness (optional) |
