/**
 * Joins, leaves, promotions and join requests.
 *
 * The join path is where a raid is stopped, so it runs the expensive checks
 * (external lists) exactly once per member — never per message.
 */
import { PERMS_MUTED, type Runtime } from "../context.ts";
import { trackJoin } from "../flood.ts";
import { ban, logAction, record, recordBan, say } from "../moderation.ts";
import { escapeHtml } from "../telegram.ts";
import { issueChallenge } from "./verify.ts";
import { forgetJoin, rememberJoin } from "./message.ts";
import type { ChatConfig } from "../rules.ts";
import type { TgChatMemberUpdated, TgMessage, TgUser } from "../types.ts";

export async function handleNewMembers(rt: Runtime, msg: TgMessage): Promise<void> {
  const chatId = msg.chat.id;
  const config = await rt.configFor(chatId);
  const members = (msg.new_chat_members ?? []).filter((member) => !member.is_bot);

  if (config.deleteJoinMessages && members.length) {
    await rt.api.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id });
  }

  // Raid check first: if a hundred people arrive in thirty seconds, the greeting
  // is noise and the lock is the answer.
  if (config.joinRateMax > 0) {
    const count = trackJoin(rt, chatId, config.joinRateWindow, rt.now());
    if (count === config.joinRateMax) {
      await onRaid(rt, chatId, config, count);
    }
  }

  for (const member of members) {
    await welcomeOne(rt, chatId, member, config);
  }
}

async function welcomeOne(rt: Runtime, chatId: number, member: TgUser, config: ChatConfig): Promise<void> {
  rememberJoin(rt, chatId, member.id);
  await rt.store.put(`join:${chatId}:${member.id}`, String(rt.now()), Math.max(3600, config.newbieHours * 3600 + 600));
  await record(rt, { chatId, userId: member.id, kind: "join", reason: "进群" });

  // External lists run before the challenge: a known spammer should not get a
  // button, and banning now saves the group a spam message.
  if (config.cas || config.federation) {
    const verdict = await rt.screener.check(member.id, { cas: config.cas, federation: config.federation });
    if (verdict.banned) {
      await ban(rt, chatId, member.id);
      await recordBan(rt, config, member.id, verdict.reason, verdict.source);
      await logAction(rt, config, {
        chat: { id: chatId, type: "supergroup" },
        user: member,
        action: "外部库命中，自动封禁",
        reason: `${verdict.source}:${verdict.reason}`,
        kind: "external",
      });
      return;
    }
  }

  if (config.captcha) {
    const issued = await issueChallenge(rt, { id: chatId, type: "supergroup" }, member, config);
    if (issued.error) {
      console.log(`captcha prompt failed for ${member.id}: ${issued.error}`);
      await say(rt, chatId, `没能给 <code>${member.id}</code> 发验证：${escapeHtml(issued.error)}`, { html: true });
    }
    return;
  }

  if (config.welcome) {
    const name = escapeHtml(member.first_name || member.username || String(member.id));
    const text = config.welcomeText
      .split("{name}")
      .join(name)
      .split("{chat}")
      .join(escapeHtml(""))
      .split("{username}")
      .join(member.username ? `@${member.username}` : name)
      .split("{id}")
      .join(String(member.id));
    if (text.trim()) await say(rt, chatId, text, { html: true });
  }
}

async function onRaid(rt: Runtime, chatId: number, config: ChatConfig, count: number): Promise<void> {
  const text = `⚠️ ${config.joinRateWindow} 秒内进群 ${count} 人，疑似炸群。`;
  if (config.joinRateAction === "lock") {
    await rt.api.call("setChatPermissions", {
      chat_id: chatId,
      permissions: PERMS_MUTED,
      use_independent_chat_permissions: true,
    });
    await say(rt, chatId, `${text}\n已自动锁群，确认安全后发 /unlock。`);
  } else {
    await say(rt, chatId, `${text}\n管理员可发 /lock 全群禁言。`);
  }
  await record(rt, { chatId, kind: "external", reason: `进群频率 ${count}/${config.joinRateWindow}s` });
}

export async function handleLeftMember(rt: Runtime, msg: TgMessage): Promise<void> {
  const chatId = msg.chat.id;
  const member = msg.left_chat_member;
  if (!member || member.is_bot) return;
  const config = await rt.configFor(chatId);
  forgetJoin(rt, chatId, member.id);
  await rt.store.del(`join:${chatId}:${member.id}`);
  await record(rt, { chatId, userId: member.id, kind: "leave", reason: "退群" });
  if (config.deleteJoinMessages) await rt.api.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id });
  if (config.farewell && config.farewellText.trim()) {
    const name = escapeHtml(member.first_name || member.username || String(member.id));
    const text = config.farewellText
      .split("{name}")
      .join(name)
      .split("{chat}")
      .join(escapeHtml(msg.chat.title ?? ""));
    await say(rt, chatId, text, { html: true });
  }
}

/**
 * Promotions and demotions.
 *
 * The admin cache is deliberately short-lived (10 minutes); this just makes the
 * common case instant, so a freshly promoted moderator can use commands
 * immediately and a demoted one loses them immediately.
 */
export async function handleMemberUpdate(rt: Runtime, update: TgChatMemberUpdated): Promise<void> {
  rt.admin.invalidate(update.chat.id);
  void update;
}

/** The bot's own membership: tell the operator what still has to be switched on. */
export async function handleMyChatMember(rt: Runtime, update: TgChatMemberUpdated): Promise<void> {
  rt.admin.invalidate(update.chat.id);
  const status = update.new_chat_member.status;
  const wasIn = update.old_chat_member.status === "member" || update.old_chat_member.status === "administrator";
  if (status === "administrator") {
    await say(
      rt,
      update.chat.id,
      "已就位。建议确认三项权限：删除消息、封禁用户、置顶消息。\n配置用 /help 看命令，新人验证默认是开的。",
    );
    return;
  }
  if (status === "member" && !wasIn) {
    await say(rt, update.chat.id, "我被拉进来了，但还不是管理员——没有删除和封禁权限，只能看不能说。");
    return;
  }
  if (status === "member" && update.old_chat_member.status === "administrator") {
    await say(rt, update.chat.id, "我的管理员权限被撤了，群管理功能已停止。");
  }
}

/**
 * Join requests.
 *
 * Approving is safe: verification still happens after the member joins. Without
 * this the bot would silently block every request-only group.
 */
export async function handleJoinRequest(rt: Runtime, update: NonNullable<import("../types.ts").TgUpdate["chat_join_request"]>): Promise<void> {
  const config = await rt.configFor(update.chat.id);
  const approved = await rt.api.call("approveChatJoinRequest", {
    chat_id: update.chat.id,
    user_id: update.from.id,
  });
  if (approved.ok) {
    rememberJoin(rt, update.chat.id, update.from.id);
    await record(rt, { chatId: update.chat.id, userId: update.from.id, kind: "join", reason: "加入申请已批准" });
  }
  void config;
}
