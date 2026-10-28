/**
 * Member roster + speaking leaderboard, batched like the hot words.
 *
 * Counting happens in memory; the day's per-member deltas reach D1 in one
 * batched upsert when the buffer grows past 40 entries or ten minutes pass —
 * the same budget `ai/words.ts` uses. A leaderboard that costs one write per
 * message is not a leaderboard, it is a bill.
 *
 * The roster write (`members`) is throttled to once per member per hour: names
 * stay current (a cheap answer to "who renamed themselves"), and a chatty
 * member costs one row write per hour, not per message.
 */
import { cachesFor } from "./caches.ts";
import type { Runtime } from "./context.ts";
import { dayKey } from "./ai/words.ts";
import { memberStatsBump, memberTopDay, memberUpsert } from "./db/repo.ts";

export const MEMBER_FLUSH_AT = 40;
export const MEMBER_FLUSH_EVERY_MS = 10 * 60_000;
const TOUCH_THROTTLE_MS = 3_600_000;

type MemberBucket = { day: string; counts: Map<number, number> };

/** Count one message for `userId`. Swallows everything, like every stat path. */
export async function bumpMemberStat(rt: Runtime, chatId: number, userId: number): Promise<void> {
  try {
    const day = dayKey(rt.now(), rt.tzOffset);
    const key = `${chatId}:${day}`;
    const cache = cachesFor(rt).memberStats;
    let bucket = cache.get(key);
    if (!bucket || bucket.day !== day) {
      bucket = { day, counts: new Map() };
      cache.set(key, bucket);
    }
    bucket.counts.set(userId, (bucket.counts.get(userId) ?? 0) + 1);

    const flushedAt = cachesFor(rt).memberStatsFlushedAt;
    const last = flushedAt.get(chatId);
    if (last === undefined) flushedAt.set(chatId, rt.now());
    if (bucket.counts.size >= MEMBER_FLUSH_AT || (last !== undefined && rt.now() - last >= MEMBER_FLUSH_EVERY_MS)) {
      await flushMemberStats(rt, chatId, bucket);
    }
  } catch (err) {
    console.log(`member stats: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Write the current buffer and clear it. Idempotent. */
export async function flushMemberStats(rt: Runtime, chatId: number, bucket?: MemberBucket): Promise<number> {
  const caches = cachesFor(rt);
  const day = bucket?.day ?? dayKey(rt.now(), rt.tzOffset);
  const key = `${chatId}:${day}`;
  const current = bucket ?? caches.memberStats.get(key);
  if (!current || current.counts.size === 0) return 0;
  const entries = [...current.counts.entries()];
  current.counts.clear();
  caches.memberStatsFlushedAt.set(chatId, rt.now());
  try {
    await memberStatsBump(rt.db, chatId, day, entries);
    return entries.length;
  } catch (err) {
    for (const [userId, count] of entries) current.counts.set(userId, (current.counts.get(userId) ?? 0) + count);
    console.log(`member stats flush: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/**
 * Keep the roster row fresh: name, username, last seen. One write per member
 * per hour; a first sighting carries `joinedAt` (set only on insert).
 */
export async function touchMember(
  rt: Runtime,
  chatId: number,
  user: { id: number; first_name?: string; username?: string },
  joinedAt?: number,
): Promise<void> {
  try {
    const key = `${chatId}:${user.id}`;
    const last = cachesFor(rt).memberTouch.get(key);
    if (last !== undefined && rt.now() - last < TOUCH_THROTTLE_MS) return;
    cachesFor(rt).memberTouch.set(key, rt.now());
    await memberUpsert(rt.db, {
      chatId,
      userId: user.id,
      firstName: String(user.first_name ?? "").slice(0, 80),
      username: String(user.username ?? "").slice(0, 40),
      joinedAt: joinedAt ?? 0,
      lastSeenAt: rt.now(),
    });
  } catch {
    // The roster is a nice-to-have; never let it break the message path.
  }
}

export type LeaderRow = { userId: number; name: string; messages: number };

/** Today's top speakers, names joined from the roster. */
export async function leaderboard(rt: Runtime, chatId: number, limit = 10): Promise<LeaderRow[]> {
  const day = dayKey(rt.now(), rt.tzOffset);
  const top = await memberTopDay(rt.db, chatId, day, limit);
  if (!top.length) return [];
  const names = await memberNames(rt, chatId, top.map((row) => row.userId));
  return top.map((row) => ({ userId: row.userId, name: names.get(row.userId) ?? String(row.userId), messages: row.messages }));
}

async function memberNames(rt: Runtime, chatId: number, userIds: number[]): Promise<Map<number, string>> {
  const { memberList } = await import("./db/repo.ts");
  const out = new Map<number, string>();
  // The roster is paged, but names for one leaderboard come from a bounded
  // scan filtered in SQL via the paged reader is wasteful — read by page until
  // the ids are found or the pages run out (roster rows per chat are hundreds,
  // not millions, and this runs once per post, not per message).
  for (let offset = 0; offset < 2_000 && out.size < userIds.length; offset += 100) {
    const rows = await memberList(rt.db, chatId, 100, { offset });
    if (!rows.length) break;
    for (const row of rows) {
      if (userIds.includes(row.userId)) {
        out.set(row.userId, row.firstName || (row.username ? `@${row.username}` : String(row.userId)));
      }
    }
  }
  return out;
}

/** The `/top` and `{{top}}` rendering: plain text, no HTML, one line each. */
export function leaderboardText(rows: LeaderRow[]): string {
  if (!rows.length) return "今天还没有发言记录。";
  const medals = ["🥇", "🥈", "🥉"];
  return ["今日发言榜：", ...rows.map((row, index) => `${medals[index] ?? `${index + 1}.`} ${row.name} · ${row.messages} 条`)].join("\n");
}
