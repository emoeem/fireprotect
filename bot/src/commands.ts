import type { Ctx } from "./context.ts";
import { rulesFor, saveRules } from "./context.ts";
import { PERMS_MEMBER, PERMS_MUTED } from "./context.ts";
import { kick, restrict, say, unban, unmute, logAction, addWarning, clearWarning, resetWarnings } from "./moderation.ts";
import { describeRules, EDITABLE_FIELDS, parseKeywords, type ChatRules } from "./rules.ts";
import { displayName } from "./telegram.ts";
import type { TgMessage } from "./types.ts";

export type Target = { id: number; minutes: number; error: string };

/**
 * Work out who a command is aimed at.
 *
 * Rules, in order: a replied-to message is always the target and any number is
 * a duration; without a reply two numbers mean `id duration`; a single small
 * number is a duration with nobody to act on — reading it as a user id, as the
 * old template did, mutes a stranger whose id happens to be `10`.
 */
export function parseTarget(msg: TgMessage, args: string): Target {
  const numbers = String(args || "")
    .trim()
    .split(/\s+/)
    .filter((part) => /^\d+$/.test(part))
    .map(Number);

  const replyId = msg.reply_to_message?.from?.id ?? 0;
  const out: Target = { id: replyId, minutes: 0, error: "" };

  if (replyId) {
    if (numbers.length >= 1) out.minutes = numbers[0];
  } else if (numbers.length >= 2) {
    out.id = numbers[0];
    out.minutes = numbers[1];
  } else if (numbers.length === 1) {
    if (numbers[0] >= 10_000) out.id = numbers[0];
    else out.error = `只写了分钟数，没说要处理谁：先回复对方再发，或写成 /命令 用户ID ${numbers[0]}。`;
  }

  out.minutes = Math.max(0, Math.min(out.minutes, 525_600));
  return out;
}

async function guardTarget(ctx: Ctx, msg: TgMessage, id: number): Promise<boolean> {
  if (!id) {
    await say(ctx, msg.chat.id, "请回复对方的消息，或写成 /命令 用户ID。", msg.message_id);
    return false;
  }
  if (String(id) === ctx.tg.botId) {
    await say(ctx, msg.chat.id, "不能对我自己这么做。", msg.message_id);
    return false;
  }
  if (await ctx.admins.isAdmin(msg.chat.id, id)) {
    await say(ctx, msg.chat.id, "不能对管理员这么做。", msg.message_id);
    return false;
  }
  return true;
}

const HELP = [
  "焰卫在岗。",
  "把我设为管理员，并打开：删除消息、封禁用户、置顶消息。",
  "再到 @BotFather 发送 /setprivacy，对本机器人选择 Disable。不关的话我看不见广告。",
  "",
  "任何人可用：",
  "/id — 查看自己的数字 ID",
  "/rules — 看本群当前规则",
  "/help — 这份说明",
  "",
  "管理员在群里回复对方后可用：",
  "/ban [分钟] — 封禁，带分钟数则到期自动解封",
  "/mute [分钟] — 禁言",
  "/kick — 踢出，对方还能再进来",
  "/unban — 解封并恢复发言",
  "/warn — 删掉这条并记一次警告，累计到上限自动封禁",
  "/unwarn — 撤销一次警告",
  "/del — 删掉被回复的消息",
  "/purge [数量] — 从被回复的消息删到这里，最多 100 条",
  "/pin /unpin — 置顶 / 取消置顶被回复的消息",
  "/lock /unlock — 全群禁言 / 解除",
  "",
  "也可以不回复，直接写 /ban 用户ID。",
  "",
  "改规则：",
  "/set 字段 值 — 例如 /set captcha off、/set warnLimit 5、/set maxLength 800",
  "/keywords add 词1,词2 / del 词 / list",
  "/logs 频道ID 或 /logs off",
  "/config — 看全部字段当前值",
].join("\n");

const FILTER_HINTS: Record<string, string> = {
  captcha: "新人验证 on/off",
  captchaTimeout: "验证时限（秒，30–86400）",
  welcome: "欢迎语 on/off",
  welcomeText: "欢迎语正文，可用 {name} {chat}",
  deleteJoinMessages: "删除「某某加入了群组」 on/off",
  keywords: "关键词，用 /keywords 改",
  filterLinks: "拦链接 on/off",
  filterForwards: "拦转发 on/off",
  filterChannels: "拦频道身份发言 on/off",
  maxLength: "超长拦截字数，0=关",
  floodLimit: "刷屏条数上限，0=关",
  floodWindow: "刷屏统计窗口（秒）",
  spamAction: "处置 delete/mute/ban",
  muteMinutes: "默认禁言分钟数",
  warnLimit: "几次警告后自动封禁，0=关",
};

function helpFor(field: string): string {
  return FILTER_HINTS[field] ? `用法：/set ${field} <${FILTER_HINTS[field]}>` : `未知字段。可用：${EDITABLE_FIELDS.join("、")}`;
}

export async function handleCommand(ctx: Ctx, msg: TgMessage, rules: ChatRules): Promise<boolean> {
  const text = msg.text ?? "";
  if (!text.startsWith("/")) return false;
  // A message posted as a channel has no sender; /id used to throw on it.
  if (!msg.from) return false;

  const bits = text.trim().split(/\s+/);
  const name = bits[0].slice(1).split("@")[0].toLowerCase();
  const args = bits.slice(1).join(" ");
  const chat = msg.chat;
  const from = msg.from;

  // ---- public -------------------------------------------------------------
  if (name === "id") {
    const sent = await ctx.tg.call("sendMessage", {
      chat_id: from.id,
      text: `你的 Telegram ID 是 ${from.id}。填进 ADMIN_IDS，或直接把我设为群管理员。`,
    });
    if (!sent.ok && chat.type !== "private") {
      await say(ctx, chat.id, `你的 ID 是 ${from.id}。先私聊我发一次 /start，下次只发到私聊。`, msg.message_id);
    }
    return true;
  }

  if (name === "start" || name === "help") {
    if (chat.type !== "private" && !(await ctx.admins.isAdmin(chat.id, from.id))) return false;
    await say(ctx, chat.type === "private" ? from.id : chat.id, HELP);
    return true;
  }

  if (name === "rules") {
    await say(ctx, chat.id, describeRules(await rulesFor(ctx, chat.id)).join("\n"), msg.message_id);
    return true;
  }

  if (chat.type === "private") return true;
  if (!(await ctx.admins.isAdmin(chat.id, from.id))) return false;

  // ---- admin --------------------------------------------------------------
  const target = parseTarget(msg, args);
  const mutating = ["ban", "mute", "kick", "unban", "warn", "unwarn"].includes(name);
  if (mutating && target.error) {
    await say(ctx, chat.id, target.error, msg.message_id);
    return true;
  }

  switch (name) {
    case "ban": {
      if (!(await guardTarget(ctx, msg, target.id))) return true;
      const body: Record<string, unknown> = { chat_id: chat.id, user_id: target.id };
      if (target.minutes) body.until_date = Math.floor(ctx.now() / 1000) + target.minutes * 60;
      const res = await ctx.tg.call("banChatMember", body);
      await report(ctx, msg, res.ok, res.ok ? (target.minutes ? `已封禁 ${target.minutes} 分钟。` : "已封禁。") : res.error);
      if (res.ok) {
        await logAction(ctx, rules, {
          chat,
          user: { id: target.id, first_name: targetName(msg) },
          action: target.minutes ? `封禁 ${target.minutes} 分钟` : "封禁",
          reason: "管理员手动操作",
          by: from,
        });
      }
      return true;
    }
    case "mute": {
      if (!(await guardTarget(ctx, msg, target.id))) return true;
      const minutes = target.minutes || rules.muteMinutes;
      const res = await restrict(ctx, chat.id, target.id, PERMS_MUTED, Math.floor(ctx.now() / 1000) + minutes * 60);
      await report(ctx, msg, res.ok, res.ok ? `已禁言 ${minutes} 分钟。` : res.error);
      if (res.ok) {
        await logAction(ctx, rules, {
          chat,
          user: { id: target.id, first_name: targetName(msg) },
          action: `禁言 ${minutes} 分钟`,
          reason: "管理员手动操作",
          by: from,
        });
      }
      return true;
    }
    case "kick": {
      if (!(await guardTarget(ctx, msg, target.id))) return true;
      const res = await kick(ctx, chat.id, target.id);
      await report(ctx, msg, res.ok, res.ok ? "已踢出，对方可以再进来。" : res.error);
      return true;
    }
    case "unban": {
      if (!(await guardTarget(ctx, msg, target.id))) return true;
      const res = await unban(ctx, chat.id, target.id);
      await report(ctx, msg, res.ok, res.ok ? "已解除限制。" : res.error);
      return true;
    }
    case "warn": {
      if (!target.id) {
        await say(ctx, chat.id, "请回复要警告的消息。", msg.message_id);
        return true;
      }
      if (!(await guardTarget(ctx, msg, target.id))) return true;
      if (msg.reply_to_message) {
        await ctx.tg.call("deleteMessage", { chat_id: chat.id, message_id: msg.reply_to_message.message_id });
      }
      const count = await addWarning(ctx, chat.id, target.id);
      const limit = rules.warnLimit;
      if (limit > 0 && count >= limit) {
        await ctx.tg.call("banChatMember", { chat_id: chat.id, user_id: target.id });
        await resetWarnings(ctx, chat.id, target.id);
        await say(ctx, chat.id, `警告已满 ${limit} 次，已封禁 <code>${target.id}</code>。`, msg.message_id);
        await logAction(ctx, rules, {
          chat,
          user: { id: target.id, first_name: targetName(msg) },
          action: "警告满额封禁",
          reason: `${count}/${limit} 次警告`,
          by: from,
        });
      } else {
        const tail = limit > 0 ? `（${count}/${limit}）` : "";
        await say(ctx, chat.id, `已警告 <code>${target.id}</code>${tail}，并删掉那条消息。`, msg.message_id);
        await logAction(ctx, rules, {
          chat,
          user: { id: target.id, first_name: targetName(msg) },
          action: "警告",
          reason: `累计 ${count} 次`,
          by: from,
        });
      }
      return true;
    }
    case "unwarn": {
      if (!target.id) {
        await say(ctx, chat.id, "请回复对方的消息，或写成 /unwarn 用户ID。", msg.message_id);
        return true;
      }
      const left = await clearWarning(ctx, chat.id, target.id);
      await say(ctx, chat.id, `已撤销一次警告，剩 ${left} 次。`, msg.message_id);
      return true;
    }
    case "del": {
      if (!msg.reply_to_message) {
        await say(ctx, chat.id, "请回复要删除的消息。", msg.message_id);
        return true;
      }
      await ctx.tg.call("deleteMessage", {
        chat_id: chat.id,
        message_id: msg.reply_to_message.message_id,
      });
      await ctx.tg.call("deleteMessage", { chat_id: chat.id, message_id: msg.message_id });
      return true;
    }
    case "purge": {
      if (!msg.reply_to_message) {
        await say(ctx, chat.id, "请回复要开始删除的那条消息。", msg.message_id);
        return true;
      }
      const asked = Number(args.trim().split(/\s+/)[0]) || 50;
      const count = Math.max(1, Math.min(asked, 100));
      const start = msg.reply_to_message.message_id;
      const ids: number[] = [];
      for (let i = 0; i < count; i++) {
        const id = start + i;
        if (id > msg.message_id) break;
        ids.push(id);
      }
      if (ids.length) await ctx.tg.call("deleteMessages", { chat_id: chat.id, message_ids: ids });
      return true;
    }
    case "pin": {
      if (!msg.reply_to_message) {
        await say(ctx, chat.id, "请回复要置顶的消息。", msg.message_id);
        return true;
      }
      const res = await ctx.tg.call("pinChatMessage", {
        chat_id: chat.id,
        message_id: msg.reply_to_message.message_id,
        disable_notification: true,
      });
      await report(ctx, msg, res.ok, res.ok ? "已置顶。" : res.error);
      return true;
    }
    case "unpin": {
      const res = await ctx.tg.call("unpinChatMessage", { chat_id: chat.id });
      await report(ctx, msg, res.ok, res.ok ? "已取消置顶。" : res.error);
      return true;
    }
    case "lock": {
      const res = await ctx.tg.call("setChatPermissions", {
        chat_id: chat.id,
        permissions: PERMS_MUTED,
        use_independent_chat_permissions: true,
      });
      await report(ctx, msg, res.ok, res.ok ? "全群已禁言，管理员不受影响。" : res.error);
      return true;
    }
    case "unlock": {
      const res = await ctx.tg.call("setChatPermissions", {
        chat_id: chat.id,
        permissions: PERMS_MEMBER,
        use_independent_chat_permissions: true,
      });
      await report(ctx, msg, res.ok, res.ok ? "已解除全群禁言。" : res.error);
      return true;
    }
    case "captcha": {
      const value = args.trim().toLowerCase();
      if (!value) {
        await say(ctx, chat.id, `新人验证现在是 ${rules.captcha ? "开" : "关"}。用法：/captcha on|off`, msg.message_id);
        return true;
      }
      if (!["on", "off"].includes(value)) {
        await say(ctx, chat.id, "用法：/captcha on|off", msg.message_id);
        return true;
      }
      const next = await saveRules(ctx, chat.id, { captcha: value === "on" });
      await say(ctx, chat.id, `新人验证已${next.captcha ? "打开" : "关闭"}。`, msg.message_id);
      return true;
    }
    case "set": {
      const [field, ...rest] = args.trim().split(/\s+/);
      if (!field || !rest.length) {
        await say(ctx, chat.id, helpFor(field ?? ""), msg.message_id);
        return true;
      }
      if (!(EDITABLE_FIELDS as readonly string[]).includes(field)) {
        await say(ctx, chat.id, helpFor(field), msg.message_id);
        return true;
      }
      if (field === "keywords") {
        await say(ctx, chat.id, "关键词请用 /keywords add 词1,词2", msg.message_id);
        return true;
      }
      const raw = rest.join(" ");
      const value: unknown = ["maxLength", "captchaTimeout", "floodLimit", "floodWindow", "muteMinutes", "warnLimit"].includes(
        field,
      )
        ? Number(raw)
        : ["captcha", "welcome", "deleteJoinMessages", "filterLinks", "filterForwards", "filterChannels"].includes(field)
          ? ["on", "true", "1"].includes(raw.toLowerCase())
          : raw;
      const next = await saveRules(ctx, chat.id, { [field]: value });
      const shown = (next as unknown as Record<string, unknown>)[field];
      await say(ctx, chat.id, `已设置 ${field} = ${Array.isArray(shown) ? shown.join(",") : String(shown)}`, msg.message_id);
      return true;
    }
    case "keywords": {
      const [sub, ...rest] = args.trim().split(/\s+/);
      const action = (sub ?? "list").toLowerCase();
      if (action === "list" || !sub) {
        await say(
          ctx,
          chat.id,
          rules.keywords.length ? `关键词（${rules.keywords.length}）：\n${rules.keywords.join("\n")}` : "还没有关键词。用法：/keywords add 词1,词2",
          msg.message_id,
        );
        return true;
      }
      if (action === "add") {
        const merged = parseKeywords([...rules.keywords, ...parseKeywords(rest.join(" "))]);
        await saveRules(ctx, chat.id, { keywords: merged });
        await say(ctx, chat.id, `已加入。现在共 ${merged.length} 个关键词。`, msg.message_id);
        return true;
      }
      if (action === "del" || action === "remove") {
        const words = parseKeywords(rest.join(" ")).map((word) => word.toLowerCase());
        const kept = rules.keywords.filter((word) => !words.includes(word.toLowerCase()));
        await saveRules(ctx, chat.id, { keywords: kept });
        await say(ctx, chat.id, `已删除 ${rules.keywords.length - kept.length} 个，剩 ${kept.length} 个。`, msg.message_id);
        return true;
      }
      await say(ctx, chat.id, "用法：/keywords add 词1,词2 / del 词 / list", msg.message_id);
      return true;
    }
    case "logs": {
      const value = args.trim();
      if (!value) {
        await say(ctx, chat.id, `记录目标：${rules.logChatId || ctx.env.LOG_CHAT_ID || "未设置"}`, msg.message_id);
        return true;
      }
      if (value === "off") {
        await saveRules(ctx, chat.id, { logChatId: "" });
        await say(ctx, chat.id, "已关闭记录。", msg.message_id);
        return true;
      }
      if (!/^-?\d+$/.test(value)) {
        await say(ctx, chat.id, "请给频道或群的数字 ID，或 /logs off", msg.message_id);
        return true;
      }
      await saveRules(ctx, chat.id, { logChatId: value });
      await say(ctx, chat.id, `记录会发到 ${value}（记得把我加进去并给发消息权限）。`, msg.message_id);
      return true;
    }
    case "config": {
      const current = await rulesFor(ctx, chat.id);
      const lines = Object.entries(current)
        .filter(([key]) => key !== "logChatId")
        .map(([key, value]) => `${key} = ${Array.isArray(value) ? value.join(",") : String(value)}`);
      await say(ctx, chat.id, lines.join("\n"), msg.message_id);
      return true;
    }
    default:
      return false;
  }
}

function targetName(msg: TgMessage): string {
  const user = msg.reply_to_message?.from;
  return user ? displayName(user) : "未知用户";
}

/** Answer with the result — success text, or what Telegram actually said. */
async function report(ctx: Ctx, msg: TgMessage, ok: boolean, text: string): Promise<void> {
  await say(ctx, msg.chat.id, ok ? text : `没成功：${text}`, msg.message_id);
}

/** `/unban` used to skip the guard; kept exported so a test can pin the rule. */
export { guardTarget, unmute };
