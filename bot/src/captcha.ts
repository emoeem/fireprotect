import type { Ctx } from "./context.ts";
import { PERMS_MEMBER, PERMS_MUTED } from "./context.ts";
import { kick, logAction, restrict, say } from "./moderation.ts";
import { fillTemplate, type ChatRules } from "./rules.ts";
import type { TgCallbackQuery, TgMessage, TgUser } from "./types.ts";

const encoder = new TextEncoder();

function secretOf(env: { WEBHOOK_SECRET?: string; BOT_TOKEN?: string }): string {
  // Never a hard-coded constant: anyone could recompute the signature offline.
  // The bot token is mandatory and known only to Telegram and the deployment.
  return String(env.WEBHOOK_SECRET || env.BOT_TOKEN || "");
}

/** Truncated HMAC-SHA256, hex. `callback_data` has a 64-byte budget. */
export async function signature(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const bytes = new Uint8Array(mac).slice(0, 8);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function pendingKey(chatId: number, userId: number): string {
  return `captcha:${chatId}:${userId}`;
}

export type Pending = { exp: number; promptId: number };

export async function pendingOf(ctx: Ctx, chatId: number, userId: number): Promise<Pending | null> {
  const raw = await ctx.store.get(pendingKey(chatId, userId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Pending>;
    if (typeof parsed.exp !== "number") return null;
    return { exp: parsed.exp, promptId: Number(parsed.promptId) || 0 };
  } catch {
    return null;
  }
}

/**
 * Mute a new member and send the button.
 *
 * The restriction carries `until_date = expiry`, so even if this Worker dies
 * before the sweep runs, Telegram lifts the mute on its own: a broken bot must
 * not leave people silenced forever.
 */
export async function challenge(ctx: Ctx, msg: TgMessage, user: TgUser, rules: ChatRules): Promise<void> {
  const exp = Math.floor(ctx.now() / 1000) + rules.captchaTimeout;
  await restrict(ctx, msg.chat.id, user.id, PERMS_MUTED, exp);

  const sig = await signature(secretOf(ctx.env), `${msg.chat.id}:${user.id}:${exp}`);
  const sent = await ctx.tg.call<{ message_id: number }>("sendMessage", {
    chat_id: msg.chat.id,
    text: fillTemplate(rules.captchaPrompt, user, msg.chat),
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "我是本人，放行",
            callback_data: `v:${user.id}:${exp}:${sig}`,
          },
        ],
      ],
    },
    reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
  });

  if (!sent.ok) {
    // No button means no way to verify — that is a permanent mute by accident.
    await restrict(ctx, msg.chat.id, user.id, PERMS_MEMBER);
    await logAction(ctx, rules, {
      chat: msg.chat,
      user,
      action: "验证按钮发不出去",
      reason: sent.error,
    });
    return;
  }

  await ctx.store.put(
    pendingKey(msg.chat.id, user.id),
    JSON.stringify({ exp, promptId: sent.result.message_id }),
    rules.captchaTimeout + 300,
  );
}

export async function handleCaptchaCallback(ctx: Ctx, query: TgCallbackQuery, rules: ChatRules): Promise<boolean> {
  const data = String(query.data ?? "");
  if (!data.startsWith("v:")) return false;

  const parts = data.split(":");
  const chat = query.message?.chat;
  if (!chat || parts.length !== 4) {
    await ctx.tg.call("answerCallbackQuery", { callback_query_id: query.id, text: "验证数据无效", show_alert: true });
    return true;
  }

  const [, rawId, rawExp, sig] = parts;
  if (String(query.from.id) !== rawId) {
    await ctx.tg.call("answerCallbackQuery", {
      callback_query_id: query.id,
      text: "这不是你的验证按钮",
      show_alert: true,
    });
    return true;
  }

  const exp = Number(rawExp);
  if (!Number.isFinite(exp) || exp * 1000 < ctx.now()) {
    await ctx.tg.call("answerCallbackQuery", {
      callback_query_id: query.id,
      text: "按钮已过期，请让管理员重新放行或重新进群",
      show_alert: true,
    });
    return true;
  }

  const expect = await signature(secretOf(ctx.env), `${chat.id}:${rawId}:${rawExp}`);
  if (expect !== sig) {
    await ctx.tg.call("answerCallbackQuery", { callback_query_id: query.id, text: "签名不符", show_alert: true });
    return true;
  }

  await restrict(ctx, chat.id, query.from.id, PERMS_MEMBER);
  await ctx.store.del(pendingKey(chat.id, query.from.id));
  await ctx.tg.call("answerCallbackQuery", { callback_query_id: query.id, text: "通过了，可以发言" });

  if (query.message) {
    await ctx.tg.call("deleteMessage", { chat_id: chat.id, message_id: query.message.message_id });
  }
  if (rules.welcome) {
    await say(ctx, chat.id, fillTemplate(rules.welcomeText, query.from, chat));
  }
  return true;
}

/**
 * Remove members who never pressed the button.
 *
 * Workers have no durable timers, so the sweep is lazy: any update in the chat
 * can trigger it, throttled to once every 30 seconds per chat. With no traffic
 * nobody is being challenged either, so the delay is harmless.
 */
export async function sweep(ctx: Ctx, chatId: number, rules: ChatRules): Promise<number> {
  const marker = `sweepmark:${chatId}`;
  if (await ctx.store.get(marker)) return 0;
  await ctx.store.put(marker, "1", 30);

  const keys = await ctx.store.keys(`captcha:${chatId}:`);
  let removed = 0;
  const nowSeconds = Math.floor(ctx.now() / 1000);
  for (const key of keys) {
    const pending = await ctx.store.get(key);
    if (!pending) continue;
    let entry: Pending;
    try {
      entry = JSON.parse(pending) as Pending;
    } catch {
      await ctx.store.del(key);
      continue;
    }
    if (!entry || typeof entry.exp !== "number") {
      await ctx.store.del(key);
      continue;
    }
    if (entry.exp > nowSeconds) continue;

    const userId = Number(key.split(":")[2]);
    if (!Number.isFinite(userId) || userId <= 0) {
      await ctx.store.del(key);
      continue;
    }
    await kick(ctx, chatId, userId);
    if (entry.promptId) {
      await ctx.tg.call("deleteMessage", { chat_id: chatId, message_id: entry.promptId });
    }
    await ctx.store.del(key);
    removed += 1;
    await logAction(ctx, rules, {
      chat: { id: chatId, type: "supergroup" },
      user: { id: userId, first_name: "未验证成员" },
      action: "验证超时移出",
      reason: `${rules.captchaTimeout} 秒内未点击按钮`,
    });
  }
  return removed;
}
