/**
 * Local spam scoring — the fallback that must still work when every external
 * service is unreachable.
 *
 * Nothing here calls the network. The score is advisory: `inspect()` only acts
 * on it above the threshold, and a hit is reported with its score so an admin
 * can tell "the keyword list caught this" from "the model guessed".
 */
import { parse as parseDomain } from "tldts";
import { cachesFor } from "./caches.ts";
import { allEntities, textOf } from "./filters.ts";
import type { TgMessage } from "./types.ts";

/** TLDs that turn up in spam far more often than in a real group. */
const RISKY_TLDS = new Set(["top", "xyz", "icu", "cyou", "bid", "win", "click", "loan", "work", "shop", "vip", "buzz", "rest", "sbs", "lol", "best", "cfd"]);

/** Phrases an impersonator uses to look like group staff. */
const AUTHORITY_WORDS = /(客服|管理员|官方|群管|技术支持|解封|申诉|领取|福利|空投|验证|support|admin|moderator|official|verify|airdrop|claim)/i;

/**
 * Characters that only appear in text meant to look like something else:
 * zero-width joiners, bidi overrides, and the Cyrillic/Greek letters that
 * render identically to Latin ones.
 */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/;
const CONFUSABLE = /[\u0400-\u04ff\u0370-\u03ff]/;
const LATIN = /[a-z]/i;

export type ScoreBreakdown = { score: number; reasons: string[] };

export function scoreMessage(msg: TgMessage): ScoreBreakdown {
  const text = textOf(msg);
  const reasons: string[] = [];
  let score = 0;

  const links = allEntities(msg).filter((e) => e.type === "url" || e.type === "text_link");
  const urls = [...links.map((e) => e.url ?? ""), ...(text.match(/https?:\/\/[^\s]+/gi) ?? [])].filter(Boolean);

  const hosts = new Set<string>();
  for (const raw of urls) {
    try {
      const host = new URL(raw.startsWith("http") ? raw : `https://${raw}`).hostname;
      hosts.add(host.toLowerCase().replace(/^www\./, ""));
    } catch {
      // Not a URL we can parse; the regex-driven checks below still apply.
    }
  }

  for (const host of hosts) {
    const parsed = parseDomain(host);
    const suffix = parsed.publicSuffix ?? "";
    if (suffix && RISKY_TLDS.has(suffix)) {
      score += 15;
      reasons.push(`高风险域名 .${suffix}`);
    }
    if (host.split(".").length >= 4) {
      score += 10;
      reasons.push("多级子域");
    }
  }

  if (/(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)/i.test(text)) {
    score += 25;
    reasons.push("群邀请链接");
  }

  if (urls.length >= 2) {
    score += 10;
    reasons.push("多条链接");
  }

  if (urls.length > 0 && AUTHORITY_WORDS.test(text)) {
    score += 30;
    reasons.push("冒充官方 + 链接");
  }

  if (msg.from && AUTHORITY_WORDS.test(`${msg.from.first_name ?? ""} ${msg.from.last_name ?? ""}`) && urls.length > 0) {
    score += 20;
    reasons.push("昵称冒充官方");
  }

  if (INVISIBLE.test(text)) {
    score += 20;
    reasons.push("不可见字符");
  }

  if (CONFUSABLE.test(text) && LATIN.test(text)) {
    score += 20;
    reasons.push("拉丁/西里尔混排");
  }

  if (urls.length > 0 && Array.from(text).length < 24) {
    score += 10;
    reasons.push("极短文本带链接");
  }

  const score2 = Math.min(score, 100);
  return { score: score2, reasons };
}

// ---------------------------------------------------------------------------
// Duplicate content
// ---------------------------------------------------------------------------

/** Fold away the differences that spammers vary for free. */
export function contentFingerprint(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, "")
    .replace(/https?:\/\/\S+/g, "u")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  return normalized.slice(0, 200);
}

/**
 * How many *other* members sent the same text recently.
 *
 * Same author repeating themselves is a flood problem, not a spam network —
 * the flood window already covers that, so the author is excluded here.
 *
 * Kept in memory on purpose: this runs on every message, and one KV write per
 * message would exhaust the daily write quota of a free deployment.
 */
export function duplicateSignal(runtime: object, chatId: number, msg: TgMessage): { count: number; score: number } {
  const fingerprints = cachesFor(runtime).fingerprints;
  const text = textOf(msg);
  if (Array.from(text).length < 12) return { count: 0, score: 0 };
  const author = msg.from?.id ?? 0;
  const key = `${chatId}:${contentFingerprint(text)}`;
  const seen = fingerprints.get(key) ?? [];
  const others = new Set(seen.filter((id) => id !== author)).size;
  if (!seen.includes(author)) fingerprints.set(key, [...seen, author].slice(-20));
  return { count: others, score: others >= 3 ? 25 : 0 };
}
