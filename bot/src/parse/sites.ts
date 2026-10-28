/**
 * Supported sites for `/parse`.
 *
 * Five, not fifty. Every extractor is a maintenance contract with a site that
 * changes its markup whenever it feels like it, and a parser that silently
 * returns nothing is indistinguishable from a broken bot. A site that is not in
 * this table gets a clear "不支持这个站" instead of a spinner.
 *
 * The bot never strips a watermark by editing pixels: "去水印" here means
 * "fetch the original file the page itself serves", which is the only version
 * that is both honest and stable.
 */
export type SiteId = "douyin" | "xiaohongshu" | "twitter" | "bilibili";

export const SITES: { id: SiteId; label: string; hosts: RegExp }[] = [
  { id: "douyin", label: "抖音", hosts: /(^|\.)(douyin|iesdouyin)\.com$/i },
  { id: "xiaohongshu", label: "小红书", hosts: /(^|\.)(xiaohongshu|xhslink)\.com$/i },
  { id: "twitter", label: "X / 推特", hosts: /(^|\.)(twitter|x)\.com$|(^|\.)t\.co$/i },
  { id: "bilibili", label: "B 站", hosts: /(^|\.)(bilibili|b23)\.(com|tv)$/i },
];

export function siteLabel(site: string): string {
  return SITES.find((entry) => entry.id === site)?.label ?? site;
}

/** `https://v.douyin.com/abc/` → `douyin`; anything else → "". */
export function detectSite(raw: string): SiteId | "" {
  const url = parseUrl(raw);
  if (!url) return "";
  return SITES.find((entry) => entry.hosts.test(url.hostname))?.id ?? "";
}

export function parseUrl(raw: string): URL | null {
  const text = String(raw ?? "").trim();
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    return url.hostname ? url : null;
  } catch {
    return null;
  }
}

const URL_RE = /https?:\/\/[^\s<>"'）)】]+/gi;

/**
 * Every URL in a message, entities first.
 *
 * `text_link` is the case that matters: the visible text says "点这里" and the
 * URL exists only in the entity, so a regex over the text would miss it.
 */
export function extractUrls(text: string, entities: { type: string; url?: string }[] = []): string[] {
  const found: string[] = [];
  for (const entity of entities) {
    if ((entity.type === "url" || entity.type === "text_link") && entity.url) found.push(entity.url);
  }
  for (const match of String(text ?? "").matchAll(URL_RE)) found.push(match[0]);
  return [...new Set(found.map((url) => url.replace(/[.,;:!?。，；：！？）)》」』】]+$/u, "")))];
}

/** The first supported link in a message, if any. */
export function firstSupported(text: string, entities: { type: string; url?: string }[] = []): { url: string; site: SiteId } | null {
  for (const url of extractUrls(text, entities)) {
    const site = detectSite(url);
    if (site) return { url, site };
  }
  return null;
}

/** Telegram-visible label for a job's site, or a readable fallback. */
export function describeSite(site: string): string {
  return site ? siteLabel(site) : "外部链接";
}
