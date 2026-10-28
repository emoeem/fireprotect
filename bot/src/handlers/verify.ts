/**
 * Newcomer verification: issuing, consuming, and sweeping.
 *
 * The three modes differ in how the answer can physically arrive, and that
 * decides whether the member is muted:
 *  - button / math: the member is muted and answers with a tap. A muted member
 *    cannot type, so a text answer would be impossible.
 *  - question:      the member stays unmuted (there is no way to tap a free
 *    text), and every message they send before the answer is deleted. Delete
 *    instead of mute is the whole trick.
 *
 * The challenge lives in KV — one write per join — and the button carries an
 * HMAC over (chat, user, nonce[, choice]). Sweeping is driven by the Worker
 * cron trigger, the only reliable timer on the edge; without it an unverified
 * member stays muted forever.
 */
import {
  VERIFY_KEY,
  challengeFor,
  matchesAnswer,
  signCallback,
  verifyCallback,
  type Challenge,
} from "../captcha.ts";
import { PERMS_MEMBER, PERMS_MUTED, type Runtime } from "../context.ts";
import { record } from "../moderation.ts";
import { escapeHtml } from "../telegram.ts";
import { say } from "../moderation.ts";
import type { ChatConfig } from "../rules.ts";
import type { TgChat, TgMessage, TgUser } from "../types.ts";

const MAX_ATTEMPTS = 5;

export function verifySecret(rt: Runtime): string {
  return `verify:${rt.env.WEBHOOK_SECRET || rt.env.BOT_TOKEN || "dev"}`;
}

export async function pendingChallenge(rt: Runtime, chatId: number, userId: number): Promise<Challenge | null> {
  const raw = await rt.store.get(VERIFY_KEY(chatId, userId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Challenge;
    if (!parsed || typeof parsed.expiresAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export type IssueResult = { messageId?: number; error?: string; mode: ChatConfig["captchaMode"] };

/**
 * Send the challenge (and mute, when the answer is a tap).
 *
 * The mute comes first: if the prompt fails to send, the member is unmuted on
 * the error path rather than left in limbo. A member who cannot talk and cannot
 * see why is the worst state this bot can create.
 */
export async function issueChallenge(
  rt: Runtime,
  chat: TgChat,
  user: TgUser,
  config: ChatConfig,
): Promise<IssueResult> {
  const challenge = challengeFor(config.captchaMode, {
    answers: config.captchaAnswer,
    question: config.captchaQuestion,
    timeoutSeconds: config.captchaTimeout,
    nowMs: rt.now(),
  });

  const needsMute = challenge.mode !== "question";
  if (needsMute) {
    const muted = await rt.api.call("restrictChatMember", {
      chat_id: chat.id,
      user_id: user.id,
      permissions: PERMS_MUTED,
      use_independent_chat_permissions: true,
      until_date: Math.floor(challenge.expiresAt / 1000),
    });
    if (!muted.ok) return { error: muted.error, mode: challenge.mode };
  }

  await rt.store.put(VERIFY_KEY(chat.id, user.id), JSON.stringify(challenge), config.captchaTimeout + 60);

  const name = escapeHtml(user.first_name || user.username || String(user.id));
  const prompt = config.captchaPrompt.split("{name}").join(name).split("{chat}").join(escapeHtml(chat.title ?? ""));
  const lines = [prompt];
  if (challenge.question) lines.push(`\n<b>${escapeHtml(challenge.question)}</b>`);
  if (challenge.mode === "button") lines.push(`\n点下面的按钮，${Math.round(config.captchaTimeout / 60)} 分钟内有效。`);
  if (challenge.mode === "question") lines.push(`\n直接回复答案，${Math.round(config.captchaTimeout / 60)} 分钟内有效。`);

  const markup = await buildMarkup(rt, chat.id, user.id, challenge);
  const sent = await say(rt, chat.id, lines.filter(Boolean).join("\n"), { markup, html: true });

  if (!sent.ok) {
    if (needsMute) {
      // Hand the right to talk back: a failed prompt must not equal a mute.
      await rt.api.call("restrictChatMember", {
        chat_id: chat.id,
        user_id: user.id,
        permissions: PERMS_MEMBER,
        use_independent_chat_permissions: true,
      });
    }
    await rt.store.del(VERIFY_KEY(chat.id, user.id));
    return { error: sent.error, mode: challenge.mode };
  }
  return { messageId: sent.result.message_id, mode: challenge.mode };
}

async function buildMarkup(rt: Runtime, chatId: number, userId: number, challenge: Challenge): Promise<unknown> {
  if (challenge.mode === "button") {
    return {
      inline_keyboard: [
        [{ text: "✅ 我不是机器人", callback_data: await signCallback(verifySecret(rt), chatId, userId, challenge.nonce) }],
      ],
    };
  }
  if (challenge.mode === "math" && challenge.options?.length) {
    const buttons = await Promise.all(
      challenge.options.map(async (choice) => ({
        text: String(choice),
        callback_data: await signCallback(verifySecret(rt), chatId, userId, challenge.nonce, choice),
      })),
    );
    return { inline_keyboard: [buttons] };
  }
  return undefined;
}

export type VerifyOutcome = { ok: true } | { ok: false; attempts: number };

/** Text answer, `question` mode only. Returns null when the member is not pending. */
export async function answerChallenge(rt: Runtime, msg: TgMessage, config: ChatConfig): Promise<VerifyOutcome | null> {
  const user = msg.from;
  if (!user) return null;
  const challenge = await pendingChallenge(rt, msg.chat.id, user.id);
  if (!challenge) return null;
  if (challenge.mode !== "question") return null;

  if (matchesAnswer(challenge, msg.text ?? "")) {
    await complete(rt, msg.chat, user, challenge, config);
    return { ok: true };
  }

  const attempts = challenge.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await fail(rt, msg.chat.id, user, config, "验证答案连续错误");
    return { ok: false, attempts };
  }
  challenge.attempts = attempts;
  await rt.store.put(
    VERIFY_KEY(msg.chat.id, user.id),
    JSON.stringify(challenge),
    Math.max(60, Math.floor((challenge.expiresAt - rt.now()) / 1000)),
  );
  return { ok: false, attempts };
}

export type CallbackOutcome = { status: "ok" | "already" | "expired" | "forged" | "wrong"; reason: string };

export async function answerButton(
  rt: Runtime,
  chatOrMessage: { chatId: number; messageId?: number },
  user: TgUser,
  data: string,
  config: ChatConfig,
): Promise<CallbackOutcome> {
  const chatId = chatOrMessage.chatId;
  const signed = await verifyCallback(verifySecret(rt), chatId, user.id, data);
  if (!signed.ok) return { status: "forged", reason: signed.reason };

  const challenge = await pendingChallenge(rt, chatId, user.id);
  if (!challenge) return { status: "already", reason: "没有待验证记录（可能已通过或已过期）" };
  if (challenge.nonce !== signed.nonce) return { status: "forged", reason: "签名与记录不匹配" };
  if (challenge.expiresAt <= rt.now()) return { status: "expired", reason: "验证已超时" };

  if (challenge.mode === "math") {
    if (signed.choice === undefined) return { status: "forged", reason: "缺少选项" };
    if (!matchesAnswer(challenge, String(signed.choice))) {
      // Count the wrong tap: a script that guesses four options gets two tries.
      challenge.attempts += 1;
      if (challenge.attempts >= MAX_ATTEMPTS) {
        await fail(rt, chatId, user, config, "验证选项反复答错");
        return { status: "wrong", reason: "答错次数过多" };
      }
      await rt.store.put(
        VERIFY_KEY(chatId, user.id),
        JSON.stringify(challenge),
        Math.max(60, Math.floor((challenge.expiresAt - rt.now()) / 1000)),
      );
      return { status: "wrong", reason: `答案不对（第 ${challenge.attempts} 次）` };
    }
    await complete(rt, { id: chatId, type: "supergroup" }, user, challenge, config);
    return { status: "ok", reason: "" };
  }

  if (challenge.mode !== "button") return { status: "forged", reason: "该验证不接受按钮" };
  await complete(rt, { id: chatId, type: "supergroup" }, user, challenge, config);
  return { status: "ok", reason: "" };
}

async function complete(rt: Runtime, chat: TgChat, user: TgUser, challenge: Challenge, config: ChatConfig): Promise<void> {
  await rt.api.call("restrictChatMember", {
    chat_id: chat.id,
    user_id: user.id,
    permissions: PERMS_MEMBER,
    use_independent_chat_permissions: true,
  });
  await rt.store.del(VERIFY_KEY(chat.id, user.id));
  await record(rt, { chatId: chat.id, userId: user.id, kind: "verify", reason: `通过 ${challenge.mode} 验证` });

  if (config.welcome) {
    const name = escapeHtml(user.first_name || user.username || String(user.id));
    const text = config.welcomeText.split("{name}").join(name).split("{chat}").join(escapeHtml(chat.title ?? ""));
    if (text.trim()) await say(rt, chat.id, text, { html: true });
  }
}

async function fail(rt: Runtime, chatId: number, user: TgUser, config: ChatConfig, reason: string): Promise<void> {
  await rt.store.del(VERIFY_KEY(chatId, user.id));
  if (config.captchaKick) {
    const banned = await rt.api.call("banChatMember", { chat_id: chatId, user_id: user.id });
    if (banned.ok) await rt.api.call("unbanChatMember", { chat_id: chatId, user_id: user.id, only_if_banned: true });
  }
  await record(rt, { chatId, userId: user.id, kind: "kick", reason });
  await say(rt, chatId, `<code>${user.id}</code> ${reason}，已移出。`, { html: true });
}

export type SweepResult = { checked: number; expired: number };

/**
 * Close every verification window that has run out.
 *
 * Driven by `scheduled()` in the Worker and by a timer in the polling runner.
 * Members who never answered are removed (or left muted when `captchaKick` is
 * off) and the event is recorded, so `/stats` shows why people disappear.
 */
export async function sweepExpired(rt: Runtime, limit = 200): Promise<SweepResult> {
  const keys = await rt.store.keys("verify:");
  let expired = 0;
  for (const key of keys.slice(0, limit)) {
    const raw = await rt.store.get(key);
    if (!raw) continue;
    let challenge: Challenge;
    let chatId: number;
    let userId: number;
    try {
      challenge = JSON.parse(raw) as Challenge;
      const parts = key.split(":");
      chatId = Number(parts[1]);
      userId = Number(parts[2]);
    } catch {
      await rt.store.del(key);
      continue;
    }
    if (!Number.isFinite(chatId) || !Number.isFinite(userId)) {
      await rt.store.del(key);
      continue;
    }
    if (challenge.expiresAt > rt.now()) continue;
    const config = await rt.configFor(chatId);
    expired += 1;
    await rt.store.del(key);
    if (config.captchaKick) {
      const banned = await rt.api.call("banChatMember", { chat_id: chatId, user_id: userId });
      if (banned.ok) await rt.api.call("unbanChatMember", { chat_id: chatId, user_id: userId, only_if_banned: true });
    }
    await record(rt, { chatId, userId, kind: "kick", reason: "验证超时" });
  }
  return { checked: keys.length, expired };
}
