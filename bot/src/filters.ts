import type { ChatConfig, LockKind } from "./rules.ts";
import { lockLabel } from "./rules.ts";
import type { TgMessage } from "./types.ts";

export type Verdict =
  | { hit: false }
  | {
      hit: true;
      reason: string;
      /** Which rule fired; the caller maps it to an action. */
      kind:
        | "keyword"
        | "lock"
        | "length"
        | "newbie"
        | "heuristic"
        | "external"
        | "flood"
        | "channel"
        | "forward";
      lock?: LockKind;
      score?: number;
    };

const LINK_RE = /https?:\/\//i;
const INVITE_RE = /(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)/i;
const BARE_HOST_RE =
  /(^|[\s(（[【])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|cn|io|me|co|vip|xyz|top|cc|tv|info|app|site|online|shop|link|club|live|pro|fun|wang|tech|store|bid|win|cyou|icu|ru|in|us|uk|de|jp|kr|hk|tw|sg)\b/i;
const MENTION_RE = /(^|[^\w@/])@[a-zA-Z][a-zA-Z0-9_]{3,31}\b/;

export function textOf(msg: TgMessage): string {
  return msg.text ?? msg.caption ?? "";
}

export function allEntities(msg: TgMessage) {
  return [...(msg.entities ?? []), ...(msg.caption_entities ?? [])];
}

/**
 * Link detection.
 *
 * Entity inspection still wins: it catches `text_link`, where the visible text
 * says nothing at all, and hidden URLs in captions.
 */
export function hasLink(msg: TgMessage): boolean {
  const text = textOf(msg);
  if (LINK_RE.test(text) || BARE_HOST_RE.test(text) || INVITE_RE.test(text)) return true;
  return allEntities(msg).some((entity) => entity.type === "url" || entity.type === "text_link");
}

export function hasInvite(msg: TgMessage): boolean {
  if (INVITE_RE.test(textOf(msg))) return true;
  return allEntities(msg).some((entity) => entity.type === "url" && INVITE_RE.test(entity.url ?? ""));
}

export function hasMention(msg: TgMessage): boolean {
  return allEntities(msg).some((e) => e.type === "mention" || e.type === "text_mention") || MENTION_RE.test(textOf(msg));
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

/** Every lock category this message falls into. */
export function kindsOf(msg: TgMessage): LockKind[] {
  const kinds: LockKind[] = [];
  if (hasLink(msg)) kinds.push("links");
  if (msg.photo) kinds.push("photos");
  if (msg.video) kinds.push("videos");
  if (msg.sticker) kinds.push("stickers");
  if (msg.animation) kinds.push("gifs");
  if (msg.document) kinds.push("files");
  if (msg.poll) kinds.push("polls");
  if (msg.voice || msg.video_note || msg.audio) kinds.push("voice");
  if (isForward(msg)) kinds.push("forwards");
  if (hasInvite(msg)) kinds.push("invites");
  if (hasMention(msg)) kinds.push("mentions");
  if (msg.from?.is_bot) kinds.push("bots");
  if (isChannelPost(msg)) kinds.push("channels");
  return kinds;
}

export type InspectInput = {
  msg: TgMessage;
  config: ChatConfig;
  nowMs: number;
  /** Join timestamp in ms, when the bot saw the join. */
  joinedAt?: number;
  /** Members who were unbanned by hand are exempt from the newbie window. */
  trusted?: boolean;
  /** Local heuristic score, computed by `heuristics.ts`. */
  heuristicScore?: number;
};

/**
 * Content verdict, first match wins.
 *
 * Ordering is deliberate: identity-level rules (channel sender, forwards) run
 * before content rules, and the cheap string checks run before the scoring
 * model so a keyword hit never pays for a full analysis.
 */
export function inspect(input: InspectInput): Verdict {
  const { msg, config, nowMs, joinedAt, trusted, heuristicScore } = input;
  const text = textOf(msg);

  if (config.locks.includes("forwards") && isForward(msg)) {
    return { hit: true, reason: "转发消息", kind: "forward", lock: "forwards" };
  }

  if (!trusted && config.newbieHours > 0 && joinedAt && nowMs - joinedAt < config.newbieHours * 3_600_000) {
    if (config.newbieBlocks.includes("links") && hasLink(msg)) {
      return { hit: true, reason: `入群 ${config.newbieHours} 小时内发链接`, kind: "newbie" };
    }
    if (config.newbieBlocks.includes("mentions") && hasMention(msg)) {
      return { hit: true, reason: `入群 ${config.newbieHours} 小时内提及他人`, kind: "newbie" };
    }
  }

  const word = hitKeyword(text, config.keywords);
  if (word) return { hit: true, reason: `命中关键词「${word}」`, kind: "keyword" };

  for (const kind of kindsOf(msg)) {
    if (!config.locks.includes(kind)) continue;
    // `forwards` is handled above so it keeps its dedicated log wording.
    if (kind === "forwards") continue;
    return { hit: true, reason: `本群禁止${lockLabel(kind)}`, kind: "lock", lock: kind };
  }

  if (config.maxLength > 0 && charLength(text) > config.maxLength) {
    return { hit: true, reason: `超过 ${config.maxLength} 字`, kind: "length" };
  }

  if (typeof heuristicScore === "number" && heuristicScore >= 60) {
    return { hit: true, reason: `本地启发式评分 ${heuristicScore}`, kind: "heuristic", score: heuristicScore };
  }

  return { hit: false };
}
