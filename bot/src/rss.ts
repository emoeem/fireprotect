/**
 * RSS subscriptions: `/sub`, `/unsub`, `/unsubthis`, `/sub export` (OPML) and the
 * poller that delivers new items.
 *
 * Three decisions shape this file, and each one is the answer to a failure mode
 * the mirror code (`sync.ts`) already hit:
 *
 *  - **One row per (chat, feed), not one row per feed.** Two groups may follow
 *    the same URL and they must not share a watermark: if they did, whichever
 *    group got polled first would advance the marker and the second group would
 *    silently receive nothing. The unique index is on `(chat_id, url)` for that
 *    reason, and the failure counter is per row for the same reason — one group
 *    hitting a broken feed must not unsubscribe it for everybody.
 *
 *  - **The watermark is the item's own identifier, not a number.** RSS has no
 *    global post counter (unlike `t.me/s/`, where the post id is monotonic), so
 *    the marker is the `guid`/`link` of the last item delivered. Items are
 *    matched by identity against that marker instead of being compared.
 *
 *  - **The parser is injected, never imported.** `rss-parser` drags in `xml2js`
 *    and Node's `http` module; importing it here would put both in the Worker
 *    bundle. `deps.parse` is supplied by `rss.node.ts` on a self-hosted
 *    deployment, and `rt.rssParse` (which decides whether `/sub` is even
 *    accepted) is absent on Workers.
 *
 * Nothing in this file may throw into the message pipeline: every command
 * returns a string (success or reason), and `pollFeeds` reports failures in its
 * result object instead of rejecting.
 */
import type { Runtime } from "./context.ts";
import {
  rssFeedAdd,
  rssFeedByUrl,
  rssFeedCount,
  rssFeedDelete,
  rssFeedGet,
  rssFeedList,
  rssFeedMark,
  rssPollable,
  type RssFeedRow,
} from "./db/repo.ts";
import { say } from "./moderation.ts";
import { extractUrls } from "./parse/sites.ts";
import { errorText, escapeHtml } from "./telegram.ts";

/** Telegram messages are 4096 bytes; leave room for the escaping to grow. */
export const CHUNK_LIMIT = 3500;

/**
 * Twenty feeds per chat.
 *
 * A group that subscribes to more than this is not curating, it is dumping; and
 * every feed is a URL somebody else's deployment fetches, on rotation, forever.
 */
export const MAX_FEEDS_PER_CHAT = 20;

/** Consecutive failures before a feed is dropped. Same budget as a mirror. */
export const MAX_FEED_FAILURES = 5;

/**
 * How many new items one poll may deliver per feed.
 *
 * A first poll of a blog with 5,000 archived posts would otherwise empty the
 * whole archive into the group. Ten is a readable burst; the rest arrive on the
 * following ticks, oldest first, so nothing is skipped.
 */
export const MAX_ITEMS_PER_POLL = 10;

/** Long enough for real feed URLs with query strings, short enough to store. */
export const MAX_FEED_URL = 500;

/** The exact sentence a Worker answers with: it must never pretend to poll. */
export const RSS_NEEDS_NODE = "RSS 轮询需要自托管部署，当前 Worker 形态不支持";

// ---------------------------------------------------------------------------
// Injected parser contract
// ---------------------------------------------------------------------------

/**
 * The only shape this subsystem needs from a feed.
 *
 * Deliberately minimal, and deliberately *not* `rss-parser`'s own types: the
 * shared core must be compilable without that package being resolvable, which is
 * what keeps a Worker build from accidentally depending on it.
 */
export type FeedItem = { guid?: string; link?: string; title?: string; isoDate?: string };
export type FeedLike = { title?: string; items: FeedItem[] };
export type FeedParser = (url: string) => Promise<FeedLike>;

export type RssDeps = { parse: FeedParser };

export type RssPollResult = {
  checked: number;
  delivered: number;
  failed: number;
  /** Feeds dropped for hitting `MAX_FEED_FAILURES`. */
  removed: number;
  /** Human-readable failures. Never thrown; the timer logs these. */
  errors: string[];
};

/**
 * Can this deployment poll at all?
 *
 * `Runtime.rssParse` is injected only by the Node entry: a Worker has neither
 * `rss-parser` nor a scheduler to run it on, so this is exactly "self-hosted,
 * code running on a real machine".
 */
export function rssAvailable(rt: Runtime): boolean {
  // Checks the feed parser, not `parseDownloader`. They are injected together by
  // the Node entry today, but "can this deployment fetch feeds" is the question
  // being asked here, and answering it with a yt-dlp field would go stale the
  // first time somebody wires one without the other.
  return Boolean(rt.rssParse);
}

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

/**
 * Addresses a feed URL may never point at.
 *
 * The bot fetches whatever URL an admin pastes, from inside the deployment's own
 * network, so `http://169.254.169.254/latest/meta-data/` would be a cloud
 * credential leak and `http://127.0.0.1:6379/` a Redis probe. The guard is on the
 * *literal* host only: a Worker cannot resolve DNS, and resolving here would be
 * a whole second SSRF surface (and a TOCTOU one), so a public hostname that
 * resolves to `10.x` is out of reach of this check. That limit is stated in the
 * README rather than papered over.
 */
const V4_PRIVATE: { re: RegExp; reason: string }[] = [
  { re: /^0\./, reason: "0.0.0.0/8 保留地址" },
  { re: /^10\./, reason: "内网地址 10.0.0.0/8" },
  { re: /^127\./, reason: "本机回环 127.0.0.0/8" },
  { re: /^169\.254\./, reason: "链路本地 169.254.0.0/16（云元数据）" },
  { re: /^192\.168\./, reason: "内网地址 192.168.0.0/16" },
  { re: /^172\.(1[6-9]|2\d|3[01])\./, reason: "内网地址 172.16.0.0/12" },
  { re: /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, reason: "运营商级 NAT 100.64.0.0/10" },
];

function ipv6Reason(host: string): string {
  if (host === "::" || host === "::1") return "本机回环";
  // `fc00::/7` unique-local and `fe80::/10` link-local, written as the first
  // hexadecimal digit(s) rather than a CIDR — the URL parser has already
  // normalised the address by the time it reaches here.
  if (/^f[cd]/i.test(host)) return "唯一本地地址 fc00::/7";
  if (/^fe[89ab]/i.test(host)) return "链路本地 fe80::/10";
  if (host.startsWith("::ffff:")) return "IPv4 映射地址";
  return "";
}

/**
 * Why this host must not be fetched, or "" when it is acceptable.
 *
 * WHATWG URL parsing does the heavy lifting: `http://2130706433/`, `http://127.1/`
 * and `http://0x7f.0.0.1/` all normalise to `127.0.0.1` before this runs, so the
 * decimal/octal/hex obfuscations need no special cases here.
 */
export function privateHostReason(hostname: string): string {
  const host = String(hostname ?? "")
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
  if (!host) return "空主机名";
  if (host === "localhost" || host.endsWith(".localhost")) return "本机 localhost";
  // mDNS and the private-use TLDs: no public feed lives at `.local`.
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return "局域网域名";
  if (host.includes(":")) return ipv6Reason(host);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    for (const entry of V4_PRIVATE) if (entry.re.test(host)) return entry.reason;
    return "";
  }
  // A single-label name ("intranet", "nas") is a search-domain lookup, i.e. an
  // internal host by construction; no public feed is published on one.
  if (!host.includes(".")) return "单段主机名（内网名）";
  return "";
}

export type FeedUrlCheck = { ok: true; url: string } | { ok: false; error: string };

/**
 * Validate and normalise a `/sub` argument.
 *
 * Normalising here is what makes the `(chat_id, url)` dedupe meaningful: the same
 * feed pasted as `HTTPS://Example.COM/feed#top` and `https://example.com/feed`
 * must collide instead of creating two rows that both deliver.
 */
export function checkFeedUrl(input: string): FeedUrlCheck {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, error: "用法：/sub <feed 地址>，例如 /sub https://example.com/feed.xml" };
  if (raw.length > MAX_FEED_URL) return { ok: false, error: `地址太长（上限 ${MAX_FEED_URL} 字符）。` };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "这不是一个有效的订阅地址，需要 http:// 或 https:// 开头。用法：/sub <feed 地址>" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `只支持 http/https，${parsed.protocol.replace(":", "")} 不行。` };
  }
  const reason = privateHostReason(parsed.hostname);
  if (reason) return { ok: false, error: `拒绝这个地址：${reason}。只能订阅公网 feed。` };
  if (parsed.username || parsed.password) {
    // A URL with credentials is stored verbatim and echoed in the group; a feed
    // that needs auth is better served by a deployment-level credential later.
    return { ok: false, error: "链接里带账号密码，会明文出现在群里，去掉再试。" };
  }
  parsed.hash = "";
  return { ok: true, url: parsed.toString() };
}

// ---------------------------------------------------------------------------
// Watermark maths
// ---------------------------------------------------------------------------

/**
 * Identity of one item, in the order the subscription must use it.
 *
 * `guid` first because it survives an item whose link is rewritten on every
 * fetch (tracking parameters are a common cause of duplicate deliveries when a
 * link is used as the key). Falls back to link, then to date+title.
 */
export function itemKey(item: FeedItem): string {
  const guid = String(item.guid ?? "").trim();
  if (guid) return guid.slice(0, 300);
  const link = String(item.link ?? "").trim();
  if (link) return link.slice(0, 300);
  const iso = String(item.isoDate ?? "").trim();
  const title = String(item.title ?? "").trim();
  if (iso || title) return `${iso}|${title}`.slice(0, 300);
  return "";
}

export type FreshBatch = { fresh: FeedItem[]; watermark: string };

/**
 * Which items are new, and what the new watermark is.
 *
 * Feeds are newest-first, so the marker is *found* and everything above it is new.
 * The batch is returned oldest-first (reversed) because a group reading ten items
 * top-down should get them in publication order.
 *
 * Two cases where the marker is absent, both handled as "cold start": a brand new
 * subscription, and a feed that rotated the item off its window. Cold start
 * delivers the newest `cap` items — a rotation therefore costs up to `cap`
 * duplicates once, which is the honest trade. The alternative (deliver nothing
 * until the marker reappears) leaves a single-item feed permanently silent.
 */
export function freshItems(items: FeedItem[], lastKey: string, cap = MAX_ITEMS_PER_POLL): FreshBatch {
  const keyed: { item: FeedItem; key: string }[] = [];
  for (const item of items) {
    const key = itemKey(item);
    // An item with no guid/link/date/title cannot be recognised next time, so
    // delivering it would repeat it forever.
    if (key) keyed.push({ item, key });
  }
  if (!keyed.length) return { fresh: [], watermark: lastKey };

  const at = lastKey ? keyed.findIndex((entry) => entry.key === lastKey) : -1;
  if (at < 0) {
    const newest = keyed.slice(0, Math.max(1, cap));
    return { fresh: newest.map((entry) => entry.item).reverse(), watermark: newest[0]?.key ?? lastKey };
  }
  if (at === 0) return { fresh: [], watermark: lastKey };

  const newer = keyed.slice(0, at).reverse(); // oldest first
  const batch = newer.slice(0, Math.max(1, cap));
  return { fresh: batch.map((entry) => entry.item), watermark: batch[batch.length - 1]?.key ?? lastKey };
}

/** The message body for one item; "" when there is nothing worth sending. */
export function itemText(feedTitle: string, item: FeedItem): string {
  const title = String(item.title ?? "").trim();
  const link = String(item.link ?? "").trim();
  if (!title && !link) return "";
  const lines: string[] = [];
  lines.push(`<b>${escapeHtml(title || "（无标题）")}</b>`);
  if (link) lines.push(escapeHtml(link));
  if (feedTitle) lines.push(`来自 ${escapeHtml(feedTitle)}`);
  return lines.join("\n").slice(0, 3500);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Wrap a command body so a database failure comes back as a sentence.
 *
 * The dispatcher formats the reply, so the contract is "always resolves to a
 * string". A `SQLITE_BUSY` thrown out of here would otherwise take down the
 * update that carried the command.
 */
async function guarded(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    return `操作失败：${errorText(err)}`;
  }
}

function ago(ms: number): string {
  if (ms < 0) return "刚刚";
  if (ms < 60_000) return "刚刚";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
  return `${Math.floor(ms / 86_400_000)} 天前`;
}

export function describeFeed(row: RssFeedRow, now: number): string {
  const label = row.title || row.url;
  const parts = [`已推送 ${row.sent}`, row.lastSeenAt ? ago(now - row.lastSeenAt) : "未同步"];
  if (row.failures > 0) parts.push(`失败 ${row.failures}/${MAX_FEED_FAILURES}：${row.lastError.slice(0, 60) || "未知错误"}`);
  return `#${row.id} ${label} · ${parts.join(" · ")}`;
}

/**
 * `/sub <url>` and `/sub list`.
 *
 * A Worker refuses outright. Accepting the row would leave an admin with a
 * subscription that never fires and no error anywhere — worse than a clear
 * refusal, because it looks like it worked.
 */
export async function cmdSub(rt: Runtime, chatId: number, args: string): Promise<string> {
  return guarded(async () => {
    const trimmed = String(args ?? "").trim();
    if (!trimmed || trimmed.toLowerCase() === "list") return cmdSubList(rt, chatId);

    // Validate before checking capability: "乱写" is a user error on every
    // deployment, and answering it with "this build cannot do RSS" sends the
    // admin to check the deployment instead of the URL.
    const first = trimmed.split(/\s+/)[0] ?? "";
    const checked = checkFeedUrl(first);
    if (!checked.ok) return checked.error;

    if (!rssAvailable(rt)) return RSS_NEEDS_NODE;

    const existing = await rssFeedByUrl(rt.db, chatId, checked.url);
    if (existing) return `这个群已经订阅过 #${existing.id}：${existing.title || existing.url}`;

    const count = await rssFeedCount(rt.db, chatId);
    if (count >= MAX_FEEDS_PER_CHAT) {
      return `每个群最多 ${MAX_FEEDS_PER_CHAT} 个 RSS 源（现在 ${count} 个），先用 /unsub 去掉一个再加。`;
    }

    const id = await rssFeedAdd(rt.db, { chatId, url: checked.url, at: rt.now() });
    if (!id) return "订阅没写进数据库，稍后再试。";
    return [
      `已订阅 #${id}：${checked.url}`,
      `本群已用 ${count + 1}/${MAX_FEEDS_PER_CHAT}。标题和条目会在下一次轮询后出现。`,
    ].join("\n");
  });
}

export async function cmdSubList(rt: Runtime, chatId: number): Promise<string> {
  return guarded(async () => {
    const rows = await rssFeedList(rt.db, chatId);
    const note = rssAvailable(rt) ? "" : `（${RSS_NEEDS_NODE}，订阅不会自动更新）`;
    if (!rows.length) {
      return ["本群还没有 RSS 订阅。用法：/sub <feed 地址>", note].filter(Boolean).join("\n");
    }
    const now = rt.now();
    const lines = [`本群 RSS 订阅（${rows.length}/${MAX_FEEDS_PER_CHAT}）：`];
    for (const row of rows) lines.push(describeFeed(row, now));
    lines.push("移除：/unsub ID 或 /unsub <地址>｜回复带链接的消息后 /unsubthis｜导出 OPML：/sub export");
    if (note) lines.push(note);
    return lines.join("\n");
  });
}

/** `/unsub <id>` or `/unsub <url>` — both scoped to this chat. */
export async function cmdUnsub(rt: Runtime, chatId: number, args: string): Promise<string> {
  return guarded(async () => {
    const raw = String(args ?? "").trim();
    if (!raw) return "用法：/unsub ID 或 /unsub <feed 地址>（ID 用 /sub list 查）";
    const first = raw.split(/\s+/)[0] ?? "";

    if (/^\d+$/.test(first)) {
      const id = Number(first);
      const row = await rssFeedGet(rt.db, chatId, id);
      if (!row) return `本群没有 #${id} 的订阅。用 /sub list 看编号。`;
      await rssFeedDelete(rt.db, chatId, id);
      return `已移除 #${id}：${row.title || row.url}`;
    }

    const checked = checkFeedUrl(first);
    const candidates = checked.ok ? [checked.url, first] : [first];
    for (const candidate of candidates) {
      const row = await rssFeedByUrl(rt.db, chatId, candidate);
      if (!row) continue;
      await rssFeedDelete(rt.db, chatId, row.id);
      return `已移除 #${row.id}：${row.title || row.url}`;
    }
    // The guard's refusal is not a useful answer here: the row does not exist, so
    // saying "本群没有订阅这个地址" is the true statement.
    return checked.ok ? `本群没有订阅 ${checked.url}。` : `本群没有订阅 ${first.slice(0, 80)}。${checked.error}`;
  });
}

export type RepliedLike =
  | { text?: string; caption?: string; entities?: { type: string; url?: string }[] }
  | null
  | undefined;

/**
 * `/unsubthis`: drop the feed whose URL is in the replied-to message.
 *
 * This is the path that actually gets used: someone posts "这个源不错", an admin
 * replies `/sub <url>`, and later replies `/unsubthis` instead of copy-pasting the
 * address back. Entities are read as well as text, because a link is often only
 * inside a `text_link` entity.
 */
export async function cmdUnsubThis(rt: Runtime, chatId: number, replied: RepliedLike): Promise<string> {
  return guarded(async () => {
    if (!replied) return "先回复一条包含 feed 地址的消息，再发 /unsubthis。";
    const body = [replied.text, replied.caption].filter(Boolean).join("\n");
    const urls = extractUrls(body, replied.entities ?? []);
    if (!urls.length) return "这条消息里没有链接，没有可移除的订阅。先回复一条包含 feed 地址的消息再试。";

    const removed: string[] = [];
    for (const url of urls) {
      const checked = checkFeedUrl(url);
      const candidates = checked.ok ? [checked.url, url] : [url];
      for (const candidate of candidates) {
        const row = await rssFeedByUrl(rt.db, chatId, candidate);
        if (!row) continue;
        await rssFeedDelete(rt.db, chatId, row.id);
        removed.push(row.title || row.url);
        break;
      }
    }
    if (!removed.length) return "这条消息里的链接都不在本群订阅里。";
    return `已移除：${removed.join("、")}`;
  });
}

// ---------------------------------------------------------------------------
// OPML export
// ---------------------------------------------------------------------------

/**
 * Drop the characters XML 1.0 cannot represent at all.
 *
 * The valid ranges are tab, LF, CR and then `#x20` upward, so a C0 control has no
 * escape form: writing `&#1;` does not make the document valid, it makes it
 * unparseable. DEL is dropped alongside them because it is invisible in every
 * reader and only ever arrives as corruption. C1 (`#x80`-`#x9F`) is legal, if
 * discouraged, and is left alone rather than silently deleting bytes of a title.
 */
function stripUnprintable(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const forbidden = (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
    if (!forbidden) out += char;
  }
  return out;
}

/**
 * Escape a value for XML text or a quoted attribute.
 *
 * All five predefined entities, because the value goes into `xmlUrl="..."` as
 * well as into element text, and an unescaped `&` in a query string is the most
 * common way an OPML export stops being XML.
 */
export function xmlEscape(value: unknown): string {
  return stripUnprintable(String(value ?? ""))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Hostname for a feed URL, used as an outline title before a poll learns one. */
function feedHost(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

export type OpmlFeed = { title?: string; url: string };

/**
 * OPML 2.0 for a set of feeds.
 *
 * `type="rss"` is what every reader (Feedly, Inoreader, NetNewsWire) keys on;
 * `text` and `title` carry the same value because readers disagree about which
 * one to display. `xmlUrl` is the feed, and there is deliberately no `htmlUrl` —
 * we never learn a feed's site URL reliably, and a wrong one makes readers
 * import a broken entry.
 */
export function buildOpml(feeds: OpmlFeed[], options: { title?: string; dateCreated?: number } = {}): string {
  const title = options.title || "焰卫 RSS 订阅";
  const created = new Date(options.dateCreated ?? Date.now()).toUTCString();
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<opml version="2.0">`,
    `  <head>`,
    `    <title>${xmlEscape(title)}</title>`,
    `    <dateCreated>${xmlEscape(created)}</dateCreated>`,
    `    <ownerName>焰卫</ownerName>`,
    `  </head>`,
    `  <body>`,
  ];
  for (const feed of feeds) {
    const label = feed.title || feedHost(feed.url);
    lines.push(
      `    <outline type="rss" text="${xmlEscape(label)}" title="${xmlEscape(label)}" xmlUrl="${xmlEscape(feed.url)}"/>`,
    );
  }
  lines.push(`  </body>`, `</opml>`, ``);
  return lines.join("\n");
}

/**
 * Split a document for Telegram's 4096-byte limit.
 *
 * Cuts on a newline where one is available so an OPML outline does not arrive
 * split in the middle of its `xmlUrl` — the reader will still reassemble a
 * pasted document, but a readable split is what a human copies correctly.
 */
export function chunkForTelegram(text: string, limit = CHUNK_LIMIT): string[] {
  const size = Math.max(200, limit);
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const window = rest.slice(0, size);
    const newline = window.lastIndexOf("\n");
    const cut = newline > size * 0.5 ? newline + 1 : size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** `/sub export`: this chat's feeds as an OPML document (or why it is empty). */
export async function cmdRssExport(rt: Runtime, chatId: number, chatTitle = ""): Promise<string> {
  return guarded(async () => {
    const rows = await rssFeedList(rt.db, chatId);
    if (!rows.length) return "本群还没有 RSS 订阅，先 /sub <地址> 添加一个再导出。";
    return buildOpml(
      rows.map((row) => ({ title: row.title || feedHost(row.url), url: row.url })),
      { title: chatTitle ? `${chatTitle} · RSS` : "焰卫 RSS 订阅", dateCreated: rt.now() },
    );
  });
}

/**
 * `/sub export` end to end: chunked sending, so a large document is not a
 * Telegram 400.
 *
 * Twenty feeds with ordinary titles come to about 3 KB, but twenty feeds with
 * maximum-length titles and URLs reach 25 KB — five times Telegram's limit — and
 * `sendMessage` refuses that outright. The cap at four chunks matches the config
 * export, and the admin is told when something was left out rather than being
 * handed a silently truncated document.
 */
export async function sendRssExport(
  rt: Runtime,
  chatId: number,
  chatTitle = "",
): Promise<{ ok: boolean; chunks: number; error: string }> {
  const text = await cmdRssExport(rt, chatId, chatTitle);
  const chunks = chunkForTelegram(text);
  let sent = 0;
  for (const chunk of chunks.slice(0, 4)) {
    const res = await say(rt, chatId, chunk);
    if (!res.ok) return { ok: false, chunks: sent, error: res.error };
    sent += 1;
  }
  if (chunks.length > 4) {
    await say(rt, chatId, "OPML 太长，只发了前 4 段。删掉几个订阅再导出，或用 /unsub 精简。");
    return { ok: true, chunks: sent, error: "导出被截断" };
  }
  return { ok: true, chunks: sent, error: "" };
}

// ---------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------

type StepResult = { delivered: number; failed: boolean; removed: boolean; error: string };

/**
 * One feed: parse, then deliver whatever is newer than the watermark.
 *
 * Failure accounting lives in `registerFailure`; the split exists because a
 * delivery refusal and a fetch refusal mean the same thing to the subscription
 * (it is not working) but need different sentences in the log.
 */
async function pollOne(rt: Runtime, deps: RssDeps, row: RssFeedRow, now: number): Promise<StepResult> {
  let feed: FeedLike;
  try {
    feed = await deps.parse(row.url);
  } catch (err) {
    return registerFailure(rt, row, `抓取失败：${errorText(err)}`, now);
  }
  if (!feed || typeof feed !== "object") {
    return registerFailure(rt, row, "解析结果不是 feed", now);
  }

  const title = String(feed.title ?? "").trim().slice(0, 120);
  const items = Array.isArray(feed.items) ? feed.items : [];
  const { fresh } = freshItems(items, row.lastKey);

  // An EMPTY item list is a success, not a failure: plenty of feeds are empty for
  // an afternoon (a podcast between seasons, a blog on hiatus), and counting that
  // as broken would unsubscribe a perfectly good source within five ticks.
  if (!fresh.length) {
    await rssFeedMark(rt.db, row.id, {
      failures: 0,
      lastError: "",
      at: now,
      lastSeenAt: now,
      ...(title && title !== row.title ? { title } : {}),
    });
    return { delivered: 0, failed: false, removed: false, error: "" };
  }

  let sent = 0;
  let lastKey = row.lastKey;
  let error = "";
  for (const item of fresh) {
    const text = itemText(title || row.title, item);
    // No title and no link: nothing to show, but the watermark still advances so
    // the item is not retried forever.
    if (!text) {
      lastKey = itemKey(item);
      continue;
    }
    const res = await say(rt, row.chatId, text, { html: true });
    if (!res.ok) {
      error = res.error;
      break;
    }
    sent += 1;
    lastKey = itemKey(item);
  }

  if (sent === 0 && error) return registerFailure(rt, row, `发送失败：${error}`, now);

  await rssFeedMark(rt.db, row.id, {
    lastKey,
    sent,
    failures: 0,
    lastError: "",
    at: now,
    lastSeenAt: now,
    ...(title && title !== row.title ? { title } : {}),
  });
  return { delivered: sent, failed: false, removed: false, error: "" };
}

/**
 * Count a failure, and retire the feed on the fifth consecutive one.
 *
 * Retiring means deleting the row, not `enabled = 0`: an auto-disabled feed would
 * sit in `/sub list` forever asking the admin to fix something that may not be
 * fixable, and a row that is gone is re-added with one `/sub`. The alert names the
 * URL because after the delete it exists nowhere else.
 */
async function registerFailure(rt: Runtime, row: RssFeedRow, error: string, now: number): Promise<StepResult> {
  const failures = row.failures + 1;
  const reason = error.slice(0, 180);
  if (failures >= MAX_FEED_FAILURES) {
    await rssFeedDelete(rt.db, row.chatId, row.id);
    await say(
      rt,
      row.chatId,
      `RSS 订阅已自动移除：${row.title || row.url}\n连续 ${failures} 次抓不到（${reason}）。想继续跟踪就重新 /sub。`,
    );
    return { delivered: 0, failed: true, removed: true, error: `${row.url}: ${reason}` };
  }
  await rssFeedMark(rt.db, row.id, { failures, lastError: reason, at: now });
  return { delivered: 0, failed: true, removed: false, error: `${row.url}: ${reason}` };
}

/**
 * Poll a slice of subscriptions. Called by the Node entry on a timer.
 *
 * Never rejects: the caller is an interval that has to survive a dead feed, a
 * database hiccup and a parser that throws a string instead of an Error. Each row
 * is isolated, and the outer guard exists for the failure mode the inner one
 * cannot see — `rssPollable` itself failing.
 */
export async function pollFeeds(rt: Runtime, deps: RssDeps, limit = 20): Promise<RssPollResult> {
  const out: RssPollResult = { checked: 0, delivered: 0, failed: 0, removed: 0, errors: [] };
  if (!deps || typeof deps.parse !== "function") {
    out.errors.push("没有可用的 feed 解析器（Worker 形态不具备 RSS 能力）");
    return out;
  }

  let rows: RssFeedRow[];
  try {
    rows = await rssPollable(rt.db, limit);
  } catch (err) {
    out.errors.push(`读取订阅失败：${errorText(err)}`);
    return out;
  }

  for (const row of rows) {
    out.checked += 1;
    try {
      const step = await pollOne(rt, deps, row, rt.now());
      out.delivered += step.delivered;
      if (step.failed) out.failed += 1;
      if (step.removed) out.removed += 1;
      if (step.error) out.errors.push(step.error);
    } catch (err) {
      // Backstop only: `pollOne` already converts everything it can. Reaching
      // here means the database itself is unhappy, and that is one feed's worth
      // of damage, not the whole tick.
      out.failed += 1;
      out.errors.push(`${row.url}: ${errorText(err)}`);
    }
  }
  return out;
}
