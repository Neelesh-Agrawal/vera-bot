/**
 * 5+ turn /v1/reply replay — checks on-mission LLM follow-ups, no verbatim repeat.
 * Usage: BOT_URL=http://localhost:8787 npx tsx src/scripts/multiTurnReplay.ts
 */
import "dotenv/config";

const BOT_URL = process.env.BOT_URL ?? "http://localhost:8787";

async function reply(convId: string, merchantId: string, message: string, turn: number) {
  const res = await fetch(`${BOT_URL}/v1/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversation_id: convId,
      merchant_id: merchantId,
      customer_id: null,
      from_role: "merchant",
      message,
      received_at: new Date().toISOString(),
      turn_number: turn,
    }),
  });
  return res.json() as Promise<{ action: string; body?: string; rationale?: string }>;
}

async function main() {
  const convId = "conv_multiturn_test_1";
  const mid = "m_001_drmeera_dentist_delhi";

  const turns = [
    "Tell me more about that JIDA paper you mentioned.",
    "How would that apply to my high-risk adult patients specifically?",
    "Can you also help me file my GST return?", // off-topic curveball
    "Ok that makes sense. What would the WhatsApp draft actually say?",
    "Sounds good, lets do it.",
  ];

  const bodies: string[] = [];
  console.log(`Multi-turn replay against ${BOT_URL}\n`);

  for (let i = 0; i < turns.length; i++) {
    const turn = i + 1;
    console.log(`--- Turn ${turn} (merchant) ---`);
    console.log(`> ${turns[i]}`);
    const out = await reply(convId, mid, turns[i], turn);
    console.log(`< action=${out.action}`);
    if (out.body) {
      console.log(`< ${out.body.slice(0, 200)}${out.body.length > 200 ? "..." : ""}`);
      bodies.push(out.body.trim().toLowerCase());
    }
    console.log(`  rationale: ${out.rationale?.slice(0, 100)}...\n`);
    await new Promise((r) => setTimeout(r, 3000));
  }

  const dupes = bodies.filter((b, i) => bodies.indexOf(b) !== i);
  if (dupes.length) console.warn("WARN: verbatim repeat detected:", dupes[0]?.slice(0, 80));
  else console.log("PASS: no verbatim repeats across follow-up bodies");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
