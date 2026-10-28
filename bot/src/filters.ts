import type { Ctx } from "./context.ts";
import type { ChatRules } from "./rules.ts";
import type { TgMessage } from "./types.ts";

export type Verdict =
  | { hit: false }
  | {
      hit: true;
      reason: string;
      /** "flood" needs a different follow-up than a plain content match. */
      kind: "keyword" | "link" | "forward" | "channel" | "length" | "flood";
    };

const LINK_RE = /https?:\/\//i;
const BARE_HOST_RE = /(^|[\s(（[【])(?:www\.)?[a-z0-9-]+\.(?:com|net|org|cn|io|me|co|vip|xyz|top|cc|tv|info|app|site|online|shop|link|club|live|pro|fun|wang|tech|store|bid|win|cyou|icu)\b/i;

export function textOf(msg: TgMessage): string {
  return msg.text ?? msg.caption ?? "";
}

/**
 * Link detection.
 *
 * The template only looked for a scheme, `t.me/` and `www.`, so `abc.com` and
 * a bare `t.me/xxx` (no scheme) passed through. Entity inspection still wins:
 * it catches `text_link`, where the visible text says nothing at all.
 */
export function hasLink(msg: TgMessage): boolean {
  const text = textOf(msg);
  if (LINK_RE.test(text) || BARE_HOST_RE.test(text)) return true;
  const entities = [...(msg.entities ?? []), ...(msg.caption_entities ?? [])];
  return entities.some((entity) => entity.type === "url" || entity.type === "text_link");
}

export function hitKeyword(text: string, keywords: string[]): string {
  const low = text.toLowerCase();
  for (const word of keywords) {
    if (word && low.includes(word.toLowerCase())) return word;
  }
  return "";
}

export function isForward(msg: TgMessage): boolean {
  return Boolean(msg.forward_origin || msg.forward_from || msg.forward_date || msg.forward_sender_name);
}

export function isChannelPost(msg: TgMessage): boolean {
  return Boolean(msg.sender_chat && msg.sender_chat.id !== msg.chat.id);
}

/** Character count, not code units: one emoji is one character to a reader. */
export function charLength(text: string): number {
  return Array.from(text).length;
}

/**
 * Content verdict. Flood is separate because it needs the store and must not
 * run for admins — checking it here keeps every rule in one place for tests.
 */
export function inspect(msg: TgMessage, rules: ChatRules): Verdict {
  const text = textOf(msg);

  if (rules.filterChannels && isChannelPost(msg)) {
    return { hit: true, reason: "以频道身份发言", kind: "channel" };
  }
  if (rules.filterForwards && isForward(msg)) {
    return { hit: true, reason: "转发消息", kind: "forward" };
  }
  const word = hitKeyword(text, rules.keywords);
  if (word) return { hit: true, reason: `命中关键词「${word}」`, kind: "keyword" };
  if (rules.filterLinks && hasLink(msg)) {
    return { hit: true, reason: "含链接", kind: "link" };
  }
  if (rules.maxLength > 0 && charLength(text) > rules.maxLength) {
    return { hit: true, reason: `超过 ${rules.maxLength} 字`, kind: "length" };
  }
  return { hit: false };
}

// ---------------------------------------------------------------------------
// Flood control
// ---------------------------------------------------------------------------

export function floodKey(chatId: number, userId: number): string {
  return `flood:${chatId}:${userId}`;
}

/**
 * Sliding window kept in the store.
 *
 * Returns `true` when this message crosses the limit. The window is trimmed on
 * every call, so the key never grows past `limit` entries.
 */
export async function floodExceeded(ctx: Ctx, msg: TgMessage, rules: ChatRules): Promise<boolean> {
  if (rules.floodLimit <= 0 || !msg.from) return false;
  const key = floodKey(msg.chat.id, msg.from.id);
  const now = ctx.now();
  const windowMs = rules.floodWindow * 1000;

  let stamps: number[] = [];
  const raw = await ctx.store.get(key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) stamps = parsed.filter((n): n is number => typeof n === "number");
    } catch {
      stamps = [];
    }
  }
  stamps = stamps.filter((at) => now - at < windowMs);
  stamps.push(now);
  await ctx.store.put(key, JSON.stringify(stamps.slice(-rules.floodLimit * 2)), rules.floodWindow * 2);

  return stamps.length > rules.floodLimit;
}
