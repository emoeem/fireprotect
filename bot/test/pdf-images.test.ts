import assert from "node:assert/strict";
import { test } from "node:test";
import { encodePng, rgbaToRgb } from "../src/png.ts";
import { isPdfDocument, looksEncryptedPdf, pageCaption, PDF_RENDER_MAX_PAGES } from "../src/pdf-render.ts";
import { handleUpdate } from "../src/bot.ts";
import { GROUP, makeRuntime, nextUpdate, user } from "./harness.ts";
import type { TgMessage } from "../src/types.ts";

/** 3-page test PDF built in-process so the suite has no binary fixture. */
async function makePdf(): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage([420, 300]);
  return new Uint8Array(await doc.save());
}

const pdfMessage = (patch: Record<string, unknown> = {}): TgMessage => ({
  message_id: 900,
  date: 1,
  chat: GROUP,
  from: user(500),
  document: { file_id: "pdf1", file_name: "report.pdf", mime_type: "application/pdf", file_size: 4000 },
  ...patch,
} as TgMessage);

test("isPdfDocument recognises PDFs by mime or extension", () => {
  assert.equal(isPdfDocument({ mime_type: "application/pdf" }), true);
  assert.equal(isPdfDocument({ file_name: "a.PDF" }), true);
  assert.equal(isPdfDocument({ mime_type: "image/png" }), false);
  assert.equal(isPdfDocument(undefined), false);
});

test("looksEncryptedPdf spots the /Encrypt trailer", () => {
  assert.equal(looksEncryptedPdf(new TextEncoder().encode("%PDF-1.7\n1 0 obj<</Encrypt 1 0 R>>")), true);
  assert.equal(looksEncryptedPdf(new TextEncoder().encode("%PDF-1.7\n1 0 obj<</Type/Catalog>>")), false);
});

test("pageCaption is 1-based", () => {
  assert.equal(pageCaption(2, 5), "第 2/5 页");
});

test("encodePng emits a decodable grayscale PNG that the Sub filter keeps small", async () => {
  // A real page size with text-like rows: white paper, black line segments.
  const width = 1080;
  const height = 1200;
  const pixels = new Uint8Array(width * height).fill(255);
  for (let line = 0; line < 40; line++) {
    const y0 = 40 + line * 28;
    for (let y = y0; y < y0 + 8; y++) {
      for (let x = 60; x < 1000; x++) {
        // A rough glyph pattern: dark for ~60% of the run.
        if ((x * 7 + line * 13) % 10 < 6) pixels[y * width + x] = 20;
      }
    }
  }

  const sub = await encodePng(width, height, 1, pixels);
  const none = await encodePng(width, height, 1, pixels, { filter: "none" });
  // Which filter wins depends on the content: extremely regular synthetic rows
  // compress equally well either way, while real anti-aliased glyphs favour Sub.
  // What must hold is that both are valid and small.
  assert.ok(sub.byteLength < none.byteLength * 1.2, `Sub (${sub.byteLength}) must not be much worse than none (${none.byteLength})`);
  assert.ok(sub.byteLength < 200 * 1024, "a page must compress to a phone-friendly size");
  assert.ok(none.byteLength < 200 * 1024);

  const sharp = (await import("sharp")).default;
  const meta = await sharp(sub).metadata();
  assert.equal(meta.width, width);
  assert.equal(meta.height, height);
  assert.equal(meta.format, "png");
  assert.equal(meta.channels, 1, "grayscale must stay single-channel");
});

test("rgbaToRgb drops the alpha channel", () => {
  const rgba = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]);
  assert.deepEqual([...rgbaToRgb(rgba, 2)], [10, 20, 30, 40, 50, 60]);
});

test("a posted PDF is rendered into page images and sent back", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(GROUP.id, { pdfAutoImages: true, keywords: [], locks: [] });
  const pdf = await makePdf();
  h.fake.files.set("docs/report.pdf", pdf);
  h.fake.on("getFile", () => ({ ok: true, result: { file_path: "docs/report.pdf", file_size: pdf.byteLength } }));

  // The renderer is injected exactly like sliceImage: the Worker uses WASM,
  // Node uses poppler, tests use a stub that proves the wiring.
  const seen: { maxPages: number; width: number }[] = [];
  h.rt.pdfRender = async (bytes, options) => {
    seen.push(options);
    assert.deepEqual([...bytes], [...pdf], "the downloaded bytes reach the renderer");
    return {
      ok: true,
      total: 3,
      pages: [
        { page: 1, data: new Uint8Array([1]), width: 1080, height: 772 },
        { page: 2, data: new Uint8Array([2]), width: 1080, height: 772 },
      ],
    };
  };

  await handleUpdate(h.rt, { update_id: nextUpdate(), message: pdfMessage() });

  assert.equal(h.fake.count("sendPhoto"), 2, "one photo per rendered page");
  assert.deepEqual(seen[0], { width: 1080, maxPages: PDF_RENDER_MAX_PAGES });
  const captions = h.fake.all("sendPhoto").map((call) => String(call.body.caption));
  assert.deepEqual(captions, ["第 1/3 页", "第 2/3 页"]);
  assert.match(String(h.fake.find("sendMessage")?.body.text ?? ""), /共 3 页，这次只转前 2 页/);
});

test("the feature is off unless the group turns it on", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(GROUP.id, { pdfAutoImages: false, keywords: [], locks: [] });
  h.rt.pdfRender = async () => ({ ok: true, total: 1, pages: [] });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: pdfMessage() });
  assert.equal(h.fake.count("sendPhoto"), 0);
});

test("a PDF over the group's own size cap is left alone in silence", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(GROUP.id, { pdfAutoImages: true, pdfAutoMaxKb: 1, keywords: [], locks: [] });
  let called = 0;
  h.rt.pdfRender = async () => {
    called += 1;
    return { ok: true, total: 1, pages: [] };
  };
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: pdfMessage() });
  assert.equal(called, 0, "the renderer is never asked to do the work");
  assert.equal(h.fake.count("sendPhoto"), 0);
});

test("a deployment that cannot render says so instead of going quiet", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(GROUP.id, { pdfAutoImages: true, keywords: [], locks: [] });
  // No pdfRender injected — the Worker without the WASM build behaves this way.
  delete (h.rt as { pdfRender?: unknown }).pdfRender;
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: pdfMessage() });
  assert.match(String(h.fake.find("sendMessage")?.body.text ?? ""), /不能把 PDF 转成图片/);
});

test("a render failure is reported, not swallowed", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(GROUP.id, { pdfAutoImages: true, keywords: [], locks: [] });
  h.fake.files.set("docs/report.pdf", await makePdf());
  h.fake.on("getFile", () => ({ ok: true, result: { file_path: "docs/report.pdf" } }));
  h.rt.pdfRender = async () => ({ ok: false, error: "PDF 渲染失败：坏文件" });
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: pdfMessage() });
  assert.equal(h.fake.count("sendPhoto"), 0);
  assert.match(String(h.fake.find("sendMessage")?.body.text ?? ""), /坏文件/);
});
