/**
 * Shadow bans.
 *
 * A blocked member's messages are deleted without a warning and without a
 * notice. That silence is the feature: a spammer who is told they were caught
 * makes a new account, while one posting into the void keeps going and stays
 * visible to nobody.
 *
 * The check runs on every message, so the answer is cached per isolate for a
 * minute; `block`/`unblock` drop the cache entry immediately.
 */
import { cachesFor } from "./caches.ts";
import type { Runtime } from "./context.ts";
import { blockAdd, blockList, blockRemove, isBlocked } from "./db/repo.ts";

export type BlockRow = { userId: number; reason: string; byId: number; at: number };

const key = (chatId: number, userId: number) => `${chatId}:${userId}`;

export async function blocked(rt: Runtime, chatId: number, userId: number): Promise<boolean> {
  const cache = cachesFor(rt).blocked;
  const hit = cache.get(key(chatId, userId));
  if (hit !== undefined) return hit;
  const value = await isBlocked(rt.db, chatId, userId).catch(() => false);
  cache.set(key(chatId, userId), value);
  return value;
}

export async function block(
  rt: Runtime,
  chatId: number,
  userId: number,
  reason: string,
  byId: number,
): Promise<void> {
  await blockAdd(rt.db, { chatId, userId, reason, byId, at: rt.now() });
  cachesFor(rt).blocked.set(key(chatId, userId), true);
}

export async function unblock(rt: Runtime, chatId: number, userId: number): Promise<void> {
  await blockRemove(rt.db, chatId, userId);
  cachesFor(rt).blocked.set(key(chatId, userId), false);
}

export function listBlocked(rt: Runtime, chatId: number): Promise<BlockRow[]> {
  return blockList(rt.db, chatId);
}
