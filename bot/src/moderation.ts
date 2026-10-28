import type { Ctx } from "./context.ts";
import { PERMS_MEMBER, PERMS_MUTED } from "./context.ts";
import type { ChatRules } from "./rules.ts";
import { displayName, escapeHtml } from "./telegram.ts";
import type { TgChat, TgMessage, TgUser } from "./types.ts";

export type PunishResult = { acted: boolean; errors: string[] };

/**
 * Apply the configured punishment to a message's author, then remove the
 * message.
 *
 * Order matters and so does isolation: the previous template deleted first and
 * awaited it inline, so one `deleteMessage` failure (already deleted, message
 * too old) cancelled the ban entirely. Here each step is independent and the
 * first error is surfaced instead of swallowed.
 */
export async function punish(ctx: Ctx, msg: TgMessage, rules: ChatRules, reason: string): Promise<PunishResult> {
  const errors: string[] = [];
  const author = msg.from;
  let acted = false;

  if (author && rules.spamAction !== "delete") {
    const res =
      rules.spamAction === "ban"
        ? await ctx.tg.call("banChatMember", { chat_id: msg.chat.id, user_id: author.id })
        : await restrict(ctx, msg.chat.id, author.id, PERMS_MUTED, ctx.now() + rules.muteMinutes * 60);
    if (res.ok) acted = true;
    else errors.push(res.error);
  }

  const removed = await ctx.tg.call("deleteMessage", {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
  });
  if (removed.ok) acted = true;
  else if (removed.code !== 400) errors.push(removed.error);

  if (acted) {
    await logAction(ctx, rules, {
      chat: msg.chat,
      user: author,
      action: rules.spamAction,
      reason,
      minutes: rules.muteMinutes,
    });
  }
  return { acted, errors };
}

export async function restrict(
  ctx: Ctx,
  chatId: number,
  userId: number,
  permissions: Record<string, boolean>,
  until?: number,
) {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    user_id: userId,
    permissions,
    // Always independent: without it Telegram rejects a partial object and the
    // "unmute" silently restores far more than intended.
    use_independent_chat_permissions: true,
  };
  if (until && until > 0) body.until_date = until;
  return ctx.tg.call("restrictChatMember", body);
}

export async function unmute(ctx: Ctx, chatId: number, userId: number) {
  return restrict(ctx, chatId, userId, PERMS_MEMBER);
}

/** Ban then immediately unban: removes the member but lets them rejoin. */
export async function kick(ctx: Ctx, chatId: number, userId: number) {
  const banned = await ctx.tg.call("banChatMember", { chat_id: chatId, user_id: userId });
  if (!banned.ok) return banned;
  return ctx.tg.call("unbanChatMember", { chat_id: chatId, user_id: userId, only_if_banned: true });
}

export async function unban(ctx: Ctx, chatId: number, userId: number) {
  await ctx.tg.call("unbanChatMember", { chat_id: chatId, user_id: userId, only_if_banned: false });
  return unmute(ctx, chatId, userId);
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

const WARN_TTL = 7 * 24 * 3600;

function warnKey(chatId: number, userId: number): string {
  return `warn:${chatId}:${userId}`;
}

export async function addWarning(ctx: Ctx, chatId: number, userId: number): Promise<number> {
  const raw = await ctx.store.get(warnKey(chatId, userId));
  let count = 0;
  if (raw) {
    try {
      count = Number((JSON.parse(raw) as { count?: number }).count) || 0;
    } catch {
      count = 0;
    }
  }
  count += 1;
  await ctx.store.put(warnKey(chatId, userId), JSON.stringify({ count, at: ctx.now() }), WARN_TTL);
  return count;
}

export async function clearWarning(ctx: Ctx, chatId: number, userId: number): Promise<number> {
  const raw = await ctx.store.get(warnKey(chatId, userId));
  let count = 0;
  if (raw) {
    try {
      count = Number((JSON.parse(raw) as { count?: number }).count) || 0;
    } catch {
      count = 0;
    }
  }
  if (count <= 0) {
    await ctx.store.del(warnKey(chatId, userId));
    return 0;
  }
  const next = count - 1;
  if (next === 0) await ctx.store.del(warnKey(chatId, userId));
  else await ctx.store.put(warnKey(chatId, userId), JSON.stringify({ count: next, at: ctx.now() }), WARN_TTL);
  return next;
}

/**
 * Drop the counter entirely.
 *
 * Escalation used to call `clearWarning`, which only decrements — so a member
 * banned at 3/3 came back with 2 warnings already banked against them.
 */
export async function resetWarnings(ctx: Ctx, chatId: number, userId: number): Promise<void> {
  await ctx.store.del(warnKey(chatId, userId));
}

export async function warningsOf(ctx: Ctx, chatId: number, userId: number): Promise<number> {
  const raw = await ctx.store.get(warnKey(chatId, userId));
  if (!raw) return 0;
  try {
    return Number((JSON.parse(raw) as { count?: number }).count) || 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Moderation log
// ---------------------------------------------------------------------------

export type LogEntry = {
  chat: TgChat;
  user?: TgUser;
  action: string;
  reason: string;
  minutes?: number;
  by?: TgUser;
};

export async function logAction(ctx: Ctx, rules: ChatRules, entry: LogEntry): Promise<void> {
  const target = rules.logChatId || ctx.env.LOG_CHAT_ID || "";
  if (!target) return;
  const who = entry.user ? `${escapeHtml(displayName(entry.user))} (<code>${entry.user.id}</code>)` : "未知";
  const lines = [
    `<b>${escapeHtml(entry.action)}</b>`,
    `群：${escapeHtml(entry.chat.title || String(entry.chat.id))}`,
    `对象：${who}`,
    `原因：${escapeHtml(entry.reason)}`,
  ];
  if (entry.minutes) lines.push(`时长：${entry.minutes} 分钟`);
  if (entry.by) lines.push(`操作者：${escapeHtml(displayName(entry.by))}`);
  const res = await ctx.tg.call("sendMessage", {
    chat_id: target,
    text: lines.join("\n"),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  // A broken log target must never break the action it was reporting.
  if (!res.ok) console.log(`log failed: ${res.error}`);
}

export async function say(ctx: Ctx, chatId: number, text: string, replyTo?: number): Promise<void> {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (replyTo) body.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
  await ctx.tg.call("sendMessage", body);
}
