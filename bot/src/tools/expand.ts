/**
 * `/expand` — what is behind a t.me link.
 *
 * Two sources: the public preview page (`t.me/<name>`), and the embed page
 * (`t.me/<name>/<id>?embed=1`) which carries OpenGraph tags for one post.
 * Nothing is downloaded beyond the HTML and nothing is sent anywhere.
 */
import type { FetchLike } from "../external/http.ts";

export type LinkInfo = {
  channel: string;
  post: number;
  title: string;
  excerpt: string;
  /** True when the preview page listed posts (a real, public channel). */
  public: boolean;
};

export type ExpandResult = { ok: true; info: LinkInfo } | { ok: false; error: string };

export function parseTelegramLink(input: string): { channel: string; post: number } | null {
  const raw = String(input ?? "").trim();
  const match = raw.match(/^(?:https?:\/\/)?t(?:elegram)?\.me\/([A-Za-z][A-Za-z0-9_]{3,31})(?:\/(\d+))?/);
  if (!match) return null;
  return { channel: match[1] as string, post: match[2] ? Number(match[2]) : 0 };
}

function meta(html: string, property: string): string {
  const pattern = new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`, "i");
  return html.match(pattern)?.[1] ?? "";
}

function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export async function resolveTelegramLink(input: string, fetchImpl?: FetchLike): Promise<ExpandResult> {
  const parsed = parseTelegramLink(input);
  if (!parsed) return { ok: false, error: "只认 t.me/<频道> 或 t.me/<频道>/<帖子号>" };

  const doFetch = fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const url = parsed.post
    ? `https://t.me/${parsed.channel}/${parsed.post}?embed=1`
    : `https://t.me/s/${parsed.channel}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await doFetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; flareward/1.0)" },
      signal: controller.signal,
    });
    if (response.status === 404) return { ok: false, error: "链接不存在或频道已私有" };
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const html = await response.text();
    const title = decode(meta(html, "og:title"));
    const description = decode(meta(html, "og:description"));
    return {
      ok: true,
      info: {
        channel: parsed.channel,
        post: parsed.post,
        title: title || `@${parsed.channel}`,
        excerpt: description.slice(0, 300),
        public: html.includes("data-post=") || Boolean(title),
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? (err.name === "AbortError" ? "请求超时" : err.message) : String(err);
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
}
