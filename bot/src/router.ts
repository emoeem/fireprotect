import type { Ctx } from "./context.ts";
import { rulesFor } from "./context.ts";
import { handleCaptchaCallback, challenge, sweep } from "./captcha.ts";
import { handleCommand } from "./commands.ts";
import { floodExceeded, inspect } from "./filters.ts";
import { logAction, punish, say } from "./moderation.ts";
import { fillTemplate, type ChatRules } from "./rules.ts";
import type { TgChatMemberUpdated, TgMessage, TgUpdate } from "./types.ts";

/**
 * Entry point for one Telegram update.
 *
 * Order is the design: the captcha callback and membership changes are settled
 * first, commands second (an admin typing `/ban` should never be moderated as
 * spam), and the content filter last.
 */
export async function handleUpdate(ctx: Ctx, update: TgUpdate): Promise<void> {
  if (!update || typeof update !== "object") return;

  if (update.callback_query) {
    const chatId = update.callback_query.message?.chat.id;
    if (!chatId) return;
    const rules = await rulesFor(ctx, chatId);
    const consumed = await handleCaptchaCallback(ctx, update.callback_query, rules);
    if (!consumed) {
      await ctx.tg.call("answerCallbackQuery", { callback_query_id: update.callback_query.id });
    }
    return;
  }

  if (update.my_chat_member) {
    await onMyMembership(ctx, update.my_chat_member);
    return;
  }

  if (update.edited_message) {
    await moderate(ctx, update.edited_message);
    return;
  }

  if (update.message) {
    await onMessage(ctx, update.message);
  }
}

async function onMessage(ctx: Ctx, msg: TgMessage): Promise<void> {
  if (!msg?.chat) return;

  if (msg.new_chat_members?.length) {
    await onJoin(ctx, msg);
    return;
  }

  if (msg.left_chat_member) {
    const rules = await rulesFor(ctx, msg.chat.id);
    if (rules.deleteJoinMessages) {
      await ctx.tg.call("deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id });
    }
    return;
  }

  if (msg.text?.startsWith("/")) {
    const rules = await rulesFor(ctx, msg.chat.id);
    // A channel post has no sender; handleCommand returns false rather than
    // throwing, and the message falls through to the filter below.
    if (await handleCommand(ctx, msg, rules)) return;
  }

  await moderate(ctx, msg);
}

/** Content + flood checks. Admins are exempt; private chats are not moderated. */
export async function moderate(ctx: Ctx, msg: TgMessage): Promise<void> {
  if (!msg?.chat) return;
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") return;

  const rules = await rulesFor(ctx, msg.chat.id);

  // The sweep is lazy because Workers cannot schedule: any traffic in the chat
  // is the clock, throttled to once per 30s inside sweep().
  if (rules.captcha) await sweep(ctx, msg.chat.id, rules);

  const fromId = msg.from && !msg.from.is_bot ? msg.from.id : 0;
  if (fromId && (await ctx.admins.isAdmin(msg.chat.id, fromId))) return;

  // A channel-sender check must run before the "no sender" return: a post made
  // on behalf of a channel has `sender_chat` and no `from`, so testing `from`
  // first makes the channel filter unreachable.
  const verdict = inspect(msg, rules);
  if (verdict.hit) {
    await punish(ctx, msg, rules, verdict.reason);
    return;
  }

  if (!fromId) return;
  if (await floodExceeded(ctx, msg, rules)) {
    await punish(ctx, msg, rules, `${rules.floodWindow} 秒内超过 ${rules.floodLimit} 条消息`);
  }
}

async function onJoin(ctx: Ctx, msg: TgMessage): Promise<void> {
  const rules = await rulesFor(ctx, msg.chat.id);
  for (const user of msg.new_chat_members ?? []) {
    if (!user || user.is_bot) continue;
    if (await ctx.admins.isAdmin(msg.chat.id, user.id)) continue;

    if (rules.captcha) {
      await challenge(ctx, msg, user, rules);
    } else if (rules.welcome) {
      await say(ctx, msg.chat.id, fillTemplate(rules.welcomeText, user, msg.chat));
    }
    await logAction(ctx, rules, {
      chat: msg.chat,
      user,
      action: rules.captcha ? "入群，等待验证" : "入群",
      reason: rules.captcha ? `${rules.captchaTimeout} 秒内需点击按钮` : "未开启验证",
    });
  }

  if (rules.deleteJoinMessages) {
    await ctx.tg.call("deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id });
  }
}

async function onMyMembership(ctx: Ctx, event: TgChatMemberUpdated): Promise<void> {
  const now = event.new_chat_member?.status;
  const prev = event.old_chat_member?.status;
  const joined = (now === "member" || now === "administrator") && (prev === "left" || prev === "kicked");
  if (!joined) return;
  await say(
    ctx,
    event.chat.id,
    "焰卫到了。请把我设为管理员，并打开：删除消息、封禁用户、置顶消息。\n然后在 @BotFather 发送 /setprivacy，对本机器人选择 Disable —— 不关的话我看不见群里的广告。",
  );
}

/** Commands advertised in Telegram's own menu. */
export function commandList(): { command: string; description: string }[] {
  return [
    { command: "id", description: "查看自己的数字 ID" },
    { command: "rules", description: "看本群当前规则" },
    { command: "help", description: "焰卫会做什么" },
    { command: "ban", description: "回复消息：封禁(可带分钟)" },
    { command: "mute", description: "回复消息：禁言(可带分钟)" },
    { command: "kick", description: "回复消息：踢出" },
    { command: "warn", description: "回复消息：警告，满额自动封禁" },
    { command: "del", description: "回复消息：删除" },
    { command: "pin", description: "回复消息：置顶" },
    { command: "set", description: "改规则，例如 /set captcha off" },
  ];
}

export type { ChatRules };
