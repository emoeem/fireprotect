/**
 * Newcomer verification.
 *
 * Three tiers, because "click the button" only stops someone who cannot read
 * the button:
 *  - button:   one tap. Cheap, resists humans-who-are-bots, not scripts.
 *  - math:     answer a sum. Stops the copy-paste scripts that click anything.
 *  - question: answer the group's own question. Stops a script that does not
 *              know the group, which is what raid tools are.
 *
 * The button carries an HMAC over (chat, user, nonce), so a crafted callback
 * cannot verify somebody else. The challenge itself lives in the store with a
 * TTL — a callback for an expired window fails even if the signature is valid.
 */
import type { CaptchaMode } from "./rules.ts";

export type Challenge = {
  mode: CaptchaMode;
  nonce: string;
  /** Unix ms. */
  expiresAt: number;
  question?: string;
  /** Accepted answers, already lowercased and trimmed. */
  answers?: string[];
  /** `math` mode only: the buttons offered, in order. */
  options?: number[];
  attempts: number;
};

export type VerifyOutcome =
  | { ok: true; nonce: string; choice?: number }
  | { ok: false; reason: string };

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newNonce(bytes = 9): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return new Uint8Array(sig);
}

/**
 * `v1.<nonce>.<mac>` for the button, `v2.<nonce>.<choice>.<mac>` for a math
 * option — both under Telegram's 64-byte `callback_data` limit. The choice is
 * inside the MAC, so a member cannot tap "4" and claim they tapped "9".
 */
export async function signCallback(
  secret: string,
  chatId: number,
  userId: number,
  nonce: string,
  choice?: number,
): Promise<string> {
  const binding = `${chatId}:${userId}:${nonce}${choice === undefined ? "" : `:${choice}`}`;
  const mac = b64url((await hmac(secret, binding)).slice(0, 16));
  return choice === undefined ? `v1.${nonce}.${mac}` : `v2.${nonce}.${choice}.${mac}`;
}

export async function verifyCallback(
  secret: string,
  chatId: number,
  userId: number,
  data: string | undefined,
): Promise<VerifyOutcome> {
  const parts = String(data ?? "").split(".");
  if (parts.length === 3 && parts[0] === "v1") {
    const [, nonce, mac] = parts as [string, string, string];
    const expected = b64url((await hmac(secret, `${chatId}:${userId}:${nonce}`)).slice(0, 16));
    if (mac !== expected) return { ok: false, reason: "回调签名不对" };
    return { ok: true, nonce };
  }
  if (parts.length === 4 && parts[0] === "v2") {
    const [, nonce, rawChoice, mac] = parts as [string, string, string, string];
    const choice = Number(rawChoice);
    if (!Number.isFinite(choice)) return { ok: false, reason: "回调格式不对" };
    const expected = b64url((await hmac(secret, `${chatId}:${userId}:${nonce}:${choice}`)).slice(0, 16));
    if (mac !== expected) return { ok: false, reason: "回调签名不对" };
    return { ok: true, nonce, choice };
  }
  return { ok: false, reason: "回调格式不对" };
}

/**
 * `7 + 5 = ?` with four buttons.
 *
 * The answer options exist because a muted member cannot type: in math mode the
 * bot stays silent-safe (muted) and the answer is a tap. Decoys are distinct
 * from the answer and from each other.
 */
export function mathChallenge(random: () => number = Math.random): {
  question: string;
  answers: string[];
  options: number[];
} {
  const a = 2 + Math.floor(random() * 8);
  const b = 2 + Math.floor(random() * 8);
  const plus = random() < 0.5;
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  const answer = plus ? a + b : hi - lo;
  const question = plus ? `${a} + ${b} = ?` : `${hi} - ${lo} = ?`;

  const options = new Set<number>([answer]);
  while (options.size < 4) {
    const delta = 1 + Math.floor(random() * 4);
    const candidate = answer + (random() < 0.5 ? -delta : delta);
    if (candidate >= 0 && candidate !== answer) options.add(candidate);
  }
  const shuffled = [...options];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j] as number, shuffled[i] as number];
  }
  return { question, answers: [String(answer)], options: shuffled };
}

export function normalizeAnswer(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .slice(0, 80);
}

export function matchesAnswer(challenge: Pick<Challenge, "answers">, text: string): boolean {
  const value = normalizeAnswer(text);
  if (!value) return false;
  return (challenge.answers ?? []).some((answer) => normalizeAnswer(answer) === value);
}

export function challengeFor(
  mode: CaptchaMode,
  options: { answers: string[]; question: string; timeoutSeconds: number; nowMs: number; random?: () => number },
): Challenge {
  const base: Challenge = {
    mode,
    nonce: newNonce(),
    expiresAt: options.nowMs + options.timeoutSeconds * 1000,
    attempts: 0,
  };
  if (mode === "button") return base;
  if (mode === "math") {
    const math = mathChallenge(options.random);
    return { ...base, question: math.question, answers: math.answers, options: math.options };
  }
  return {
    ...base,
    question: options.question,
    answers: options.answers.length ? options.answers : ["我同意群规"],
  };
}

export const VERIFY_KEY = (chatId: number, userId: number) => `verify:${chatId}:${userId}`;
export const TRUST_KEY = (chatId: number, userId: number) => `trust:${chatId}:${userId}`;
export const ATTEMPT_KEY = (userId: number) => `verify-attempts:${userId}`;
