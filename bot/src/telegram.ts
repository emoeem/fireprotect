import { escape as escapeEntities } from "he";
import type { TgUser } from "./types.ts";

export type TgOk<T> = { ok: true; result: T };
export type TgErr = { ok: false; error: string; code: number; retryAfter?: number };
export type TgResult<T> = TgOk<T> | TgErr;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const API = "https://api.telegram.org";

/** Telegram's own hard limit; a longer `until_date` is rejected outright. */
export const MAX_UNTIL_SECONDS = 366 * 86_400;

/**
 * `until_date` for a ban/mute, or `undefined` for "forever".
 *
 * Telegram treats anything less than 30 seconds from now as permanent, so a
 * "mute for 20 seconds" would silently become a permanent mute. We round up to
 * the minimum instead of letting the platform reinterpret it.
 */
export function untilDate(nowMs: number, seconds: number): number | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const clamped = Math.min(Math.floor(seconds), MAX_UNTIL_SECONDS);
  if (clamped < 31) return undefined;
  return Math.floor(nowMs / 1000) + clamped;
}

/**
 * Bot API client.
 *
 * Production behaviour the hand-rolled template lacked, and why each matters:
 *  - timeout: a hung `fetch` inside a Worker silently loses the update, so the
 *    member stays muted with nobody to unmute them;
 *  - 429 handling: `retry_after` must be honoured, otherwise a busy group
 *    escalates into a hard ban from Telegram;
 *  - bounded retries: a socket reset reported as "banned" is worse than slow.
 * Every attempt is bounded, so a caller can never hang the update handler.
 */
export class Telegram {
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    token: string,
    fetchImpl?: FetchLike,
    options: { timeoutMs?: number; maxAttempts?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.token = token;
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 3, 4));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get available(): boolean {
    return Boolean(this.token);
  }

  /** The numeric id part of a bot token; used to refuse acting on ourselves. */
  get botId(): string {
    return String(this.token || "").split(":")[0] || "";
  }

  async call<T = unknown>(method: string, body: Record<string, unknown> = {}): Promise<TgResult<T>> {
    let last: TgErr = { ok: false, error: "BOT_TOKEN 未设置", code: 0 };
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const res = await this.once<T>(method, body);
      if (res.ok) return res;
      last = res;

      const transient = res.code === 429 || res.code === 0 || res.code >= 500;
      if (!transient || attempt === this.maxAttempts) return res;

      // `retry_after` is authoritative; the fallback backoff is exponential.
      const waitMs = res.retryAfter ? Math.min(res.retryAfter, 20) * 1000 : Math.min(2 ** attempt * 500, 4000);
      await this.sleep(waitMs);
    }
    return last;
  }

  private async once<T>(method: string, body: Record<string, unknown>): Promise<TgResult<T>> {
    if (!this.token) return { ok: false, error: "BOT_TOKEN 未设置", code: 0 };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${API}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      return { ok: false, error: errorText(err), code: 0 };
    } finally {
      clearTimeout(timer);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, error: `HTTP ${response.status}`, code: response.status };
    }

    const data = (payload ?? {}) as {
      ok?: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    if (data.ok === true) return { ok: true, result: data.result as T };
    return {
      ok: false,
      error: data.description || `HTTP ${response.status}`,
      code: data.error_code ?? response.status,
      retryAfter: data.parameters?.retry_after,
    };
  }
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.name === "AbortError" ? "请求超时" : err.message;
  return String(err);
}

/**
 * Telegram sends text as HTML if asked, and a display name is user-controlled:
 * `<b>x</b>` in a first name would otherwise become markup in an admin's chat.
 * `he` is the reference implementation for HTML entities; hand-rolling the
 * table is how `&` ends up double-escaped.
 */
export function escapeHtml(value: unknown): string {
  return escapeEntities(String(value ?? ""));
}

export function displayName(user: TgUser | undefined): string {
  if (!user) return "未知用户";
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return (name || user.username || String(user.id)).slice(0, 64);
}

/** Constant-time-ish comparison for secrets; length leak is acceptable here. */
export function safeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
