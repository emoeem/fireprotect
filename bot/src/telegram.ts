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

  /** `https://api.telegram.org/file/bot<token>/<path>` — the file download base. */
  get fileBase(): string {
    return `${API}/file/bot${this.token}`;
  }

  /**
   * Download a file attached to a message.
   *
   * Telegram has two limits worth guarding: bots may not download files above
   * 20 MB at all, and a hung download inside a Worker loses the update. Both
   * are checked here so callers only deal with bytes.
   */
  async download(fileId: string, maxBytes = 20 * 1024 * 1024): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
    const info = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
    if (!info.ok) return { ok: false, error: info.error };
    const size = Number(info.result.file_size ?? 0);
    if (size > maxBytes) return { ok: false, error: `文件 ${(size / 1048576).toFixed(1)}MB，超过 ${Math.round(maxBytes / 1048576)}MB 上限` };
    const path = info.result.file_path;
    if (!path) return { ok: false, error: "Telegram 没有返回 file_path" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const response = await this.fetchImpl(`${this.fileBase}/${path}`, { signal: controller.signal });
      if (!response.ok) return { ok: false, error: `下载失败 HTTP ${response.status}` };
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) return { ok: false, error: "下载结果超过大小上限" };
      return { ok: true, bytes };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Upload a document with `multipart/form-data` (the only way Bot API takes files). */
  async sendDocument(
    chatId: number,
    bytes: Uint8Array,
    filename: string,
    options: { replyTo?: number; caption?: string } = {},
  ): Promise<TgResult<{ message_id: number }>> {
    return this.sendMedia("sendDocument", chatId, "document", { bytes, filename }, options);
  }

  /**
   * `sendPhoto` / `sendVideo` / `sendDocument`, by URL or by upload.
   *
   * The URL form exists because Telegram fetches the file itself: a Worker
   * cannot reshape a 4 MB image, but it can absolutely hand Telegram the cover
   * URL from a link preview. The upload form is the self-hosted path.
   */
  async sendMedia(
    method: "sendPhoto" | "sendVideo" | "sendDocument",
    chatId: number,
    field: "photo" | "video" | "document",
    source: { url: string } | { bytes: Uint8Array; filename: string },
    options: { replyTo?: number; caption?: string } = {},
  ): Promise<TgResult<{ message_id: number }>> {
    if (!this.token) return { ok: false, error: "BOT_TOKEN 未设置", code: 0 };

    if ("url" in source) {
      const body: Record<string, unknown> = { chat_id: chatId, [field]: source.url };
      if (options.caption) body.caption = options.caption.slice(0, 1000);
      if (options.replyTo) {
        body.reply_parameters = JSON.stringify({ message_id: options.replyTo, allow_sending_without_reply: true });
      }
      return this.call<{ message_id: number }>(method, body);
    }

    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (options.caption) form.set("caption", options.caption.slice(0, 1000));
    if (options.replyTo) {
      form.set("reply_parameters", JSON.stringify({ message_id: options.replyTo, allow_sending_without_reply: true }));
    }
    // Slice the exact window: a subarray view is not a `BlobPart` on its own.
    const view = source.bytes.buffer.slice(source.bytes.byteOffset, source.bytes.byteOffset + source.bytes.byteLength) as ArrayBuffer;
    form.set(field, new Blob([view], { type: mimeFor(source.filename) }), source.filename);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      // No content-type header: fetch must set the multipart boundary itself.
      const response = await this.fetchImpl(`${API}/bot${this.token}/${method}`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      return await this.parse<{ message_id: number }>(response);
    } catch (err) {
      return { ok: false, error: errorText(err), code: 0 };
    } finally {
      clearTimeout(timer);
    }
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

    return this.parse<T>(response);
  }

  private async parse<T>(response: Response): Promise<TgResult<T>> {
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

/** Telegram checks the MIME type of `sendPhoto`; octet-stream is refused. */
function mimeFor(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "mp4") return "video/mp4";
  if (ext === "pdf") return "application/pdf";
  return "application/octet-stream";
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
