/**
 * Link preview: the part of `/parse` that works everywhere.
 *
 * It fetches the page and reads its OpenGraph tags — the same contract every
 * link preview in every chat app uses, so the sites keep it working for their
 * own sake. No API key, no scraping of JS-rendered content, no cookies.
 *
 * This is the Worker's whole strategy and the Node path's fallback:
 *  - Worker: og:image URLs go straight back to Telegram, which fetches them
 *    itself (`sendPhoto` accepts a URL). That is a real deliverable, not a
 *    placeholder — the video card with its cover is what a reader wants.
 *  - Node: yt-dlp does the same job better; this covers the sites it gives up on.
 *
 * Rules: 3 s timeout, 400 KB cap, fail-open with a readable reason. A page that
 * is slow must not hold an update, and a page that is huge must not be read into
 * memory to find one meta tag.
 */
import { LRUCache } from "lru-cache";
import { decode } from "he";
import type { FetchLike } from "../external/http.ts";
import { detectSite, type SiteId } from "./sites.ts";
import { publicHttpUrl } from "../url-guard.ts";

export const PREVIEW_TIMEOUT_MS = 3_000;
export const PREVIEW_MAX_BYTES = 400 * 1024;

export type Preview = {
  ok: true;
  site: SiteId | "";
  title: string;
  description: string;
  images: string[];
  video: string;
};

export type PreviewFailure = { ok: false; error: string };

export type PreviewDeps = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  cache?: LRUCache<string, Preview | PreviewFailure>;
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * Fetch a page and read its preview metadata.
 *
 * `null` cache entries are treated as misses — a failed preview is cached for
 * only a minute, so a transient 502 does not disable a link for an hour.
 */
export class Previewer {
  private readonly deps: PreviewDeps;
  private readonly cache: LRUCache<string, Preview | PreviewFailure>;
  private readonly failures = new LRUCache<string, FailureEntry>({ max: 500, ttl: 60_000 });
  private readonly timeoutMs: number;

  constructor(deps: PreviewDeps = {}) {
    this.deps = deps;
    this.cache = deps.cache ?? new LRUCache<string, Preview | PreviewFailure>({ max: 500, ttl: 10 * 60_000 });
    this.timeoutMs = deps.timeoutMs ?? PREVIEW_TIMEOUT_MS;
  }

  async fetch(rawUrl: string): Promise<Preview | PreviewFailure> {
    // `url` comes from a chat message and is fetched server-side: only a public
    // http(s) address may pass, or a link to the loopback would read whatever
    // answers there in the name of a preview.
    const url = publicHttpUrl(rawUrl);
    if (!url) return { ok: false, error: "链接不是可访问的 http(s) 地址" };
    const cached = this.cache.get(url);
    if (cached) return cached;
    const failure = this.failures.get(url);
    if (failure) return { ok: false, error: failure.error };

    const result = await this.request(url);
    if (result.ok) {
      this.cache.set(url, result);
      return result;
    }
    this.failures.set(url, { error: result.error });
    return result;
  }

  private async request(url: string): Promise<Preview | PreviewFailure> {
    const doFetch = this.deps.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await doFetch(url, {
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "zh-CN,zh;q=0.9" },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
      const html = await readCapped(response, PREVIEW_MAX_BYTES);
      return parsePreview(html, response.url || url);
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      return { ok: false, error: name === "AbortError" ? "请求超时" : "连接失败" };
    } finally {
      clearTimeout(timer);
    }
  }
}

type FailureEntry = { error: string };

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return (await response.text()).slice(0, maxBytes);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) break;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= merged.byteLength) break;
    merged.set(chunk.subarray(0, merged.byteLength - offset), offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

const META = /<meta\b[^>]*>/gi;
const ATTR = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
const TITLE = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i;

/**
 * Pull `og:*` and `twitter:*` out of a page.
 *
 * Attribute order is not fixed (`content` routinely comes before `property`),
 * so each tag is parsed into a map first. Relative image URLs are resolved
 * against the final URL — after redirects, which is why `base` is `response.url`
 * and not the URL we asked for.
 */
export function parsePreview(html: string, base: string): Preview {
  const meta = new Map<string, string>();
  for (const tag of html.matchAll(META)) {
    const attrs = new Map<string, string>();
    for (const match of tag[0].matchAll(ATTR)) {
      const key = match[1].toLowerCase();
      const value = match[2] ?? match[3] ?? match[4] ?? "";
      attrs.set(key, value);
    }
    const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
    const content = attrs.get("content");
    if (key && content && !meta.has(key)) meta.set(key, decode(content));
  }

  const titleTag = TITLE.exec(html)?.[1] ?? "";
  const title = (meta.get("og:title") ?? meta.get("twitter:title") ?? decode(titleTag)).trim().slice(0, 200);
  const description = (meta.get("og:description") ?? meta.get("description") ?? "").trim().slice(0, 300);

  const candidates = [
    meta.get("og:image"),
    meta.get("og:image:secure_url"),
    meta.get("twitter:image"),
    meta.get("twitter:image:src"),
  ].filter((value): value is string => Boolean(value));

  const images: string[] = [];
  for (const candidate of candidates) {
    const absolute = absolutize(candidate, base);
    if (absolute && !images.includes(absolute)) images.push(absolute);
  }

  // `og:video` is frequently an HTML player page (B 站 returns a text/html
  // player URL). Handing that to `sendVideo` produces a confusing failure, so
  // only real media types survive.
  const videoType = (meta.get("og:video:type") ?? "").toLowerCase();
  const videoRaw = meta.get("og:video:secure_url") ?? meta.get("og:video") ?? meta.get("twitter:player:stream") ?? "";
  const looksPlayable = !videoType || videoType.startsWith("video/") || /\.(mp4|webm|mov)(\?|$)/i.test(videoRaw);
  const video = looksPlayable ? absolutize(videoRaw, base) ?? "" : "";

  return { ok: true, site: detectSite(base), title, description, images: images.slice(0, 9), video };
}

function absolutize(raw: string, base: string): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (/^data:/i.test(value)) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (/\.svg($|\?)/i.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}
