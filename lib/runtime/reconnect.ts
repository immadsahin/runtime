/**
 * Reconnect backoff policy for the Conversation event WebSocket.
 *
 * Extracted as a pure function so the give-up threshold and the capped
 * exponential delay are unit-testable without a live socket. The hook
 * (use-conversation-stream) owns the side effects (timers, re-subscribe); this
 * module only decides *whether* and *when* to retry.
 */

/** First retry delay; doubles each consecutive failure up to the cap. */
export const RECONNECT_BASE_MS = 500;
/** Delay ceiling — one attempt per this interval is not "hammering". */
export const RECONNECT_MAX_MS = 30_000;
/** Consecutive failures after which automatic retry stops. The hook re-arms on
 *  focus/visibility/online for the idle-suspend case, so this only ends the
 *  *automatic* loop (e.g. an endpoint that is genuinely down), not recovery. */
export const MAX_RECONNECT_ATTEMPTS = 6; // ~0.5,1,2,4,8,16s, then stop (~31s)

export type ReconnectPlan =
  | { retry: true; delayMs: number }
  | { retry: false };

/**
 * Decide the next reconnect step from the count of consecutive failed attempts.
 *
 * `attempt` is 1-based: 1 is the first retry after an initial drop. Returns a
 * capped exponential backoff delay while within budget, and `{ retry: false }`
 * once the budget is exhausted so a permanently-dead endpoint isn't retried
 * forever.
 */
export function reconnectPlan(attempt: number): ReconnectPlan {
  if (attempt > MAX_RECONNECT_ATTEMPTS) return { retry: false };
  const delayMs = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
  return { retry: true, delayMs };
}
