/**
 * Moderation actions.
 *
 * Every Telegram call goes through here so three things stay true everywhere:
 *  - `until_date` is clamped (`untilDate`), because Telegram silently turns a
 *    sub-30-second mute into a permanent one;
 *  - each step is independent: one failed `deleteMessage` never cancels a ban;
 *  - every action is recorded once — in SQL for `/stats` and in the log channel
 *    for humans — before the handler returns.
 */
import { cachesFor } from "./caches.ts";
import { PERMS_MEMBER, PERMS_MUTED, type Runtime } from "./context.ts";
import { banAdd, logEvent, warnInc, warnReset } from "./db/repo.ts";
import { describeStrike, strikeAt } from "./ladder.ts";
import { displayName, escapeHtml, untilDate, type TgResult } from "./telegram.ts";
import type { ChatConfig, Strike } from "./rules.ts";
import type { TgChat, TgMessage, TgUser } from "./types.ts";

export type PunishResult = { acted: boolean; errors: string[] };

export async function restrict(
  rt: Runtime,
  chatId: number,
  userId: number,
  minutes: number,
  permissions: Record<string, boolean> = PERMS_MUTED,
): Promise<TgResult<true>> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    user_id: userId,
    permissions,
    // Always independent: without it Telegram rejects a partial object and the
    // "unmute" silently restores far more than intended.
    use_independent_chat_permissions: true,
  };
  const until = untilDate(rt.now(), minutes * 60);
  if (until) body.until_date = until;
  return rt.api.call<true>("restrictChatMember", body);
}

export async function silence(
  rt: Runtime,
  chatId: number,
  userId: number,
): Promise<TgResult<true>> {
  return restrict(rt, chatId, userId, 0);
}

export async function unmute(rt: Runtime, chatId: number, userId: number): Promise<TgResult<true>> {
  return rt.api.call<true>("restrictChatMember", {
    chat_id: chatId,
    user_id: userId,
    permissions: PERMS_MEMBER,
    use_independent_chat_permissions: true,
  });
}

/**
 * Publish a ban to the shared list.
 *
 * The local table is always written — that is what makes a second group on the
 * same deployment protected for free. The remote federation is opt-in per chat
 * and never blocks the ban itself.
 */
export async function recordBan(
  rt: Runtime,
  config: ChatConfig,
  userId: number,
  reason: string,
  source = "local",
): Promise<void> {
  await banAdd(rt.db, { userId, reason, source, at: rt.now() }).catch(() => undefined);
  if (config.federation) await rt.screener.report(userId, reason).catch(() => false);
}

export async function ban(
  rt: Runtime,
  chatId: number,
  userId: number,
  minutes = 0,
): Promise<TgResult<true>> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    user_id: userId,
    revoke_messages: false,
  };
  const until = untilDate(rt.now(), minutes * 60);
  if (until) body.until_date = until;
  return rt.api.call<true>("banChatMember", body);
}

/** Ban then immediately unban: removes the member but lets them rejoin. */
export async function kick(rt: Runtime, chatId: number, userId: number): Promise<TgResult<true>> {
  const banned = await ban(rt, chatId, userId);
  if (!banned.ok) return banned;
  const res = await rt.api.call<true>("unbanChatMember", {
    chat_id: chatId,
    user_id: userId,
    only_if_banned: true,
  });
  return res.ok ? { ok: true, result: true } : res;
}

export async function unban(rt: Runtime, chatId: number, userId: number): Promise<TgResult<true>> {
  const res = await rt.api.call<true>("unbanChatMember", {
    chat_id: chatId,
    user_id: userId,
    only_if_banned: false,
  });
  await unmute(rt, chatId, userId);
  return res;
}

export async function deleteMessages(
  rt: Runtime,
  chatId: number,
  ids: number[],
): Promise<TgResult<true>> {
  if (!ids.length) return { ok: true, result: true };
  if (ids.length === 1) {
    return rt.api.call<true>("deleteMessage", { chat_id: chatId, message_id: ids[0] });
  }
  return rt.api.call<true>("deleteMessages", { chat_id: chatId, message_ids: ids.slice(0, 100) });
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export type LogEntry = {
  chat: TgChat;
  user?: TgUser;
  action: string;
  reason: string;
  minutes?: number;
  by?: TgUser;
  kind?: string;
};

export async function record(
  rt: Runtime,
  entry: {
    chatId: number;
    userId?: number;
    kind: string;
    reason?: string;
    minutes?: number;
    byId?: number;
  },
): Promise<void> {
  try {
    await logEvent(rt.db, {
      chatId: entry.chatId,
      userId: entry.userId ?? 0,
      kind: entry.kind as never,
      reason: entry.reason,
      minutes: entry.minutes,
      byId: entry.byId,
      at: rt.now(),
    });
  } catch (err) {
    // Statistics are worth less than the moderation action they describe.
    console.log(`event log failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function logAction(rt: Runtime, config: ChatConfig, entry: LogEntry): Promise<void> {
  await record(rt, {
    chatId: entry.chat.id,
    userId: entry.user?.id,
    kind: entry.kind ?? "delete",
    reason: entry.reason,
    minutes: entry.minutes,
    byId: entry.by?.id,
  });

  const target = config.logChatId || rt.env.LOG_CHAT_ID || "";
  if (!target) return;
  const who = entry.user
    ? `${escapeHtml(displayName(entry.user))} (<code>${entry.user.id}</code>)`
    : "未知";
  const lines = [
    `<b>${escapeHtml(entry.action)}</b>`,
    `群：${escapeHtml(entry.chat.title || String(entry.chat.id))}`,
    `对象：${who}`,
    `原因：${escapeHtml(entry.reason)}`,
  ];
  if (entry.minutes) lines.push(`时长：${entry.minutes} 分钟`);
  if (entry.by) lines.push(`操作者：${escapeHtml(displayName(entry.by))}`);
  const res = await rt.api.call("sendMessage", {
    chat_id: target,
    text: lines.join("\n"),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  // A broken log target must never break the action it was reporting.
  if (!res.ok) console.log(`log send failed: ${res.error}`);
}

export async function say(
  rt: Runtime,
  chatId: number,
  text: string,
  options: { replyTo?: number; markup?: unknown; html?: boolean } = {},
): Promise<TgResult<{ message_id: number }>> {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (options.html) body.parse_mode = "HTML";
  if (options.markup) body.reply_markup = options.markup;
  if (options.replyTo)
    body.reply_parameters = { message_id: options.replyTo, allow_sending_without_reply: true };
  return rt.api.call<{ message_id: number }>("sendMessage", body);
}

// ---------------------------------------------------------------------------
// Automatic response
// ---------------------------------------------------------------------------

/**
 * The single entry point for an automatic violation.
 *
 * Deleting the message is unconditional — a spam message that reached five
 * hundred phones is already damage. What happens to the author is the ladder:
 * the first rung is a short mute, the last is a ban, and the counter resets
 * when the ladder bans. With `strikes: []` it falls back to `spamAction`.
 */
/**
 * In-chat notices are rate-limited per group.
 *
 * A member deserves to know why their message vanished; a raid deserves silence.
 * One notice a minute gets the first and denies the second.
 */
function shouldAnnounce(rt: Runtime, chatId: number, nowMs: number): boolean {
  const noticeAt = cachesFor(rt).notice;
  const last = noticeAt.get(chatId) ?? 0;
  if (nowMs - last < 60_000) return false;
  noticeAt.set(chatId, nowMs);
  return true;
}

export async function punishAuto(
  rt: Runtime,
  msg: TgMessage,
  config: ChatConfig,
  reason: string,
  options: { alreadyDeleted?: boolean } = {},
): Promise<PunishResult> {
  const errors: string[] = [];
  const author = msg.from;
  let acted = false;

  if (!options.alreadyDeleted) {
    const removed = await deleteMessages(rt, msg.chat.id, [msg.message_id]);
    if (removed.ok) {
      acted = true;
      // Counted separately from the punishment: "deleted 40 messages" and
      // "muted 3 members" are different facts, and /stats shows both.
      await record(rt, { chatId: msg.chat.id, userId: author?.id, kind: "delete", reason });
    } else if (removed.code !== 400) errors.push(removed.error);
  } else {
    acted = true;
  }

  if (!author) {
    if (acted)
      await logAction(rt, config, { chat: msg.chat, action: "删除", reason, kind: "delete" });
    return { acted, errors };
  }

  const count = await warnInc(rt.db, msg.chat.id, author.id, rt.now()).catch(() => 0);
  const strike = strikeAt(count, config);

  if (strike) {
    await applyStrike(rt, msg.chat.id, author, strike, reason, count, config);
    // 文件头承诺「每个动作都进日志频道」：阶梯自动处置同样要写 /logs，
    // 否则管理员事后无从追溯机器人为什么动了人。
    await logAction(rt, config, {
      chat: msg.chat,
      user: author,
      action: `自动处置（第 ${count} 次违规）：${describeStrike(strike)}`,
      reason,
      kind: strike.action === "ban" ? "ban" : strike.action === "kick" ? "kick" : "mute",
      minutes: strike.minutes,
    });
    if (shouldAnnounce(rt, msg.chat.id, rt.now())) {
      await say(rt, msg.chat.id, `已处理：${escapeHtml(reason)}（${describeStrike(strike)}）`, {
        html: true,
      });
    }
    return { acted: true, errors };
  }

  // No ladder configured: apply the flat action.
  if (config.spamAction === "ban") {
    const res = await ban(rt, msg.chat.id, author.id);
    if (!res.ok) errors.push(res.error);
    else await recordBan(rt, config, author.id, reason);
  } else if (config.spamAction === "mute") {
    const res = await restrict(rt, msg.chat.id, author.id, config.muteMinutes);
    if (!res.ok) errors.push(res.error);
  }

  if (shouldAnnounce(rt, msg.chat.id, rt.now())) {
    await say(rt, msg.chat.id, `已处理：${escapeHtml(reason)}`, { html: true });
  }
  await logAction(rt, config, {
    chat: msg.chat,
    user: author,
    action:
      config.spamAction === "ban"
        ? "自动封禁"
        : config.spamAction === "mute"
          ? `自动禁言 ${config.muteMinutes} 分钟`
          : "删除消息",
    reason,
    minutes: config.spamAction === "mute" ? config.muteMinutes : undefined,
    kind: config.spamAction === "ban" ? "ban" : config.spamAction === "mute" ? "mute" : "delete",
  });
  return { acted, errors };
}

async function applyStrike(
  rt: Runtime,
  chatId: number,
  author: TgUser,
  strike: Strike,
  reason: string,
  count: number,
  configForStrike: ChatConfig,
): Promise<void> {
  const base = { chatId, userId: author.id, reason: `${reason}（第 ${count} 次）`, byId: 0 };
  if (strike.action === "ban") {
    const res = await ban(rt, chatId, author.id, strike.minutes);
    if (!res.ok) {
      // Telegram refused (usually: not a member any more). Recording a ban that
      // never happened would make /stats lie, which is worse than a gap.
      await record(rt, {
        ...base,
        kind: "external",
        reason: `${base.reason}｜封禁失败：${res.error}`,
      });
      return;
    }
    await recordBan(rt, configForStrike, author.id, reason);
    await warnReset(rt.db, chatId, author.id).catch(() => undefined);
    await record(rt, { ...base, kind: "ban", minutes: strike.minutes });
    return;
  }
  if (strike.action === "kick") {
    const res = await kick(rt, chatId, author.id);
    await record(rt, {
      ...base,
      kind: res.ok ? "kick" : "external",
      reason: res.ok ? base.reason : `${base.reason}｜移出失败：${res.error}`,
    });
    return;
  }
  if (strike.action === "mute" && strike.minutes > 0) {
    const res = await restrict(rt, chatId, author.id, strike.minutes);
    await record(rt, {
      ...base,
      kind: res.ok ? "mute" : "external",
      reason: res.ok ? base.reason : `${base.reason}｜禁言失败：${res.error}`,
      minutes: strike.minutes,
    });
    return;
  }
  await record(rt, { ...base, kind: "warn" });
}

/**
 * A keyword rule configured as "mute".
 *
 * Deliberately outside the warning ladder: an admin who chose `keywordAction:
 * mute` asked for one specific action, not for the third hit to become a ban.
 * The message is gone either way — a mute that leaves the spam visible is not a
 * moderation action.
 */
export async function muteFor(
  rt: Runtime,
  msg: TgMessage,
  minutes: number,
  reason: string,
): Promise<PunishResult> {
  const errors: string[] = [];
  const removed = await deleteMessages(rt, msg.chat.id, [msg.message_id]);
  if (!removed.ok && removed.code !== 400) errors.push(removed.error);
  if (removed.ok)
    await record(rt, { chatId: msg.chat.id, userId: msg.from?.id, kind: "delete", reason });

  const author = msg.from;
  if (!author) return { acted: removed.ok, errors };
  const muted = await restrict(rt, msg.chat.id, author.id, minutes);
  await record(rt, {
    chatId: msg.chat.id,
    userId: author.id,
    kind: muted.ok ? "mute" : "external",
    reason: muted.ok ? reason : `${reason}｜禁言失败：${muted.error}`,
    minutes,
  });
  if (!muted.ok) errors.push(muted.error);
  return { acted: true, errors };
}

export function strikeSummary(config: ChatConfig, count: number): string {
  const strike = strikeAt(count, config);
  return strike ? `第 ${count} 次：${describeStrike(strike)}` : `第 ${count} 次：只记录`;
}
