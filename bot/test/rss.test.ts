/**
 * `/rss`: the watermark, the failure budget, the SSRF guard and the OPML export.
 *
 * The parser is injected everywhere (`deps.parse`), which is what makes this
 * testable offline — but the *fixtures are real XML and go through the real
 * `rss-parser`* via `nodeFeedParser({ fetchImpl })`. A hand-written fake that
 * returned `{items: [...]}` would prove the watermark logic and prove nothing
 * about what happens when a feed is malformed, empty, or not a feed at all.
 *
 * The three fixtures that matter are the ones a naive implementation gets wrong:
 * `empty.xml` must NOT count as a failure, `malformed.xml` must count as one, and
 * `notrss.xml` (the document the brief called "empty") is a third thing entirely —
 * it parses as XML but rss-parser rejects it as an unrecognised feed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  MAX_FEED_FAILURES,
  MAX_FEEDS_PER_CHAT,
  MAX_ITEMS_PER_POLL,
  RSS_NEEDS_NODE,
  buildOpml,
  checkFeedUrl,
  chunkForTelegram,
  cmdRssExport,
  cmdSub,
  cmdSubList,
  cmdUnsub,
  cmdUnsubThis,
  freshItems,
  itemKey,
  pollFeeds,
  privateHostReason,
  rssAvailable,
  sendRssExport,
  xmlEscape,
  type FeedItem,
  type FeedParser,
} from "../src/rss.ts";
import { nodeFeedParser } from "../src/rss.node.ts";
import { rssFeedAdd, rssFeedList, rssFeedMark } from "../src/db/repo.ts";
import { GROUP, makeRuntime, type Harness } from "./harness.ts";
import type { TgChat } from "../src/types.ts";

const FIX = join(import.meta.dirname, "fixtures", "rss");
const fixture = (name: string) => readFileSync(join(FIX, `${name}.xml`), "utf8");

const OTHER_CHAT: TgChat = { id: -2002, type: "supergroup", title: "另一个群" };

/** The real adapter over a stubbed transport: fixture in, FeedLike out. */
const parserFrom = (body: () => string, status = 200): FeedParser =>
  nodeFeedParser({ fetchImpl: async () => new Response(status === 200 ? body() : "boom", { status }) });

/**
 * A runtime that looks self-hosted.
 *
 * `rssParse` is the capability `/sub` checks, so injecting it is how a test says
 * "this deployment can actually poll" — and leaving it unset is how the Worker
 * cases are written.
 */
async function selfHosted(): Promise<Harness> {
  const h = await makeRuntime();
  h.rt.rssParse = async () => ({ items: [] });
  return h;
}

const texts = (h: Harness, chatId: number): string[] =>
  h.fake
    .all("sendMessage")
    .filter((call) => call.body.chat_id === chatId)
    .map((call) => String(call.body.text ?? ""));

// ---------------------------------------------------------------------------
// Worker vs self-hosted
// ---------------------------------------------------------------------------

test("a Worker-shaped runtime reports RSS as unavailable and /sub says so", async () => {
  const h = await makeRuntime();
  assert.equal(rssAvailable(h.rt), false, "no parseDownloader means no polling capability");

  const answer = await cmdSub(h.rt, GROUP.id, "https://example.com/feed.xml");
  assert.equal(answer, RSS_NEEDS_NODE);

  const list = await cmdSubList(h.rt, GROUP.id);
  assert.match(list, /还没有 RSS 订阅/);
  assert.match(list, /自托管/, "the emptiness is explained, not just reported");
});

test("a self-hosted runtime reports RSS as available", async () => {
  const h = await selfHosted();
  assert.equal(rssAvailable(h.rt), true);
});

test("a deployment with yt-dlp but no feed parser is still not RSS-capable", async () => {
  const h = await makeRuntime();
  // `/parse` works, RSS does not. The two capabilities are separate injections,
  // and answering "can we poll feeds" with the yt-dlp field would accept
  // subscriptions that then never deliver anything.
  h.rt.parseDownloader = async () => ({ ok: false, error: "只测能力判定" });
  assert.equal(rssAvailable(h.rt), false);
  assert.equal(await cmdSub(h.rt, GROUP.id, "https://example.com/feed.xml"), RSS_NEEDS_NODE);
});

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

test("loopback, private, link-local and non-http URLs are refused with a reason", () => {
  const refused = [
    "http://127.0.0.1/x",
    "http://127.0.0.2:8080/feed",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:8080/",
    "http://LOCALHOST/feed",
    "http://10.0.0.5/x",
    "http://192.168.1.1/feed.xml",
    "http://172.16.0.1/feed",
    "http://172.31.255.254/feed",
    "http://100.64.1.1/feed",
    "http://0.0.0.0/feed",
    "http://[::1]/feed",
    "http://[fe80::1]/feed",
    "http://[fd00::1]/feed",
    "http://[::ffff:127.0.0.1]/feed",
    "http://nas.local/feed",
    "http://intranet/feed",
    "http://2130706433/feed",
    "http://0x7f.0.0.1/feed",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ftp://example.com/feed",
    "https://user:pass@example.com/feed",
    "not a url",
    "",
  ];
  for (const input of refused) {
    const result = checkFeedUrl(input);
    assert.equal(result.ok, false, `${input} must be refused`);
    assert.ok(result.ok === false && result.error.length > 0, `${input} must explain why`);
  }
});

test("a public https URL is accepted and normalised for dedupe", () => {
  const plain = checkFeedUrl("https://example.com/feed.xml");
  assert.equal(plain.ok, true);
  assert.equal(plain.ok === true ? plain.url : "", "https://example.com/feed.xml");

  // Same feed written differently has to collide, or the same subscription is
  // stored twice and both copies deliver.
  const noisy = checkFeedUrl("  HTTPS://Example.COM/feed.xml#top  ");
  assert.equal(noisy.ok, true);
  assert.equal(noisy.ok === true ? noisy.url : "", "https://example.com/feed.xml");

  assert.equal(checkFeedUrl("http://example.com/rss").ok, true, "plain http is allowed");
  assert.equal(privateHostReason("example.com"), "");
  assert.match(privateHostReason("127.0.0.1"), /127\.0\.0\.0\/8/);
  assert.match(privateHostReason("169.254.169.254"), /元数据/);
});

// ---------------------------------------------------------------------------
// Watermark
// ---------------------------------------------------------------------------

test("the item key prefers guid, then link, then date+title", () => {
  assert.equal(itemKey({ guid: "g1", link: "https://e/1" }), "g1");
  assert.equal(itemKey({ link: "https://e/1" }), "https://e/1");
  assert.equal(itemKey({ isoDate: "2025-01-01", title: "标题" }), "2025-01-01|标题");
  assert.equal(itemKey({}), "", "nothing identifying means no stable key");
});

test("only items newer than the watermark are fresh, and they arrive oldest first", () => {
  const items: FeedItem[] = [{ guid: "3" }, { guid: "2" }, { guid: "1" }];
  const { fresh, watermark } = freshItems(items, "2");
  assert.deepEqual(
    fresh.map((item) => item.guid),
    ["3"],
  );
  assert.equal(watermark, "3");
});

test("a cold start delivers the newest batch only, not the whole archive", () => {
  const items: FeedItem[] = Array.from({ length: 25 }, (_, index) => ({ guid: `g${24 - index}` }));
  const { fresh, watermark } = freshItems(items, "");
  assert.equal(fresh.length, MAX_ITEMS_PER_POLL);
  assert.equal(watermark, "g24", "the watermark is the newest item, not the last one sent");
  assert.equal(fresh[0]?.guid, "g15", "the batch is handed over oldest first");
});

test("an item with no identifier at all is skipped instead of repeating forever", () => {
  const { fresh, watermark } = freshItems([{ title: "" }, { guid: "x" }], "");
  assert.deepEqual(
    fresh.map((item) => item.guid),
    ["x"],
  );
  assert.equal(watermark, "x");
});

test("first poll delivers every item of a three-item feed, the second delivers none", async () => {
  const h = await selfHosted();
  await cmdSub(h.rt, GROUP.id, "https://example.com/feed.xml");
  const deps = { parse: parserFrom(() => fixture("normal")) };

  const first = await pollFeeds(h.rt, deps);
  assert.equal(first.checked, 1);
  assert.equal(first.delivered, 3);
  assert.equal(first.failed, 0);
  assert.equal(h.fake.count("sendMessage"), 3);

  const sent = texts(h, GROUP.id);
  assert.match(sent[0] ?? "", /第一条：最旧的/, "oldest first, so the group reads in order");
  assert.match(sent[2] ?? "", /第三条：最新的/);
  assert.match(sent[1] ?? "", /https:\/\/example\.com\/posts\/2/);
  assert.equal(h.fake.all("sendMessage")[0]?.body.parse_mode, "HTML");

  const [row] = await rssFeedList(h.rt.db, GROUP.id);
  assert.equal(row?.lastKey, "post-3");
  assert.equal(row?.sent, 3);
  assert.equal(row?.title, "示例源");
  assert.ok((row?.lastSeenAt ?? 0) > 0);

  const second = await pollFeeds(h.rt, deps);
  assert.equal(second.delivered, 0);
  assert.equal(h.fake.count("sendMessage"), 3, "the watermark suppressed a re-delivery");
});

test("a new item after the watermark is delivered alone", async () => {
  const h = await selfHosted();
  await cmdSub(h.rt, GROUP.id, "https://example.com/feed.xml");
  await pollFeeds(h.rt, { parse: parserFrom(() => fixture("normal")) });
  h.fake.reset();

  const fourItem = fixture("normal").replace(
    "<item>",
    `<item><title>第四条：刚发的</title><link>https://example.com/posts/4</link><guid>post-4</guid></item><item>`,
  );
  const result = await pollFeeds(h.rt, { parse: parserFrom(() => fourItem) });

  assert.equal(result.delivered, 1);
  assert.match(texts(h, GROUP.id)[0] ?? "", /第四条：刚发的/);
  const [row] = await rssFeedList(h.rt.db, GROUP.id);
  assert.equal(row?.lastKey, "post-4");
  assert.equal(row?.sent, 4);
});

// ---------------------------------------------------------------------------
// Per-chat isolation
// ---------------------------------------------------------------------------

test("two chats on the same URL keep independent watermarks", async () => {
  const h = await selfHosted();
  const url = "https://example.com/feed.xml";
  await cmdSub(h.rt, GROUP.id, url);
  const deps = { parse: parserFrom(() => fixture("normal")) };

  // Chat A learns the feed first.
  await pollFeeds(h.rt, deps);
  assert.equal(texts(h, GROUP.id).length, 3);
  h.fake.reset();

  // Chat B subscribes afterwards: it is cold, A is not. A shared watermark would
  // deliver nothing here.
  await rssFeedAdd(h.rt.db, { chatId: OTHER_CHAT.id, url, at: h.now() });
  const second = await pollFeeds(h.rt, deps);

  assert.equal(second.delivered, 3);
  assert.equal(texts(h, OTHER_CHAT.id).length, 3, "the second chat got the backlog");
  assert.equal(texts(h, GROUP.id).length, 0, "the first chat was not re-sent anything");

  const [a] = await rssFeedList(h.rt.db, GROUP.id);
  const [b] = await rssFeedList(h.rt.db, OTHER_CHAT.id);
  assert.equal(a?.sent, 3);
  assert.equal(b?.sent, 3);
  assert.equal(a?.lastKey, "post-3");
  assert.equal(b?.lastKey, "post-3");
  assert.notEqual(a?.id, b?.id, "two rows, two ids");
});

test("a feed that fails for one chat is not removed for another chat", async () => {
  const h = await selfHosted();
  await rssFeedAdd(h.rt.db, { chatId: GROUP.id, url: "https://broken.example/feed", at: h.now() });
  await rssFeedAdd(h.rt.db, { chatId: OTHER_CHAT.id, url: "https://example.com/feed.xml", at: h.now() });

  const both: FeedParser = async (url) =>
    url.includes("broken") ? Promise.reject(new Error("HTTP 500")) : parserFrom(() => fixture("normal"))(url);

  for (let tick = 0; tick < MAX_FEED_FAILURES; tick++) await pollFeeds(h.rt, { parse: both });

  assert.equal((await rssFeedList(h.rt.db, GROUP.id)).length, 0, "the dead feed was retired");
  const [healthy] = await rssFeedList(h.rt.db, OTHER_CHAT.id);
  assert.equal(healthy?.failures, 0, "the healthy subscription of the other chat is untouched");
  assert.equal(healthy?.sent, 3);
});

// ---------------------------------------------------------------------------
// Failure budget
// ---------------------------------------------------------------------------

test("five consecutive failures remove the feed, alert the chat, and stop polling it", async () => {
  const h = await selfHosted();
  const url = "https://example.com/feed.xml";
  await cmdSub(h.rt, GROUP.id, url);

  let calls = 0;
  const dead: FeedParser = async (feedUrl) => {
    calls += 1;
    return parserFrom(() => "", 500)(feedUrl);
  };

  for (let tick = 1; tick <= MAX_FEED_FAILURES; tick++) {
    const result = await pollFeeds(h.rt, { parse: dead });
    assert.equal(result.failed, 1, `tick ${tick} is a failure`);
    assert.equal(result.removed, tick === MAX_FEED_FAILURES ? 1 : 0);
    if (tick < MAX_FEED_FAILURES) {
      const [row] = await rssFeedList(h.rt.db, GROUP.id);
      assert.equal(row?.failures, tick, "the counter is consecutive");
      assert.equal(row?.lastKey, "", "a failed poll never advances the watermark");
    }
  }

  assert.equal(calls, MAX_FEED_FAILURES);
  assert.equal((await rssFeedList(h.rt.db, GROUP.id)).length, 0, "auto-unsubscribe deleted the row");

  const alerts = texts(h, GROUP.id);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0] ?? "", /RSS 订阅已自动移除/);
  assert.match(alerts[0] ?? "", /https:\/\/example\.com\/feed\.xml/, "the URL is named: the row is gone");
  assert.match(alerts[0] ?? "", /连续 5 次/);

  const after = await pollFeeds(h.rt, { parse: dead });
  assert.equal(after.checked, 0, "there is nothing left to poll");
  assert.equal(calls, MAX_FEED_FAILURES, "the sixth tick does not even call the parser");
});

test("a malformed document is failure one, reported as a string, and the feed stays", async () => {
  const h = await selfHosted();
  await cmdSub(h.rt, GROUP.id, "https://example.com/feed.xml");

  const result = await pollFeeds(h.rt, { parse: parserFrom(() => fixture("malformed")) });

  assert.equal(result.failed, 1);
  assert.equal(result.removed, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(typeof result.errors[0], "string");
  assert.match(String(result.errors[0]), /抓取失败/);

  const rows = await rssFeedList(h.rt.db, GROUP.id);
  assert.equal(rows.length, 1, "one bad parse is not five");
  assert.equal(rows[0]?.failures, 1);
  assert.match(String(rows[0]?.lastError), /Unexpected close tag|抓取失败/);
  assert.equal(texts(h, GROUP.id).length, 0, "nothing was delivered");
});

test("an empty feed is a success: no deliveries, no failures", async () => {
  const h = await selfHosted();
  await cmdSub(h.rt, GROUP.id, "https://example.com/empty.xml");

  const result = await pollFeeds(h.rt, { parse: parserFrom(() => fixture("empty")) });

  assert.equal(result.delivered, 0);
  assert.equal(result.failed, 0, "nothing published yet is not broken");
  assert.deepEqual(result.errors, []);

  const [row] = await rssFeedList(h.rt.db, GROUP.id);
  assert.equal(row?.failures, 0);
  assert.equal(row?.lastKey, "");
  assert.equal(row?.title, "空源", "the title is learned even from an empty feed");
  assert.ok((row?.lastSeenAt ?? 0) > 0, "the tick is recorded");
});

test("a document that is XML but not a feed is a failure, unlike an empty feed", async () => {
  const h = await selfHosted();
  await cmdSub(h.rt, GROUP.id, "https://example.com/feed.xml");

  const result = await pollFeeds(h.rt, { parse: parserFrom(() => fixture("notrss")) });

  assert.equal(result.failed, 1, "<rss><channel></channel></rss> is not a recognised feed");
  assert.match(String(result.errors[0]), /not recognized|抓取失败/);
  const [row] = await rssFeedList(h.rt.db, GROUP.id);
  assert.equal(row?.failures, 1);
});

test("an HTTP error from the feed is a failure, not an empty feed", async () => {
  const h = await selfHosted();
  await cmdSub(h.rt, GROUP.id, "https://example.com/feed.xml");

  const result = await pollFeeds(h.rt, { parse: parserFrom(() => "", 500) });
  assert.equal(result.failed, 1);
  assert.match(String(result.errors[0]), /HTTP 500/);
});

test("a feed the bot cannot post to keeps its watermark and counts a failure", async () => {
  const h = await selfHosted();
  await cmdSub(h.rt, GROUP.id, "https://example.com/feed.xml");
  h.fake.on("sendMessage", () => ({ ok: false, description: "Forbidden: bot was kicked", error_code: 403 }));

  const result = await pollFeeds(h.rt, { parse: parserFrom(() => fixture("normal")) });

  assert.equal(result.delivered, 0);
  assert.equal(result.failed, 1);
  const [row] = await rssFeedList(h.rt.db, GROUP.id);
  assert.equal(row?.failures, 1);
  assert.equal(row?.lastKey, "", "a delivery that never happened must not advance the marker");
});

test("a giant feed delivers one bounded batch and does not throw", async () => {
  const h = await selfHosted();
  await cmdSub(h.rt, GROUP.id, "https://example.com/giant.xml");

  const items = Array.from(
    { length: 5000 },
    (_, index) => `<item><title>条目 ${index}</title><link>https://example.com/p/${index}</link><guid>g-${index}</guid></item>`,
  ).join("");
  const giant = `<?xml version="1.0"?><rss version="2.0"><channel><title>巨型源</title>${items}</channel></rss>`;

  const result = await pollFeeds(h.rt, { parse: parserFrom(() => giant) });

  assert.equal(result.failed, 0);
  assert.equal(result.delivered, MAX_ITEMS_PER_POLL, "5000 items must not become 5000 messages");
  const [row] = await rssFeedList(h.rt.db, GROUP.id);
  assert.equal(row?.lastKey, "g-0", "the watermark is the newest item in the document");
  assert.equal(row?.sent, MAX_ITEMS_PER_POLL);
});

test("a poller with no parser reports it instead of throwing", async () => {
  const h = await selfHosted();
  const result = await pollFeeds(h.rt, undefined as unknown as { parse: FeedParser });
  assert.equal(result.checked, 0);
  assert.match(String(result.errors[0]), /解析器/);
});

// ---------------------------------------------------------------------------
// Subscriptions by command
// ---------------------------------------------------------------------------

test("re-subscribing the same feed is refused instead of duplicated", async () => {
  const h = await selfHosted();
  assert.match(await cmdSub(h.rt, GROUP.id, "https://example.com/feed.xml"), /已订阅 #1/);
  const again = await cmdSub(h.rt, GROUP.id, "https://example.com/feed.xml");
  assert.match(again, /已经订阅过 #1/);
  // The same feed written differently must collide too.
  assert.match(await cmdSub(h.rt, GROUP.id, "HTTPS://Example.com/feed.xml#x"), /已经订阅过/);
  assert.equal((await rssFeedList(h.rt.db, GROUP.id)).length, 1);
});

test("the per-chat cap is enforced and the refusal names the limit", async () => {
  const h = await selfHosted();
  for (let index = 0; index < MAX_FEEDS_PER_CHAT; index++) {
    const answer = await cmdSub(h.rt, GROUP.id, `https://example.com/feed/${index}.xml`);
    assert.match(answer, /已订阅/, `subscription ${index} must be accepted`);
  }
  const refused = await cmdSub(h.rt, GROUP.id, "https://example.com/feed/one-too-many.xml");
  assert.match(refused, new RegExp(String(MAX_FEEDS_PER_CHAT)));
  assert.match(refused, /最多/);
  assert.equal((await rssFeedList(h.rt.db, GROUP.id)).length, MAX_FEEDS_PER_CHAT);
});

test("the cap is per chat, not global", async () => {
  const h = await selfHosted();
  for (let index = 0; index < MAX_FEEDS_PER_CHAT; index++) {
    await cmdSub(h.rt, GROUP.id, `https://example.com/feed/${index}.xml`);
  }
  assert.match(await cmdSub(h.rt, OTHER_CHAT.id, "https://example.com/other.xml"), /已订阅/);
});

test("/sub list shows ids, titles and last-seen state", async () => {
  const h = await selfHosted();
  await cmdSub(h.rt, GROUP.id, "https://example.com/feed.xml");
  await pollFeeds(h.rt, { parse: parserFrom(() => fixture("normal")) });

  const list = await cmdSubList(h.rt, GROUP.id);
  assert.match(list, new RegExp(`#1 示例源`));
  assert.match(list, /已推送 3/);
  assert.match(list, /刚刚/);
  assert.match(list, /1\/20/);
});

test("a feed with failures says so in the list", async () => {
  const h = await selfHosted();
  await cmdSub(h.rt, GROUP.id, "https://example.com/feed.xml");
  await pollFeeds(h.rt, { parse: parserFrom(() => "", 503) });

  const list = await cmdSubList(h.rt, GROUP.id);
  assert.match(list, /失败 1\/5/);
  assert.match(list, /HTTP 503/);
});

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

test("/unsub removes by id and by URL, and only within this chat", async () => {
  const h = await selfHosted();
  await cmdSub(h.rt, GROUP.id, "https://example.com/a.xml");
  await cmdSub(h.rt, GROUP.id, "https://example.com/b.xml");

  assert.match(await cmdUnsub(h.rt, OTHER_CHAT.id, "1"), /本群没有 #1/);
  assert.equal((await rssFeedList(h.rt.db, GROUP.id)).length, 2, "chat isolation on delete");

  assert.match(await cmdUnsub(h.rt, GROUP.id, "1"), /已移除 #1/);
  assert.equal((await rssFeedList(h.rt.db, GROUP.id)).length, 1);

  assert.match(await cmdUnsub(h.rt, GROUP.id, "https://example.com/b.xml"), /已移除/);
  assert.equal((await rssFeedList(h.rt.db, GROUP.id)).length, 0);

  assert.match(await cmdUnsub(h.rt, GROUP.id, "5"), /本群没有 #5/);
  assert.match(await cmdUnsub(h.rt, GROUP.id, "https://example.com/never.xml"), /没有订阅/);
  assert.match(await cmdUnsub(h.rt, GROUP.id, ""), /用法/);
});

test("/unsubthis removes the feed linked in the replied-to message", async () => {
  const h = await selfHosted();
  await cmdSub(h.rt, GROUP.id, "https://example.com/feed.xml");
  await cmdSub(h.rt, GROUP.id, "https://example.com/other.xml");

  const removed = await cmdUnsubThis(h.rt, GROUP.id, {
    text: "看这个源 https://example.com/feed.xml 不错",
  });
  assert.match(removed, /已移除/);
  assert.match(removed, /example\.com\/feed\.xml/);

  const left = await rssFeedList(h.rt.db, GROUP.id);
  assert.equal(left.length, 1);
  assert.equal(left[0]?.url, "https://example.com/other.xml");
});

test("/unsubthis reads a link that only exists in an entity", async () => {
  const h = await selfHosted();
  await cmdSub(h.rt, GROUP.id, "https://example.com/feed.xml");

  const removed = await cmdUnsubThis(h.rt, GROUP.id, {
    text: "点这里",
    entities: [{ type: "text_link", url: "https://example.com/feed.xml" }],
  });
  assert.match(removed, /已移除/);
  assert.equal((await rssFeedList(h.rt.db, GROUP.id)).length, 0);
});

test("/unsubthis explains the two ways it can have nothing to do", async () => {
  const h = await selfHosted();
  assert.match(await cmdUnsubThis(h.rt, GROUP.id, undefined), /先回复/);
  assert.match(await cmdUnsubThis(h.rt, GROUP.id, { text: "没有链接" }), /没有链接/);
  assert.match(await cmdUnsubThis(h.rt, GROUP.id, { text: "https://elsewhere.example/x" }), /都不在本群订阅里/);
});

// ---------------------------------------------------------------------------
// OPML
// ---------------------------------------------------------------------------

/**
 * A structural well-formedness check, not a full XML parser.
 *
 * Deliberately no third-party parser: `xml2js` is only present as a transitive
 * dependency of rss-parser and importing it here would create a dependency the
 * project does not declare. What this does check is exactly what an exporter gets
 * wrong: unescaped `&`/`<`, unbalanced or mis-nested tags, unquoted attributes,
 * text outside the root, and more than one root element.
 */
function assertWellFormedXml(xml: string): void {
  const stack: string[] = [];
  let roots = 0;
  let index = 0;
  while (index < xml.length) {
    const char = xml[index];
    if (char === "<") {
      if (xml.startsWith("<?", index)) {
        const end = xml.indexOf("?>", index);
        assert.ok(end > 0, "unterminated declaration");
        index = end + 2;
        continue;
      }
      if (xml.startsWith("<!--", index)) {
        const end = xml.indexOf("-->", index);
        assert.ok(end > 0, "unterminated comment");
        index = end + 3;
        continue;
      }
      const end = xml.indexOf(">", index);
      assert.ok(end > 0, "unterminated tag");
      const body = xml.slice(index + 1, end);
      if (body.startsWith("/")) {
        const name = body.slice(1).trim();
        assert.equal(stack.pop(), name, `mis-nested </${name}>`);
      } else {
        const selfClosing = body.endsWith("/");
        const inner = selfClosing ? body.slice(0, -1) : body;
        const nameMatch = /^([A-Za-z_:][\w:.-]*)/.exec(inner);
        assert.ok(nameMatch, `bad tag name in <${body}>`);
        const name = nameMatch ? nameMatch[1] : "";
        const attrs = inner.slice(name.length);
        assert.equal(attrs.replace(/\s+[A-Za-z_:][\w:.-]*="[^"]*"/g, "").trim(), "", `bad attributes in <${name}>`);
        if (stack.length === 0) roots += 1;
        if (!selfClosing) stack.push(name);
      }
      index = end + 1;
      continue;
    }
    if (char === "&") {
      const entity = /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/.exec(xml.slice(index));
      assert.ok(entity, `raw or unknown entity at ${index}: ${xml.slice(index, index + 12)}`);
      index += entity ? entity[0].length : 1;
      continue;
    }
    if (stack.length === 0 && char !== undefined && char.trim() !== "") {
      assert.fail(`text outside the root element: ${JSON.stringify(xml.slice(index, index + 12))}`);
    }
    index += 1;
  }
  assert.equal(stack.length, 0, "unclosed tags remain");
  assert.equal(roots, 1, "exactly one root element");
}

test("the XML checker itself rejects the mistakes an exporter makes", () => {
  assert.throws(() => assertWellFormedXml("<a><b></a></b>"), /mis-nested/);
  assert.throws(() => assertWellFormedXml("<a>"), /unclosed/);
  assert.throws(() => assertWellFormedXml("<a>Tom & Jerry</a>"), /entity/);
  assert.throws(() => assertWellFormedXml('<a b=c/>'), /attributes/);
  assert.throws(() => assertWellFormedXml("<a/><b/>"), /one root/);
  assert.throws(() => assertWellFormedXml("<a/>trailing"), /outside the root/);
  // and a correct document passes
  assert.doesNotThrow(() => assertWellFormedXml(`<?xml version="1.0"?><a b="1"><c>t &amp; u</c><d/></a>`));
});

test("xmlEscape escapes the five entities and drops characters XML cannot carry", () => {
  assert.equal(xmlEscape(`a & b < c > d " e ' f`), "a &amp; b &lt; c &gt; d &quot; e &apos; f");
  assert.equal(xmlEscape("a\u0001b\u0008c"), "abc", "C0 controls are removed, not escaped");
  assert.equal(xmlEscape(undefined), "");
});

test("the OPML export is well-formed and carries every feed URL exactly once", async () => {
  const h = await selfHosted();
  const urls = ["https://example.com/a.xml", "https://example.com/b.xml", "https://other.example/feed"];
  for (const url of urls) await cmdSub(h.rt, GROUP.id, url);

  const opml = await cmdRssExport(h.rt, GROUP.id, "测试群");
  assertWellFormedXml(opml);

  assert.match(opml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(opml, /<opml version="2\.0">/);
  assert.match(opml, /<outline type="rss"/);
  for (const url of urls) {
    assert.equal(opml.split(url).length - 1, 1, `${url} appears exactly once`);
  }
  assert.equal(opml.split("<outline ").length - 1, urls.length);
});

test("a title with markup characters cannot break the OPML", async () => {
  const h = await selfHosted();
  await cmdSub(h.rt, GROUP.id, "https://example.com/feed.xml");
  const [row] = await rssFeedList(h.rt.db, GROUP.id);
  await rssFeedMark(h.rt.db, row?.id ?? 0, { title: `A & B <channel> "q" 'a'` });

  const opml = await cmdRssExport(h.rt, GROUP.id);
  assertWellFormedXml(opml);
  assert.match(opml, /A &amp; B &lt;channel&gt; &quot;q&quot; &apos;a&apos;/);
  assert.doesNotMatch(opml, /<channel>/);
});

test("the OPML export is per chat and explains an empty one", async () => {
  const h = await selfHosted();
  assert.match(await cmdRssExport(h.rt, GROUP.id), /还没有 RSS 订阅/);

  await cmdSub(h.rt, GROUP.id, "https://example.com/a.xml");
  const opml = await cmdRssExport(h.rt, OTHER_CHAT.id);
  assert.match(opml, /还没有 RSS 订阅/, "one chat's feeds never leak into another's export");
});

test("buildOpml works for an empty list and stays well-formed", () => {
  const opml = buildOpml([], { title: "空", dateCreated: 0 });
  assertWellFormedXml(opml);
  assert.match(opml, /<body>\n {2}<\/body>/);
});

test("a long export is chunked under the Telegram limit and reassembles exactly", () => {
  const feeds = Array.from({ length: 200 }, (_, index) => ({
    title: `第 ${index} 个源`,
    url: `https://example.com/feed/${index}.xml?a=1&b=2`,
  }));
  const opml = buildOpml(feeds);
  const chunks = chunkForTelegram(opml, 1_000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 1_000, "every chunk fits");
  assert.equal(chunks.join(""), opml, "no character lost at a boundary");
  assert.match(chunks[0] ?? "", /^<\?xml/);
});

test("re-adding a feed keeps its watermark, so it never replays the archive", async () => {
  const h = await selfHosted();
  const url = "https://example.com/feed.xml";
  await cmdSub(h.rt, GROUP.id, url);
  await pollFeeds(h.rt, { parse: parserFrom(() => fixture("normal")) });
  await pollFeeds(h.rt, { parse: parserFrom(() => "", 500) }); // one failure on the row
  h.fake.reset();

  const [before] = await rssFeedList(h.rt.db, GROUP.id);
  await rssFeedAdd(h.rt.db, { chatId: GROUP.id, url, at: h.now() });
  const [after] = await rssFeedList(h.rt.db, GROUP.id);

  assert.equal(after?.id, before?.id, "the duplicate collapsed onto the same row");
  assert.equal(after?.lastKey, before?.lastKey);
  assert.equal(after?.sent, before?.sent);
  assert.equal(after?.failures, before?.failures, "a dead feed is not quietly revived by a duplicate");

  const again = await pollFeeds(h.rt, { parse: parserFrom(() => fixture("normal")) });
  assert.equal(again.delivered, 0, "the whole archive was not replayed into the group");
  assert.equal(h.fake.all("sendMessage").filter((call) => /第一条：最旧的/.test(String(call.body.text))).length, 0);
});

test("the export helper sends the document in pieces and loses nothing", async () => {
  const h = await selfHosted();
  // Twenty feeds with maximum-length URLs: the size that makes a single
  // sendMessage a Telegram 400.
  for (let index = 0; index < MAX_FEEDS_PER_CHAT; index++) {
    await rssFeedAdd(h.rt.db, {
      chatId: GROUP.id,
      url: `https://example.com/feed-${index}/${"a".repeat(380)}.xml`,
      at: h.now(),
    });
  }

  const result = await sendRssExport(h.rt, GROUP.id, "测试群");

  assert.equal(result.ok, true);
  assert.ok(result.chunks > 1, "a 10 KB document cannot be one message");
  const parts = texts(h, GROUP.id);
  assert.equal(parts.length, result.chunks);
  const doc = await cmdRssExport(h.rt, GROUP.id, "测试群");
  assert.equal(parts.join(""), doc, "the pieces are the document, in order");
  assertWellFormedXml(doc);
});
