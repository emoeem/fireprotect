/**
 * File-tool acceptance, driven by generated fixtures.
 *
 * Nothing here uses a checked-in sample: `make-fixtures.ts` builds every input
 * (including a real qpdf-encrypted PDF and a 24 MiB file) so the suite can be
 * re-run on a clean machine. Each case asserts the Bot API calls *and* the text
 * the group sees — a tool that fails silently looks like a tool that worked.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { describePdfError, looksEncrypted, pdfPageCount } from "../src/tools/pdf.ts";
import { sliceImage } from "../src/tools/slice.node.ts";
import { command, makeRuntime, message, nextUpdate, user } from "./harness.ts";
import type { TgMessage } from "../src/types.ts";

const dir = join(import.meta.dirname, "..", "scripts", "test-fixtures", "out");
if (!existsSync(join(dir, "pdf-50page.pdf"))) {
  execFileSync(process.execPath, ["--experimental-strip-types", join(import.meta.dirname, "..", "scripts", "test-fixtures", "make-fixtures.ts")], {
    stdio: "inherit",
  });
}

const bytesOf = (name: string) => new Uint8Array(readFileSync(join(dir, name)));
const sizeOf = (name: string) => statSync(join(dir, name)).size;

/** A document reply the tool can act on, backed by real bytes on the fake CDN. */
async function documentReply(name: string, options: { mime?: string; as?: string; reportSize?: number } = {}) {
  const bytes = bytesOf(name);
  const h = await makeRuntime();
  const filePath = `documents/${name}`;
  h.fake.onFile(filePath, bytes);
  const doc = {
    file_id: "f1",
    file_name: options.as ?? name,
    mime_type: options.mime ?? (/\.pdf$/.test(name) ? "application/pdf" : "application/octet-stream"),
    file_size: options.reportSize ?? bytes.byteLength,
  };
  return { h, bytes, doc, filePath };
}

function replyMsg(doc: Record<string, unknown>, from = user(801)): TgMessage {
  return message({ from, text: "", document: doc as never });
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

test("a real 50-page PDF splits into 20 files, in order, each with its position", async () => {
  const { h, doc } = await documentReply("pdf-50page.pdf");
  await h.rt.saveConfig(-1001, {});
  const target = replyMsg(doc);
  await handle(h, command("/splitpdf", { from: user(802), reply_to_message: target }));

  const sent = h.fake.all("sendDocument");
  assert.equal(sent.length, 20, "MAX_PAGES caps a single command at 20 files");
  assert.deepEqual(
    sent.map((call) => call.file?.filename),
    Array.from({ length: 20 }, (_, i) => `page-${i + 1}-of-50.pdf`),
  );
  assert.deepEqual(
    sent.map((call) => call.body.caption),
    Array.from({ length: 20 }, (_, i) => `第 ${i + 1}/50 页`),
  );
  assert.ok(sent.every((call) => (call.file?.bytes ?? 0) > 0));
  assert.ok(sent.every((call) => call.file?.head === "%PDF-1.7" || call.file?.head.startsWith("%PDF")));
  assert.match(texts(h).join("\n"), /共 50 页，一次只发前 20 页/);
});

test("a one-page PDF is refused with a reason, not an empty send", async () => {
  const { h, doc } = await documentReply("pdf-1page.pdf");
  await handle(h, command("/splitpdf", { from: user(803), reply_to_message: replyMsg(doc) }));
  assert.equal(h.fake.count("sendDocument"), 0);
  assert.match(texts(h).join("\n"), /只有一页/);
});

test("an encrypted PDF is named as such instead of dumping a parser error", async () => {
  const { h, bytes, doc } = await documentReply("pdf-encrypted.pdf");
  assert.equal(looksEncrypted(bytes), true, "fixture must really be encrypted");
  await assert.rejects(() => pdfPageCount(bytes), "pdf-lib cannot read it either");

  await handle(h, command("/splitpdf", { from: user(804), reply_to_message: replyMsg(doc) }));
  assert.equal(h.fake.count("sendDocument"), 0);
  const said = texts(h).join("\n");
  assert.match(said, /打开密码/);
  assert.doesNotMatch(said, /PDFDict|Expected instance/);
});

test("an empty file and a renamed text file are both explained", async () => {
  for (const [name, expected] of [
    ["empty.bin", /不是有效的 PDF/],
    ["fake.pdf", /不是有效的 PDF/],
    ["header-only.pdf", /损坏/],
  ] as const) {
    const { h, doc } = await documentReply(name, { as: name.replace(/\..*$/, ".pdf") });
    await handle(h, command("/splitpdf", { from: user(805), reply_to_message: replyMsg(doc) }));
    assert.equal(h.fake.count("sendDocument"), 0, `${name} must not send anything`);
    assert.match(texts(h).join("\n"), expected, `${name} should be explained`);
  }
});

test("a 24 MB PDF is refused from metadata without downloading it", async () => {
  const { h, doc } = await documentReply("big-24mb.pdf");
  await handle(h, command("/splitpdf", { from: user(806), reply_to_message: replyMsg(doc) }));
  assert.match(texts(h).join("\n"), /超过 8MB/);
  assert.equal(h.fake.count("downloadFile"), 0);
});

test("a file that lies about its size is still stopped at the download guard", async () => {
  const { h, doc } = await documentReply("big-24mb.pdf", { reportSize: 1024 });
  await handle(h, command("/splitpdf", { from: user(807), reply_to_message: replyMsg(doc) }));
  assert.equal(h.fake.count("sendDocument"), 0);
  assert.match(texts(h).join("\n"), /下载失败/);
});

test("encoding errors map to human sentences", () => {
  assert.match(describePdfError(new Error("Failed to parse PDF document (line:0 col:0 offset=0): No PDF header found")), /不是有效的 PDF/);
  assert.match(describePdfError(new Error("Expected instance of PDFDict, but got instance of undefined")), /损坏/);
  assert.match(describePdfError(new Error("PDF is encrypted")), /密码/);
  assert.match(describePdfError(new Error("kaboom")), /kaboom/);
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

test("a 30000px screenshot is cut into 10 strips and the truncation is announced", async () => {
  const h = await makeRuntime();
  h.rt.sliceImage = (bytes, height) => sliceImage(bytes, height);

  const filePath = "photos/long.png";
  h.fake.onFile(filePath, bytesOf("long-100x30000.png"));
  const target = message({ from: user(810), text: "", photo: [{ file_id: "p1", width: 100, height: 30_000, file_size: sizeOf("long-100x30000.png") }] });

  await handle(h, command("/slice", { from: user(810), reply_to_message: target }));

  const sent = h.fake.all("sendDocument");
  assert.equal(sent.length, 10, "MAX_SLICES bounds one command");
  assert.deepEqual(
    sent.map((call) => call.body.caption),
    Array.from({ length: 10 }, (_, i) => `第 ${i + 1}/10 段`),
  );
  assert.ok(sent.every((call) => call.file?.filename.startsWith("part-")));
  assert.match(texts(h).join("\n"), /这张图有 17 段，一次只发前 10 段/);

  const totalBytes = sent.reduce((sum, call) => sum + (call.file?.bytes ?? 0), 0);
  assert.ok(totalBytes < 30 * 1024 * 1024, "ten strips must stay well under any upload ceiling");
});

test("a 1×1 image is refused with its own message", async () => {
  const h = await makeRuntime();
  h.rt.sliceImage = (bytes, height) => sliceImage(bytes, height);
  h.fake.onFile("photos/tiny.png", bytesOf("tiny-1x1.png"));
  const target = message({ from: user(811), text: "", photo: [{ file_id: "p2", width: 1, height: 1 }] });

  await handle(h, command("/slice", { from: user(811), reply_to_message: target }));
  assert.equal(h.fake.count("sendDocument"), 0);
  assert.match(texts(h).join("\n"), /不需要切分/);
});

test("an EXIF-rotated long screenshot is sliced along the axis a reader sees", async () => {
  // Stored 3000×40 with orientation 6; displayed as 40×3000.
  const rotated = await sharp({ create: { width: 3000, height: 40, channels: 3, background: "#224466" } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();

  const result = await sliceImage(new Uint8Array(rotated));
  assert.equal(result.width, 40, "width and height come from the displayed orientation");
  assert.equal(result.height, 3000);
  assert.equal(result.total, 2);
  assert.equal(result.truncated, false);
  assert.equal(result.slices.length, 2);

  const first = await sharp(result.slices[0]?.data).metadata();
  assert.equal(first.width, 40);
  assert.equal(first.height, 1800);
});

test("the plain EXIF fixture still reports a useful size instead of crashing", async () => {
  await assert.rejects(() => sliceImage(bytesOf("rotated-exif.jpg")), /不需要切分/);
});

// ---------------------------------------------------------------------------

async function handle(h: Awaited<ReturnType<typeof makeRuntime>>, msg: TgMessage): Promise<void> {
  const { handleUpdate } = await import("../src/bot.ts");
  await handleUpdate(h.rt, { update_id: nextUpdate(), message: msg });
}

function texts(h: Awaited<ReturnType<typeof makeRuntime>>): string[] {
  return h.fake.all("sendMessage").map((call) => String(call.body.text ?? ""));
}
