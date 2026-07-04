/** Judge per-call budget is 30s (challenge-testing-brief.md §5). Leave headroom. */
export const TICK_DEADLINE_MS = Number(process.env.TICK_DEADLINE_MS ?? 28_000);
export const REPLY_DEADLINE_MS = Number(process.env.REPLY_DEADLINE_MS ?? 28_000);
export const COMPOSE_TIMEOUT_MS = Number(process.env.COMPOSE_TIMEOUT_MS ?? 22_000);

/** Skip LLM when less than this remains on the tick clock — template is instant. */
export const FAST_PATH_REMAINING_MS = Number(process.env.FAST_PATH_REMAINING_MS ?? 6_000);

export function remainingMs(deadlineAt: number): number {
  return deadlineAt - Date.now();
}

export function composeTimeoutForDeadline(deadlineAt: number): number {
  const left = remainingMs(deadlineAt) - 500;
  if (left <= 0) return 1_000;
  return Math.min(COMPOSE_TIMEOUT_MS, left);
}
