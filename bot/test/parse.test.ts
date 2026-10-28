/**
 * `/parse`: site detection, the OpenGraph preview, and the delivery contract.
 *
 * The preview cases replay HTML recorded from the live sites (see
 * `test/fixtures/parse/manifest.json` for URLs and timestamps), so the suite is
 * offline and still parses real markup. Two of those recordings carry a finding
 * worth keeping: 抖音's `/discover` returns no OpenGraph tags at all, and
 * 小红书 redirects a cookieless client to its login wall. Both therefore degrade
 * to a link card in the Worker — which is exactly why the self-hosted build
 * exists.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { Previewer, parsePreview } from "../src/parse/preview.ts";
import { detectSite, extractUrls, firstSupported } from "../src/parse/sites.ts";
import { runParseJob } from "../src/parse/service.ts";
import { sliceLongImage } from "../src/parse/ytdlp.node.ts";
import { parseJobsRecent } from "../src/db/repo.ts";
import { handleMessage } from "../src/handlers/message.ts";
import { command, makeRuntime, user } from "./harness.ts";

const FIX = join(import.meta.dirname, "fixtures", "parse");
const fixture = (name: string) => readFileSync(join(FIX, `${name}.html`), "utf8");
const manifest = JSON.parse(readFileSync(join(FIX, "manifest.json"), "utf8")) as Record<string, { url: string; final: string }>;

/** Replay the recorded pages; anything else is offline by default. */
function replay(handler?: (url: string) => Response | null) {
  const calls: string[] = [];
  const fetchImpl = async (url: string): Promise<Response> => {
    calls.push(String(url));
    const custom = handler?.(String(url));
    if (custom) return custom;
    const name = Object.keys(manifest).find((key) => String(url).includes(new URL(manifest[key].url).hostname));
    if (!name) throw new Error(`offline: ${url}`);
    return new Response(fixture(name), { status: 200, headers: { "content-type": "text/html" } });
  };
  return { fetchImpl, calls };
}

test("the four supported sites are recognised by host", () => {
  assert.equal(detectSite("https://v.douyin.com/abcdef/"), "douyin");
  assert.equal(detectSite("https://www.xiaohongshu.com/explore/abc"), "xiaohongshu");
  assert.equal(detectSite("https://xhslink.com/a/abc"), "xiaohongshu");
  assert.equal(detectSite("https://x.com/telegram/status/1"), "twitter");
  assert.equal(detectSite("https://b23.tv/abc"), "bilibili");
  assert.equal(detectSite("https://example.com/a"), "");
  assert.equal(detectSite("not a url"), "");
});

test("a link hidden behind display text is still found", () => {
  const urls = extractUrls("点这里", [{ type: "text_link", url: "https://v.douyin.com/x/" }]);
  assert.deepEqual(urls, ["https://v.douyin.com/x/"]);
});

test("trailing punctuation is not part of the URL", () => {
  assert.deepEqual(extractUrls("看这个 https://b23.tv/abc。"), ["https://b23.tv/abc"]);
  assert.deepEqual(extractUrls("(https://b23.tv/abc),"), ["https://b23.tv/abc"]);
});

test("firstSupported picks the supported link and ignores the rest", () => {
  const found = firstSupported("前 https://example.com/x 后 https://b23.tv/abc", []);
  assert.equal(found?.site, "bilibili");
});

test("bilibili's real page yields title, cover and no bogus video", () => {
  const preview = parsePreview(fixture("bilibili"), manifest.bilibili.final);
  assert.ok(preview.ok);
  assert.match(preview.title, /爸爸去哪儿/);
  assert.equal(preview.images.length >= 1, true);
  assert.match(preview.images[0], /^https:\/\/i1\.hdslb\.com\//);
  // `og:video` is a text/html player page; sending that to sendVideo would fail.
  assert.equal(preview.video, "");
});

test("douyin's real page has no OpenGraph data, and that is not a crash", () => {
  const preview = parsePreview(fixture("douyin"), manifest.douyin.final);
  assert.ok(preview.ok);
  assert.equal(preview.images.length, 0);
  assert.equal(preview.title, "");
});

test("xiaohongshu's login wall still yields an absolute image URL", () => {
  const preview = parsePreview(fixture("xiaohongshu"), manifest.xiaohongshu.final);
  assert.ok(preview.ok);
  assert.equal(preview.images.length, 1);
  assert.match(preview.images[0], /^https:\/\/picasso-static\.xiaohongshu\.com\//, "protocol-relative URLs must be resolved");
});

test("x.com's real page yields the profile card", () => {
  const preview = parsePreview(fixture("twitter"), manifest.twitter.final);
  assert.ok(preview.ok);
  assert.match(preview.title, /Telegram/);
  assert.match(preview.images[0], /^https:\/\/pbs\.twimg\.com\//);
});

test("data: images and svg logos are dropped", () => {
  const html = `<meta property="og:image" content="data:image/png;base64,AAA"><meta property="og:image" content="/logo.svg">`;
  assert.deepEqual(parsePreview(html, "https://example.com/a").images, []);
});

test("the same page is fetched once, then served from cache", async () => {
  const { fetchImpl, calls } = replay();
  const previewer = new Previewer({ fetchImpl });
  const first = await previewer.fetch(manifest.bilibili.url);
  const second = await previewer.fetch(manifest.bilibili.url);
  assert.ok(first.ok && second.ok);
  assert.equal(calls.length, 1);
});

test("a 502 is reported as a failure, not as an empty preview", async () => {
  const previewer = new Previewer({ fetchImpl: async () => new Response("bad", { status: 502 }) });
  const result = await previewer.fetch("https://www.bilibili.com/video/BV1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /502/);
});

test("a timeout fails without throwing", async () => {
  const previewer = new Previewer({
    fetchImpl: async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    },
  });
  const result = await previewer.fetch("https://www.bilibili.com/video/BV2");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "请求超时");
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

test("the preview mode sends the cover by URL and a card", async () => {
  const { fetchImpl } = replay();
  const h = await makeRuntime({ fetchImpl, env: { ADMIN_IDS: "9001" } });
  await h.rt.saveConfig(-1001, { keywords: [] });
  await handleMessage(h.rt, command("/parse https://www.bilibili.com/video/BV1HYnh6CEJc", { from: user(500) }));

  const photos = h.fake.all("sendPhoto");
  assert.equal(photos.length, 1, "one cover, sent by URL");
  assert.match(String(photos[0].body.photo), /^https:\/\/i1\.hdslb\.com\//);
  assert.match(String(photos[0].body.caption), /爸爸去哪儿/);
  const card = h.fake.all("sendMessage").at(-1);
  assert.match(String(card?.body.text), /原链接/);

  const jobs = await parseJobsRecent(h.rt.db, -1001, 5);
  assert.equal(jobs[0].status, "done");
  assert.equal(jobs[0].mode, "preview");
});

test("an unsupported site is refused by name, not silently ignored", async () => {
  const h = await makeRuntime();
  await handleMessage(h.rt, command("/parse https://example.com/abc", { from: user(500) }));
  const text = String(h.fake.all("sendMessage").at(-1)?.body.text);
  assert.match(text, /不支持这个站点/);
  assert.deepEqual(await parseJobsRecent(h.rt.db, -1001, 5), [], "no job for a site we cannot handle");
});

test("no link at all explains the usage", async () => {
  const h = await makeRuntime();
  await handleMessage(h.rt, command("/parse 乱写", { from: user(500) }));
  assert.match(String(h.fake.all("sendMessage").at(-1)?.body.text), /用法/);
});

test("the hourly budget stops the fourth request in a one-per-hour chat", async () => {
  const { fetchImpl } = replay();
  const h = await makeRuntime({ fetchImpl });
  await h.rt.saveConfig(-1001, { parsePerHour: 1, keywords: [] });
  for (let index = 0; index < 2; index++) {
    await handleMessage(h.rt, command("/parse https://www.bilibili.com/video/BV1HYnh6CEJc", { from: user(500) }));
  }
  const texts = h.fake.all("sendMessage").map((call) => String(call.body.text));
  assert.ok(texts.some((text) => /次数已用完/.test(text)));
});

test("a parse failure never touches the original message", async () => {
  const h = await makeRuntime({ fetchImpl: async () => new Response("nope", { status: 500 }) });
  await handleMessage(h.rt, command("/parse https://b23.tv/abc", { from: user(500) }));
  assert.equal(h.fake.count("deleteMessage"), 0);
  assert.equal(h.fake.count("deleteMessages"), 0);
  assert.match(String(h.fake.all("sendMessage").at(-1)?.body.text), /解析失败|预览/);
});

test("the full mode uploads downloaded media in order with one caption", async () => {
  const h = await makeRuntime();
  const h2 = { ...h, rt: h.rt };
  // Inject a downloader after the fact: this is the self-hosted path.
  (h.rt as unknown as { parseDownloader: unknown }).parseDownloader = async () => ({
    ok: true,
    title: "一条视频",
    media: [
      { name: "cover.jpg", bytes: new Uint8Array([1, 2]), kind: "image" },
      { name: "video.mp4", bytes: new Uint8Array([3, 4]), kind: "video" },
    ],
  });
  await runParseJob(h2.rt, { id: 0, chatId: -1001, messageId: 5, url: "https://b23.tv/x", site: "bilibili" });
  const calls = h.fake.calls.filter((call) => ["sendPhoto", "sendVideo"].includes(call.method));
  assert.deepEqual(calls.map((call) => call.method), ["sendPhoto", "sendVideo"]);
  assert.equal(calls[0].file?.filename, "cover.jpg");
  assert.equal(calls[1].file?.filename, "video.mp4");
  assert.equal(calls[0].body.caption, "一条视频");
  assert.equal(calls[1].body.caption, undefined, "the title belongs on the first item only");
});

// ---------------------------------------------------------------------------
// Long screenshots
// ---------------------------------------------------------------------------

test("a long screenshot is sliced, a normal image is not", async () => {
  const tall = await sharp({ create: { width: 300, height: 3000, channels: 3, background: "#ffffff" } }).png().toBuffer();
  const slices = await sliceLongImage(new Uint8Array(tall), "cover-1.jpg");
  assert.ok(slices.length > 1, "3000×300 must be split");
  assert.match(slices[0].name, /cover-1-1of\d+\.jpg$/);

  const square = await sharp({ create: { width: 800, height: 800, channels: 3, background: "#ffffff" } }).png().toBuffer();
  const single = await sliceLongImage(new Uint8Array(square), "cover-2.jpg");
  assert.equal(single.length, 1);
  assert.equal(single[0].name, "cover-2.jpg");
});
