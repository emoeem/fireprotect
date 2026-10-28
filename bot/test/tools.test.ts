import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { MAX_PAGES, splitPdf } from "../src/tools/pdf.ts";
import { convertTimestamp } from "../src/tools/timestamp.ts";
import { parseTelegramLink, resolveTelegramLink } from "../src/tools/expand.ts";
import { handleUpdate } from "../src/bot.ts";
import { command, makeRuntime, message, nextUpdate, user } from "./harness.ts";

async function makePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  return doc.save();
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a PDF splits into one document per page", async () => {
  const pages = await splitPdf(await makePdf(3));
  assert.equal(pages.length, 3);
  assert.equal(pages[0]?.page, 1);
  assert.equal(pages[2]?.total, 3);
  const reloaded = await PDFDocument.load(pages[1]!.data);
  assert.equal(reloaded.getPageCount(), 1, "each output holds exactly one page");
});

test("the page cap stops a 500-page PDF from becoming 500 messages", async () => {
  const pages = await splitPdf(await makePdf(MAX_PAGES + 5));
  assert.equal(pages.length, MAX_PAGES);
  assert.equal(pages[0]?.total, MAX_PAGES + 5);
});

test("timestamps convert in both directions", () => {
  const fromUnix = convertTimestamp("1700000000", 480);
  assert.equal(fromUnix?.unix, 1_700_000_000);
  assert.equal(fromUnix?.iso, "2023-11-14T22:13:20.000Z");

  const fromMs = convertTimestamp("1700000000000", 480);
  assert.equal(fromMs?.unix, 1_700_000_000);

  const fromLocal = convertTimestamp("2026-10-28 18:00", 480);
  assert.equal(fromLocal?.iso, "2026-10-28T10:00:00.000Z");

  assert.equal(convertTimestamp("not a time", 480), null);
});

test("t.me links parse into channel and post", () => {
  assert.deepEqual(parseTelegramLink("https://t.me/news/123"), { channel: "news", post: 123 });
  assert.deepEqual(parseTelegramLink("@news"), null);
  assert.equal(parseTelegramLink("https://example.com/x"), null);
});

test("expand reads the embed page's OpenGraph tags", async () => {
  globalThis.fetch = (async () =>
    new Response(
      '<meta property="og:title" content="测试频道"><meta property="og:description" content="第一条 &amp; 摘要">',
      { status: 200 },
    )) as typeof fetch;
  const result = await resolveTelegramLink("https://t.me/news/1");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.info.title, "测试频道");
  assert.equal(result.ok && result.info.excerpt, "第一条 & 摘要");
});

test("/ts answers with every useful form", async () => {
  const h = await makeRuntime();
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: command("/ts 1700000000", { from: user(500) }) });
  const text = String(h.fake.find("sendMessage")?.body.text ?? "");
  assert.match(text, /Unix：1700000000/);
  assert.match(text, /2023-11-14T22:13:20/);
});

test("/splitpdf sends one file per page back to the group", async () => {
  const h = await makeRuntime();
  const bytes = await makePdf(2);
  h.fake.onFile("docs/a.pdf", bytes);

  const pdfMessage = message({
    chat: h.rt ? { id: -1001, type: "supergroup", title: "测试群" } : undefined,
    from: user(700),
    text: "",
    document: { file_id: "f1", file_name: "a.pdf", mime_type: "application/pdf", file_size: bytes.byteLength },
  });
  await handleUpdate(h.rt, {
    update_id: nextUpdate(),
    message: command("/splitpdf", { from: user(700), reply_to_message: pdfMessage }),
  });

  const uploads = h.fake.all("sendDocument");
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0]?.file?.filename, "page-1-of-2.pdf");
  assert.equal(uploads[1]?.file?.filename, "page-2-of-2.pdf");
});

test("/splitpdf refuses a file that is not a PDF", async () => {
  const h = await makeRuntime();
  const other = message({ from: user(701), text: "", document: { file_id: "f2", file_name: "a.docx", mime_type: "application/msword" } });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: command("/splitpdf", { from: user(701), reply_to_message: other }) });
  assert.match(String(h.fake.find("sendMessage")?.body.text ?? ""), /不是 PDF/);
});

test("/slice says which build supports it", async () => {
  const h = await makeRuntime();
  const photo = message({ from: user(702), text: "", photo: [{ file_id: "p1", width: 400, height: 9000 }] });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: command("/slice", { from: user(702), reply_to_message: photo }) });
  assert.match(String(h.fake.find("sendMessage")?.body.text ?? ""), /自托管版/);
});

test("/slice runs when the node-only slicer is injected", async () => {
  const h = await makeRuntime();
  h.rt.sliceImage = async () => ({
    slices: [
      { index: 1, data: new Uint8Array([1, 2, 3]), width: 400, height: 1800 },
      { index: 2, data: new Uint8Array([4, 5, 6]), width: 400, height: 1800 },
    ],
    total: 2,
    truncated: false,
  });
  h.fake.onFile("photos/p1.jpg", new Uint8Array([9, 9, 9]));
  const photo = message({ from: user(703), text: "", photo: [{ file_id: "p1", width: 400, height: 9000 }] });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: command("/slice", { from: user(703), reply_to_message: photo }) });
  assert.equal(h.fake.count("sendDocument"), 2);
});

test("the toolbox is rate limited per member", async () => {
  const h = await makeRuntime();
  for (let i = 0; i < 9; i++) {
    await handleUpdate(h.rt, { update_id: nextUpdate(), message: command("/ts 1700000000", { from: user(704) }) });
  }
  const texts = h.fake.all("sendMessage").map((call) => String(call.body.text));
  assert.match(texts.at(-1) ?? "", /太频繁/);
});
