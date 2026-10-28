/**
 * Flood control — sliding window, in memory.
 *
 * Per isolate, not global: a Worker has no shared memory and writing the window
 * to KV on every message would burn the whole daily write quota plus 5–20 ms of
 * latency per message. Flood shaping is approximate by nature, so approximate
 * is the right trade; the durable record lives in the event log instead.
 */
import { cachesFor } from "./caches.ts";

export type FloodState = { exceeded: boolean; count: number };

export function trackFlood(
  runtime: object,
  chatId: number,
  userId: number,
  limit: number,
  windowSeconds: number,
  nowMs: number,
): FloodState {
  if (limit <= 0 || !userId) return { exceeded: false, count: 0 };
  const windows = cachesFor(runtime).flood;
  const key = `${chatId}:${userId}`;
  const windowMs = windowSeconds * 1000;
  const stamps = (windows.get(key) ?? []).filter((at) => nowMs - at < windowMs);
  stamps.push(nowMs);
  // Keep at most 2× the limit: enough to keep counting, small enough to stay cheap.
  windows.set(key, stamps.slice(-Math.max(4, limit * 2)));
  return { exceeded: stamps.length > limit, count: stamps.length };
}

// ---------------------------------------------------------------------------
// Join rate (raid protection)
// ---------------------------------------------------------------------------



/**
 * How many people joined this chat inside the window.
 *
 * A raid is a burst, not a pattern, so the count is all that is needed: the
 * caller decides between "tell an admin" and "lock the group".
 */
export function trackJoin(runtime: object, chatId: number, windowSeconds: number, nowMs: number): number {
  const joins = cachesFor(runtime).joins;
  const key = String(chatId);
  const windowMs = Math.max(5, windowSeconds) * 1000;
  const stamps = (joins.get(key) ?? []).filter((at) => nowMs - at < windowMs);
  stamps.push(nowMs);
  joins.set(key, stamps.slice(-500));
  return stamps.length;
}
