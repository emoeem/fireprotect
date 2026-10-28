/**
 * The self-hosted half of `/rss`: fetching the document and parsing the XML.
 *
 * Split from `rss.ts` for one reason: `rss-parser` pulls in `xml2js` and Node's
 * `http` module, and the Worker build must never bundle either. Keeping the
 * import in a `.node.ts` file mirrors `parse/ytdlp.node.ts` and `tools/slice.node.ts`
 * — the Worker dependency graph simply never reaches this file.
 *
 * `parseString` is used instead of `parseURL` on purpose: we fetch with `fetch`
 * so the timeout is an `AbortSignal` we own (and can be stubbed in tests), rather
 * than rss-parser's separate `setTimeout` path that also brings its own redirect
 * loop and header handling.
 */
import Parser from "rss-parser";
import { errorText, type FetchLike } from "./telegram.ts";
import type { FeedItem, FeedLike, FeedParser } from "./rss.ts";

export type NodeFeedParserOptions = {
  /** Injected in tests; production uses global `fetch`. */
  fetchImpl?: FetchLike;
  /** Whole-request budget. A feed that cannot answer in ten seconds is not news. */
  timeoutMs?: number;
  userAgent?: string;
};

const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; flareward/1.0; rss)";

/**
 * Both feed families, in one header.
 *
 * A server that only offers `application/rss+xml` will still answer a bare
 * wildcard Accept, but a CDN in front of it may content-negotiate on this value,
 * and a wrong `Accept` is a 406 that looks like "feed is dead" in the failure
 * counter. (The list below ends with a wildcard, which is why this sentence
 * describes it instead of quoting it: a quoted one closes this comment.)
 */
const ACCEPT = "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Build a parser bound to one transport.
 *
 * The returned function throws on every failure (HTTP status, timeout, bad XML,
 * not-a-feed). That is deliberate: `pollFeeds` counts a throw as one failure and
 * has the sentence to show the admin, so a parser that swallowed errors and
 * returned `{items: []}` would silently look like a healthy empty feed.
 */
export function nodeFeedParser(options: NodeFeedParserOptions = {}): FeedParser {
  const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 10_000, 60_000));
  const parser = new Parser({ timeout: timeoutMs, headers: { accept: ACCEPT } });

  return async (url: string): Promise<FeedLike> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let xml = "";
    try {
      const response = await doFetch(url, {
        headers: { "user-agent": options.userAgent ?? DEFAULT_USER_AGENT, accept: ACCEPT },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      xml = await response.text();
    } catch (err) {
      const reason = err instanceof Error && err.name === "AbortError" ? `请求超时（${timeoutMs}ms）` : errorText(err);
      throw new Error(reason);
    } finally {
      clearTimeout(timer);
    }

    // An empty body is a soft failure, not an empty feed: rss-parser would report
    // "Unable to parse XML", which reads like a broken feed rather than a broken
    // endpoint, and the admin-facing message is built from this reason.
    if (!xml.trim()) throw new Error("响应是空的");

    const feed = await parser.parseString(xml);
    const items: FeedItem[] = (Array.isArray(feed.items) ? feed.items : []).map((item) => ({
      // Atom keeps the stable identity in `id`, RSS in `guid`. Normalised here so
      // the watermark logic only ever has to know about one field.
      guid: text(item.guid) || text(item.id),
      link: text(item.link),
      title: text(item.title),
      isoDate: text(item.isoDate) || text(item.pubDate),
    }));
    return { title: text(feed.title), items };
  };
}

/** Convenience for the Node entry: `pollFeeds(rt, nodeRssDeps())`. */
export function nodeRssDeps(options: NodeFeedParserOptions = {}): { parse: FeedParser } {
  return { parse: nodeFeedParser(options) };
}
