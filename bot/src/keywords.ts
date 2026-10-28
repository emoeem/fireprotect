/**
 * Keyword matching: substrings plus regular expressions.
 *
 * Admins ask for regex the moment substring matching proves too blunt ("加 V 和
 * 加V 都要删"). It is also the one feature that can take an isolate down:
 * JavaScript's regex engine has no timeout, and `(a+)+$` against a long message
 * is a self-inflicted denial of service — the Worker is single-threaded for the
 * duration and the whole group stops being moderated.
 *
 * Two defences, both cheap and both tested:
 *   - `inspectPattern` rejects the shapes that produce exponential backtracking
 *     (a quantified group whose body is itself unbounded, and a quantified
 *     alternation, which is the same problem wearing a hat);
 *   - the subject is truncated before matching, so anything that slips through
 *     runs over a bounded string.
 *
 * A linear-time engine (RE2) is the complete answer. It is not worth a WASM
 * payload inside a 1 MiB Worker bundle for a chat filter, and the residual risk
 * is documented rather than hidden: patterns come from group admins, not from
 * strangers.
 */
import { MAX_PATTERN_CHARS, type ChatConfig } from "./rules.ts";

export { MAX_PATTERN_CHARS };
/** Matching runs over at most this many characters. */
export const MAX_SUBJECT_CHARS = 800;

type Group = { unbounded: boolean; alternation: boolean };

export type PatternCheck = { ok: true } | { ok: false; reason: string };

/**
 * Reject the exponential-backtracking shapes before they ever run.
 *
 * This is a structural check, not a linter: it walks the pattern once, tracking
 * whether each open group contains an unbounded quantifier (`*`, `+`, `{n,}`)
 * or a top-level alternation, and refuses a group that is itself quantified
 * when either is true. `(ab)+` passes; `(a+)+`, `(a|aa)+` and `(.*x)*` do not.
 */
export function inspectPattern(source: string): PatternCheck {
  if (!source.trim()) return { ok: false, reason: "空的正则" };
  if (source.length > MAX_PATTERN_CHARS) return { ok: false, reason: `正则最长 ${MAX_PATTERN_CHARS} 字符` };

  const stack: Group[] = [];
  let escaped = false;
  let inClass = false;

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(") {
      stack.push({ unbounded: false, alternation: false });
      continue;
    }
    if (c === "|") {
      const top = stack[stack.length - 1];
      if (top) top.alternation = true;
      continue;
    }
    if (c === ")") {
      const inner = stack.pop();
      if (!inner) return { ok: false, reason: "括号不配对" };
      const rest = source.slice(i + 1);
      const quantified = /^[*+]/.test(rest) || /^\{\d+,(\d*)\}/.test(rest);
      if (quantified && inner.unbounded) {
        return { ok: false, reason: "分组内已有 * 或 +，外层再量化会指数回溯，例如 (a+)+" };
      }
      if (quantified && inner.alternation) {
        return { ok: false, reason: "含 | 的分组不要再加 * 或 +（回溯风险），拆成多条正则" };
      }
      if (quantified) {
        const parent = stack[stack.length - 1];
        if (parent) parent.unbounded = true;
      }
      continue;
    }
    if (c === "*" || c === "+") {
      const top = stack[stack.length - 1];
      if (top) top.unbounded = true;
      continue;
    }
    if (c === "{") {
      const m = /^\{(\d+),(\d*)\}/.exec(source.slice(i));
      if (m && m[2] === "") {
        const top = stack[stack.length - 1];
        if (top) top.unbounded = true;
      }
      continue;
    }
  }

  if (stack.length) return { ok: false, reason: "括号不配对" };
  try {
    new RegExp(source, "i");
  } catch {
    return { ok: false, reason: "正则语法错误" };
  }
  return { ok: true };
}

/**
 * Compiled patterns, keyed by source.
 *
 * Module-level on purpose: regex semantics do not vary per runtime, and
 * recompiling twenty patterns per message would cost more than the match. The
 * cap keeps a hostile admin from growing it without bound.
 */
const compiled = new Map<string, RegExp | null>();

export function compilePattern(source: string): RegExp | null {
  if (compiled.has(source)) return compiled.get(source) ?? null;
  if (!inspectPattern(source).ok) {
    remember(source, null);
    return null;
  }
  let re: RegExp;
  try {
    re = new RegExp(source, "i");
  } catch {
    remember(source, null);
    return null;
  }
  remember(source, re);
  return re;
}

function remember(source: string, re: RegExp | null): void {
  if (compiled.size >= 200) {
    const oldest = compiled.keys().next().value;
    if (oldest !== undefined) compiled.delete(oldest);
  }
  compiled.set(source, re);
}

export type KeywordHit = { label: string; via: "word" | "pattern" };

/** First match wins: plain words are cheaper, so they run first. */
export function matchKeywords(text: string, words: string[], patterns: string[]): KeywordHit | null {
  if (!text) return null;
  const low = text.toLowerCase();
  for (const word of words) {
    if (word && low.includes(word.toLowerCase())) return { label: word, via: "word" };
  }
  if (!patterns?.length) return null;
  const subject = text.length > MAX_SUBJECT_CHARS ? text.slice(0, MAX_SUBJECT_CHARS) : text;
  for (const source of patterns) {
    const re = compilePattern(source);
    if (!re) continue;
    re.lastIndex = 0;
    if (re.test(subject)) return { label: source, via: "pattern" };
  }
  return null;
}

/**
 * What a keyword hit should do here.
 *
 * The ad whitelist wins over everything: a sponsor who posts "加微信" is doing
 * exactly what they were invited to do, and deleting their message is how a
 * group loses its sponsor. Their hits are still recorded, because "who is
 * posting links" is a question an admin asks later.
 */
export type KeywordPolicy = "act" | "record";
export function keywordPolicy(config: ChatConfig, userId: number): KeywordPolicy {
  if ((config.adWhitelist ?? []).includes(userId)) return "record";
  if (config.keywordAction === "record") return "record";
  return "act";
}
