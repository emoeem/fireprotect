import type { TgUser } from "./types.ts";

export type TgOk<T> = { ok: true; result: T };
export type TgErr = { ok: false; error: string; code: number; retryAfter?: number };
export type TgResult<T> = TgOk<T> | TgErr;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const API = "https://api.telegram.org";

/**
 * Minimal Bot API client.
 *
 * Two behaviours the generator template lacked and that matter in production:
 *  - a timeout, because a hung `fetch` inside a Worker silently drops the
 *    whole update;
 *  - one retry on 429 and on a network error, because "ask again later" and
 *    "the socket died" are both transient and reporting them as a completed
 *    ban is worse than being slow.
 */
export class Telegram {
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(token: string, fetchImpl?: FetchLike, timeoutMs = 10_000) {
    this.token = token;
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = timeoutMs;
  }

  get available(): boolean {
    return Boolean(this.token);
  }

  /** The numeric id part of a bot token; used to refuse acting on ourselves. */
  get botId(): string {
    return String(this.token || "").split(":")[0] || "";
  }

  async call<T = unknown>(method: string, body: Record<string, unknown> = {}): Promise<TgResult<T>> {
    const first = await this.once<T>(method, body);
    if (first.ok) return first;

    const transient =
      first.code === 429 ||
      first.code === 0 ||
      first.code === 502 ||
      first.code === 503 ||
      first.code === 504;
    if (!transient) return first;

    // Telegram asks for a specific delay; anything longer than our own deadline
    // is better reported than slept through inside a request handler.
    const wait = first.retryAfter ? Math.min(first.retryAfter, 30) : 1;
    await sleep(wait * 1000);
    return this.once<T>(method, body);
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

function errorText(err: unknown): string {
  if (err instanceof Error) return err.name === "AbortError" ? "请求超时" : err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Telegram sends text as HTML if asked, and a display name is user-controlled:
 * `<b>x</b>` in a first name would otherwise become markup in an admin's chat.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function displayName(user: TgUser | undefined): string {
  if (!user) return "未知用户";
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return name || user.username || String(user.id);
}

/** Constant-time-ish comparison for secrets; length leak is acceptable here. */
export function safeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
