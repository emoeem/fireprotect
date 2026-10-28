/**
 * `/parse`: turn a share link into the media behind it.
 *
 * Two modes, chosen by what the deployment can actually do:
 *
 *  - **full** (self-hosted, `rt.parseDownloader` present): yt-dlp probes the
 *    page, downloads the cover and — if it is a video small enough to upload —
 *    the video. Long screenshots are sliced on the way out.
 *  - **preview** (Worker): read the page's OpenGraph tags and send the cover
 *    image by URL. Telegram fetches it, so this is a real image in the chat,
 *    not a link card. No binary ever passes through the Worker.
 *
 * Every failure is fail-open by construction: `/parse` is a read-only helper,
 * and a parse that fails must leave the original message exactly where it was.
 * Nothing in this file deletes anything.
 *
 * The job row is written *before* the work and closed afterwards, so a request
 * that dies mid-flight leaves a `pending` row instead of silence. The Node
 * entry reaps those — that is the only crash trace a Worker gives you.
 */
import type { Runtime } from "../context.ts";
import { cachesFor } from "../caches.ts";
import { parseJobAdd, parseJobFinish, parseJobsStale } from "../db/repo.ts";
import { say } from "../moderation.ts";
import { escapeHtml } from "../telegram.ts";
import { describeSite, parseUrl, type SiteId } from "./sites.ts";
import { createBreaker, type HostBreaker } from "./breaker.ts";
import type { ParseJobRow } from "../db/schema.ts";

export type ParseMedia = {
  name: string;
  bytes: Uint8Array;
  kind: "image" | "video" | "audio";
};
export type ParseResult = { ok: true; title: string; media: ParseMedia[] } | { ok: false; error: string };
export type ParseDownloader = (url: string, site: string) => Promise<ParseResult>;

/** Upload budget per message: Telegram's own cap is 50 MB. */
export const MAX_UPLOAD_BYTES = 45 * 1024 * 1024;

/** Per-chat hourly budget. A link flood is the failure mode, not a slow site. */
export function allowParse(rt: Runtime, chatId: number, limit: number): boolean {
  const cache = cachesFor(rt).parseRate;
  const now = rt.now();
  const stamps = (cache.get(chatId) ?? []).filter((at) => now - at < 3_600_000);
  if (stamps.length >= limit) {
    cache.set(chatId, stamps);
    return false;
  }
  stamps.push(now);
  cache.set(chatId, stamps);
  return true;
}

// ---------------------------------------------------------------------------
// Per-host circuit breaker
// ---------------------------------------------------------------------------

/**
 * Breaker knobs, exported so the help text and the tests agree on them.
 *
 * Three consecutive failures open the breaker. Per-host, because a ban is per
 * egress IP and therefore per host — see `breaker.ts` for the full reasoning.
 */
export const PARSE_BREAKER_FAILURE_THRESHOLD = 3;
export const PARSE_BREAKER_COOLDOWN_MS = 60_000;
export const PARSE_BREAKER_MAX_COOLDOWN_MS = 30 * 60_000;

/**
 * Breaker state per runtime.
 *
 * Same WeakMap-by-runtime trick as `caches.ts`, and for the same reason: one
 * runtime per isolate in production (the breaker must survive between updates),
 * one runtime per test case in the suite (a breaker opened by one test must not
 * refuse the next one's links). `caches.ts` is not ours to edit, so the map
 * lives here — it is the only state this module keeps.
 */
const breakers = new WeakMap<object, HostBreaker>();

/** The breaker for one runtime. Exported so a caller can pre-check before enqueueing. */
export function parseBreakerFor(rt: Runtime): HostBreaker {
  const existing = breakers.get(rt);
  if (existing) return existing;
  const created = createBreaker({
    // Injected clock: `rt.now()` is the same clock the rate limiter and the job
    // rows use, so a test can advance time without touching real timers.
    now: () => rt.now(),
    failureThreshold: PARSE_BREAKER_FAILURE_THRESHOLD,
    cooldownMs: PARSE_BREAKER_COOLDOWN_MS,
    maxCooldownMs: PARSE_BREAKER_MAX_COOLDOWN_MS,
  });
  breakers.set(rt, created);
  return created;
}

/** `https://v.douyin.com/x/` → `v.douyin.com`; an unparseable URL → "". */
export function parseHostOf(url: string): string {
  return parseUrl(url)?.hostname.toLowerCase() ?? "";
}

/**
 * What the user sees when the breaker is open.
 *
 * Deliberately NOT the rate-limit wording: "本小时解析次数已用完" is about *this
 * chat asking too often*, this one is about *the site refusing everyone*. An
 * admin reading the log must be able to tell the two apart, so the two strings
 * share no phrasing.
 */
export function parseBlockedNotice(host: string, retryAfterMs: number): string {
  const wait = retryAfterMs > 0 ? `约 ${Math.max(1, Math.ceil(retryAfterMs / 60_000))} 分钟后自动重试` : "正在重试中";
  return `该站暂不支持（连续失败已暂停）：${host} 现在取不到内容，${wait}。`;
}


export async function enqueueParse(
  rt: Runtime,
  job: { chatId: number; userId: number; messageId: number; url: string; site: SiteId | "" },
): Promise<number> {
  return parseJobAdd(rt.db, {
    chatId: job.chatId,
    userId: job.userId,
    messageId: job.messageId,
    url: job.url.slice(0, 500),
    site: job.site,
    mode: rt.parseDownloader ? "full" : "preview",
    at: rt.now(),
  }).catch(() => 0);
}

export type ParseOutcome = { ok: boolean; sent: number; mode: "full" | "preview"; error: string };

export async function runParseJob(rt: Runtime, job: Pick<ParseJobRow, "id" | "chatId" | "messageId" | "url" | "site">): Promise<ParseOutcome> {
  const mode: "full" | "preview" = rt.parseDownloader ? "full" : "preview";
  const host = parseHostOf(job.url);

  // No host (a malformed row) means no breaker: gating on "" would share one
  // bucket between every unparseable link and refuse unrelated sites.
  let outcome: ParseOutcome;
  if (!host) {
    outcome = await attemptParse(rt, job, mode);
  } else {
    const run = await parseBreakerFor(rt).run(host, () => attemptParse(rt, job, mode), { isFailure: (value) => !value.ok });
    if (run.ok) {
      outcome = run.value;
    } else if (run.reason === "open") {
      // Explicit, never a silent no-op: a user who posts a link from a banned
      // host must learn *why* nothing came back, or they will retry forever.
      outcome = { ok: false, sent: 0, mode, error: parseBlockedNotice(host, run.retryAfterMs) };
    } else {
      // The work itself failed. When that failure was the one that opened (or
      // re-opened) the breaker, say so too — the next user is about to be
      // refused, and the current one deserves the same explanation.
      // A downloader that *threw* (a native decoder blowing up on a weird
      // file) reaches here as `error` instead of a value; quoting it beats
      // reporting "解析失败" with no cause for the admin to act on.
      const thrown = run.error instanceof Error ? run.error.message.slice(0, 200) : "";
      const failed = run.value ?? { ok: false, sent: 0, mode, error: thrown || "解析失败" };
      const pause = run.retryAfterMs > 0 ? `，该站连续失败，已暂停 ${Math.max(1, Math.ceil(run.retryAfterMs / 60_000))} 分钟` : "";
      outcome = { ok: false, sent: failed.sent, mode, error: `${failed.error || "未知原因"}${pause}` };
    }
  }

  if (job.id) {
    await parseJobFinish(rt.db, job.id, {
      status: outcome.ok ? "done" : "failed",
      media: outcome.sent,
      error: outcome.error,
      mode,
      at: rt.now(),
    }).catch(() => undefined);
  }
  return outcome;
}

/** One attempt at the actual work, with no knowledge of the breaker. */
async function attemptParse(
  rt: Runtime,
  job: Pick<ParseJobRow, "chatId" | "messageId" | "url" | "site">,
  mode: "full" | "preview",
): Promise<ParseOutcome> {
  const chatId = job.chatId;
  if (rt.parseDownloader) {
    const result = await rt.parseDownloader(job.url, job.site);
    return result.ok ? await deliverMedia(rt, chatId, job.messageId, result.title, result.media) : { ok: false, sent: 0, mode, error: result.error };
  }
  const preview = await rt.previewer.fetch(job.url);
  return preview.ok
    ? await deliverPreview(rt, chatId, job.messageId, job.url, preview)
    : { ok: false, sent: 0, mode, error: preview.error };
}

/**
 * Send downloaded bytes.
 *
 * The caption carries the title on the first item only — repeating it on all
 * nine images of an album is noise. If Telegram refuses a file (too large, bad
 * container) the loop continues: eight delivered images beat zero.
 */
async function deliverMedia(rt: Runtime, chatId: number, replyTo: number, title: string, media: ParseMedia[]): Promise<ParseOutcome> {
  let sent = 0;
  let bytes = 0;
  let lastError = "";
  for (const [index, item] of media.entries()) {
    if (bytes + item.bytes.byteLength > MAX_UPLOAD_BYTES) {
      lastError = "剩余文件超过上传上限";
      break;
    }
    const { method, field } = SEND_AS[item.kind];
    const result = await rt.api.sendMedia(method, chatId, field, { bytes: item.bytes, filename: item.name }, {
      replyTo: index === 0 ? replyTo : undefined,
      caption: index === 0 && title ? title : undefined,
    });
    if (result.ok) {
      sent += 1;
      bytes += item.bytes.byteLength;
    } else {
      lastError = result.error;
    }
  }
  if (sent === 0) return { ok: false, sent, mode: "full", error: lastError || "发送失败" };
  return { ok: true, sent, mode: "full", error: lastError };
}

/**
 * Media kind → Bot API method and form field.
 *
 * Audio goes out as a document, not a photo: an audio-only download (a podcast,
 * a music post) classified as an image fails inside Telegram's own thumbnailer
 * and the user sees "解析失败" for a file that is perfectly fine. `sendAudio` is
 * not exposed by the Telegram client this core uses — `sendDocument` takes the
 * same upload path, keeps the tags we just wrote, and every client still renders
 * an inline player for an mp3 attachment.
 */
const SEND_AS: Record<ParseMedia["kind"], { method: "sendPhoto" | "sendVideo" | "sendDocument"; field: "photo" | "video" | "document" }> = {
  image: { method: "sendPhoto", field: "photo" },
  video: { method: "sendVideo", field: "video" },
  audio: { method: "sendDocument", field: "document" },
};

/** Send the cover(s) by URL and a card with the title. Nothing is uploaded. */
async function deliverPreview(
  rt: Runtime,
  chatId: number,
  replyTo: number,
  url: string,
  preview: { title: string; images: string[]; site: SiteId | ""; description: string },
): Promise<ParseOutcome> {
  let sent = 0;
  const images = preview.images.slice(0, 3);
  for (const [index, image] of images.entries()) {
    const result = await rt.api.sendMedia("sendPhoto", chatId, "photo", { url: image }, {
      replyTo: index === 0 ? replyTo : undefined,
      caption: index === 0 && preview.title ? preview.title : undefined,
    });
    if (result.ok) sent += 1;
  }
  const header = `<b>${escapeHtml(describeSite(preview.site))}</b>`;
  const lines = [header];
  if (preview.title) lines.push(escapeHtml(preview.title));
  lines.push(`<a href="${escapeHtml(url)}">原链接</a>`);
  lines.push(sent === 0 ? "（预览图取不到，点原链接看）" : "（自托管版可取完整图集/视频）");
  const card = await say(rt, chatId, lines.join("\n"), { html: true, replyTo: images.length ? undefined : replyTo });
  if (!card.ok && sent === 0) return { ok: false, sent, mode: "preview", error: "预览和封面都发不出去" };
  return { ok: true, sent: Math.max(sent, 1), mode: "preview", error: "" };
}

/**
 * Retry jobs a crashed request left behind.
 *
 * Only meaningful where a real downloader exists: a Worker cannot do better on
 * the second attempt than it did on the first, and retrying a preview forever
 * would just hammer the site.
 */
export async function runParseQueue(rt: Runtime, limit = 5): Promise<{ checked: number; done: number; failed: number }> {
  if (!rt.parseDownloader) return { checked: 0, done: 0, failed: 0 };
  const stale = await parseJobsStale(rt.db, rt.now() - 90_000, limit).catch(() => [] as ParseJobRow[]);
  let done = 0;
  let failed = 0;
  for (const job of stale) {
    const outcome = await runParseJob(rt, job);
    if (outcome.ok) done += 1;
    else failed += 1;
  }
  return { checked: stale.length, done, failed };
}
