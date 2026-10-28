/**
 * The message pipeline.
 *
 * Order is the design:
 *   1. commands — an admin must be able to `/lock` even while the group is in
 *      night mode or flooded;
 *   2. a pending free-text answer — that message is the answer, not spam;
 *   3. admins — never filtered, or the bot would delete its own moderators;
 *   4. cheap rules (night mode, flood, keywords, locks, length);
 *   5. the local score, then auto-replies.
 *
 * The point of 4-before-5 is that a keyword hit never pays for the analysis.
 */
import { cachesFor } from "../caches.ts";
import { type Runtime } from "../context.ts";
import { inspect } from "../filters.ts";
import { duplicateSignal, scoreMessage } from "../heuristics.ts";
import { trackFlood } from "../flood.ts";
import { matchReplyFilter } from "../replies.ts";
import { inNightWindow } from "../nightmode.ts";
import { deleteMessages, punishAuto, say } from "../moderation.ts";
import { filterList, isTrusted } from "../db/repo.ts";
import { handleCommand } from "./commands.ts";
import { answerChallenge, pendingChallenge } from "./verify.ts";
import type { FilterRow } from "../db/schema.ts";
import type { TgMessage } from "../types.ts";

export function rememberJoin(rt: Runtime, chatId: number, userId: number): void {
  cachesFor(rt).join.set(`${chatId}:${userId}`, rt.now());
}

export function forgetJoin(rt: Runtime, chatId: number, userId: number): void {
  cachesFor(rt).join.delete(`${chatId}:${userId}`);
}

export function invalidateFilters(rt: Runtime, chatId: number): void {
  cachesFor(rt).filters.delete(chatId);
}

export async function handleMessage(rt: Runtime, msg: TgMessage): Promise<void> {
  const chatId = msg.chat.id;
  const config = await rt.configFor(chatId);
  const text = msg.text ?? "";

  // 1. commands
  if (text.startsWith("/")) {
    const handled = await handleCommand({ rt, msg, config, args: text.trim().split(/\s+/).slice(1).join(" ") });
    if (handled) return;
  }

  const from = msg.from;
  if (!from) return;

  // 2. a pending free-text answer is not spam
  const pending = await pendingChallenge(rt, chatId, from.id);
  if (pending && pending.mode === "question") {
    const outcome = await answerChallenge(rt, msg, config);
    await deleteMessages(rt, chatId, [msg.message_id]);
    if (outcome && !outcome.ok) {
      await say(rt, chatId, `答案不对，再试一次（已错 ${outcome.attempts}/${5} 次）。`, { replyTo: msg.message_id });
    }
    return;
  }

  // 3. admins are never filtered
  if (await rt.admin.isAdmin(chatId, from.id)) return;
  // A bot that is not us: only the `bots` lock applies, and it is handled below.
  if (from.is_bot && !config.locks.includes("bots")) return;

  // 4a. night mode
  if (config.nightMode && inNightWindow(rt.now(), config.nightStart, config.nightEnd, rt.tzOffset)) {
    await deleteMessages(rt, chatId, [msg.message_id]);
    const noticeCache = cachesFor(rt).notice;
    const last = noticeCache.get(chatId) ?? 0;
    if (rt.now() - last > 10 * 60_000) {
      noticeCache.set(chatId, rt.now());
      await say(rt, chatId, `夜间模式（${config.nightStart}–${config.nightEnd}）期间只有管理员能发言。`, {
        replyTo: msg.message_id,
      });
    }
    return;
  }

  // 4b. flood
  const flood = trackFlood(rt, chatId, from.id, config.floodLimit, config.floodWindow, rt.now());
  if (flood.exceeded) {
    await punishAuto(rt, msg, config, `刷屏（${config.floodWindow} 秒内 ${flood.count} 条）`);
    return;
  }

  // 4c. content rules + 5. local score
  const duplicate = duplicateSignal(rt, chatId, msg);
  const heuristic = Math.min(scoreMessage(msg).score + duplicate.score, 100);
  const joinedAt = await joinedAtOf(rt, chatId, from.id);
  const trusted = joinedAt ? await trustedOf(rt, chatId, from.id) : false;
  const verdict = inspect({ msg, config, nowMs: rt.now(), joinedAt, trusted, heuristicScore: heuristic });
  if (verdict.hit) {
    await punishAuto(rt, msg, config, verdict.reason);
    return;
  }

  // 6. auto-replies
  const filters = await filtersOf(rt, chatId);
  const match = matchReplyFilter(filters, text);
  if (match) await say(rt, chatId, match.response, { replyTo: msg.message_id });
}

async function joinedAtOf(rt: Runtime, chatId: number, userId: number): Promise<number | undefined> {
  const caches = cachesFor(rt);
  const key = `${chatId}:${userId}`;
  const cached = caches.join.get(key);
  if (cached) return cached;
  const raw = await rt.store.get(`join:${chatId}:${userId}`);
  if (!raw) return undefined;
  const at = Number(raw);
  if (!Number.isFinite(at) || at <= 0) return undefined;
  caches.join.set(key, at);
  return at;
}

async function trustedOf(rt: Runtime, chatId: number, userId: number): Promise<boolean> {
  const caches = cachesFor(rt);
  const key = `${chatId}:${userId}`;
  const cached = caches.trust.get(key);
  if (cached !== undefined) return cached;
  const value = await isTrusted(rt.db, chatId, userId).catch(() => false);
  caches.trust.set(key, value);
  return value;
}

async function filtersOf(rt: Runtime, chatId: number): Promise<FilterRow[]> {
  const cache = cachesFor(rt).filters;
  const cached = cache.get(chatId) as unknown as FilterRow[] | undefined;
  if (cached) return cached;
  const rows = await filterList(rt.db, chatId).catch(() => [] as FilterRow[]);
  cache.set(chatId, rows);
  return rows;
}
