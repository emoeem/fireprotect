/**
 * Reply-to-image OCR.
 *
 * Two halves are tested against two different kinds of evidence:
 *
 *  - the Node engine runs the *real* `tesseract` on a PNG rendered at test time
 *    from an SVG, so the assertion covers the temp file, the CLI call, the
 *    language flags and the cleanup — not a stubbed shape. If this machine has
 *    no tesseract the case is skipped with a printed reason rather than
 *    pretending to pass;
 *  - the screening half runs with a fake engine, because what matters there is
 *    that an ad on a picture is disposed of *exactly* like an ad in text, and
 *    that every failure path leaves the message alone.
 *
 * No case asserts on the Chinese characters chi_sim returns: the render is
 * synthetic and `chi_sim` inserts a space between glyphs ("加 微 信"), so
 * asserting on them would be asserting on tesseract's model, not on our code.
 * The CJK-space collapse is covered explicitly instead.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { ocrImage, OCR_LANGS, OCR_MAX_BYTES } from "../src/tools/ocr.node.ts";
import {
  collapseCjkSpacing,
  extractText,
  ocrAvailable,
  OCR_SCREEN_MAX_CHARS,
  recognizeAndScreen,
  screenOcrText,
  WORKER_OCR_REASON,
  type OcrEngine,
} from "../src/ocr.ts";
import { handleUpdate } from "../src/bot.ts";
import { command, FakeTg, makeRuntime, message, nextUpdate, user } from "./harness.ts";
import type { TgMessage } from "../src/types.ts";

/** Empty when tesseract is usable; the skip reason otherwise. */
const noTesseract = (() => {
  try {
    execFileSync("tesseract", ["--version"], { stdio: "ignore" });
    return "";
  } catch {
    return "本机没有 tesseract，真实 OCR 用例跳过";
  }
})();

/**
 * A picture of an ad: one Latin line and one Chinese line.
 *
 * Fonts are named explicitly instead of relying on a default: librsvg falls back
 * silently and an unrendered glyph is an empty image, which would turn a real
 * regression into a mysterious OCR miss.
 */
const AD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300">
  <rect width="900" height="300" fill="#ffffff"/>
  <text x="40" y="90" font-family="DejaVu Sans, Noto Sans, sans-serif" font-size="64" fill="#111111">SALE 50%</text>
  <text x="40" y="200" font-family="Noto Sans CJK SC, Noto Sans CJK JP, sans-serif" font-size="64" fill="#111111">加微信 abc123</text>
</svg>`;

async function render(text: string): Promise<Uint8Array> {
  const png = await sharp(Buffer.from(text)).png().toBuffer();
  return new Uint8Array(png);
}

const adPng = () => render(AD_SVG);

/** Calls that change something in the group. Reads (getChatMember) are excluded. */
const MUTATING = new Set([
  "deleteMessage",
  "deleteMessages",
  "restrictChatMember",
  "banChatMember",
  "unbanChatMember",
  "sendMessage",
  "sendDocument",
  "sendPhoto",
  "sendVideo",
  "sendMedia",
]);

function changes(fake: FakeTg): { method: string; chat: unknown; target: unknown }[] {
  return fake.calls
    .filter((call) => MUTATING.has(call.method))
    .map((call) => ({ method: call.method, chat: call.body.chat_id, target: call.body.message_id ?? call.body.user_id ?? null }));
}

function texts(fake: FakeTg): string[] {
  return fake.all("sendMessage").map((call) => String(call.body.text ?? ""));
}

const fakeEngine = (text: string): OcrEngine => async () => ({ ok: true, text, lang: OCR_LANGS });

/** The message the picture arrived in — the one that gets deleted. */
function picture(patch: Partial<TgMessage> = {}): TgMessage {
  return message({
    message_id: 7001,
    from: user(500),
    text: "",
    photo: [{ file_id: "photo-1", width: 900, height: 300 }],
    ...patch,
  });
}

// ---------------------------------------------------------------------------
// The real engine
// ---------------------------------------------------------------------------

test("real tesseract reads the Latin text out of a generated image", { skip: noTesseract || false }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "ocr-real-"));
  const result = await ocrImage(await adPng(), { tmpDir: scratch });
  console.log(`[ocr] lang=${result.ok ? result.lang : "-"} text=${JSON.stringify(result.ok ? result.text : result.error)}`);

  assert.equal(result.ok, true, "tesseract must succeed on a clean render");
  if (!result.ok) return;
  assert.match(result.text, /abc123|SALE/i, "the ASCII part is what a synthetic render can guarantee");
  assert.equal(result.lang, OCR_LANGS);
  assert.deepEqual(readdirSync(scratch), [], "the temp file is removed even on success");
});

test("the injected engine carries a real OCR result through extractText", { skip: noTesseract || false }, async () => {
  const h = await makeRuntime();
  const outcome = await extractText(h.rt, { engine: (bytes) => ocrImage(bytes) }, await adPng());
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.match(outcome.text, /abc123|SALE/i);
});

test("a blank image OCRs to no text and the screen leaves the message alone", { skip: noTesseract || false }, async () => {
  const h = await makeRuntime();
  const blank = await sharp({ create: { width: 600, height: 300, channels: 3, background: "#ffffff" } })
    .png()
    .toBuffer();
  const outcome = await extractText(h.rt, { engine: (bytes) => ocrImage(bytes) }, new Uint8Array(blank));
  assert.equal(outcome.ok, true, "a picture with no glyphs is not an error");
  if (!outcome.ok) return;
  assert.equal(outcome.text.trim(), "");

  const screen = await screenOcrText(h.rt, -1001, outcome.text, picture());
  assert.equal(screen.hit, false);
  assert.equal(screen.action, "pass");
  assert.deepEqual(changes(h.fake), [], "no delete, no mute, no notice");
});

// ---------------------------------------------------------------------------
// Temp-file hygiene and failure mapping (no tesseract needed)
// ---------------------------------------------------------------------------

test("every failure kind is a readable sentence and never a throw", async () => {
  const cases: { kind: "missing" | "timeout" | "exit"; detail: string; expect: RegExp }[] = [
    { kind: "missing", detail: "tesseract", expect: /装 tesseract-ocr/ },
    { kind: "timeout", detail: "20000", expect: /识别超时（20 秒）/ },
    { kind: "exit", detail: "Error in pixReadMemPng: bit depth = 0", expect: /识别失败：Error in pixReadMemPng/ },
  ];
  for (const item of cases) {
    const scratch = mkdtempSync(join(tmpdir(), "ocr-fail-"));
    const result = await ocrImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      tmpDir: scratch,
      exec: async () => ({ ok: false, kind: item.kind, detail: item.detail }),
    });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : "", item.expect);
    assert.deepEqual(readdirSync(scratch), [], `${item.kind}: the temp file is removed on failure too`);
  }
});

test("empty and oversized payloads are refused before anything is written", async () => {
  const empty = await ocrImage(new Uint8Array(0));
  assert.equal(empty.ok, false);
  assert.match(empty.ok === false ? empty.error : "", /空的/);

  const huge = await ocrImage(new Uint8Array(OCR_MAX_BYTES + 1));
  assert.equal(huge.ok, false);
  assert.match(huge.ok === false ? huge.error : "", /跳过 OCR/);
});

// ---------------------------------------------------------------------------
// Worker degradation
// ---------------------------------------------------------------------------

test("without an engine the Worker gets 需要自托管部署 instead of a crash", async () => {
  const h = await makeRuntime();
  assert.equal(ocrAvailable(h.rt), false, "nothing is injected in the Worker build");

  const outcome = await extractText(h.rt, {}, new Uint8Array([1, 2, 3]));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false ? outcome.error : "", WORKER_OCR_REASON);
  assert.match(WORKER_OCR_REASON, /需要自托管部署/);

  // The same runtime answers yes the moment an engine is present.
  assert.equal(ocrAvailable({ ...h.rt, ocr: fakeEngine("加微信") }), true);
});

test("an engine that throws is caught, not propagated", async () => {
  const h = await makeRuntime();
  const outcome = await extractText(h.rt, {
    engine: async () => {
      throw new Error("spawn tesseract EACCES");
    },
  }, new Uint8Array([1]));
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok === false ? outcome.error : "", /EACCES/);
});

// ---------------------------------------------------------------------------
// Screening parity with the text pipeline
// ---------------------------------------------------------------------------

test("an ad in a picture is disposed of exactly like an ad in text", async () => {
  const fromOcr = await makeRuntime();
  const fromText = await makeRuntime();
  // Both groups configure the same rule. A brand-new chat gets the activation
  // preset, which ships `keywords: []` on purpose — so the rule has to be
  // written explicitly or neither pipeline would have anything to match.
  for (const h of [fromOcr, fromText]) await h.rt.saveConfig(-1001, { keywords: ["加微信"], keywordAction: "delete" });

  const run = await recognizeAndScreen(fromOcr.rt, -1001, new Uint8Array([1]), picture(), {
    engine: fakeEngine("加微信 abc123"),
  });
  assert.equal(run.ok, true);
  assert.equal(run.ok && run.screen.hit, true);
  assert.equal(run.ok && run.screen.action, "punish");

  // The same text as a plain message, through the real pipeline.
  await handleUpdate(fromText.rt, { update_id: nextUpdate(), message: command("加微信 abc123", { message_id: 7001, from: user(500) }) });

  assert.deepEqual(
    changes(fromOcr.fake),
    changes(fromText.fake),
    "same deletion, same ladder rung, same notice target",
  );
  assert.ok(texts(fromOcr.fake).some((text) => text.includes("加微信")));
  assert.ok(
    texts(fromOcr.fake).some((text) => text.includes("图片文字")),
    "the notice says the text came from a picture, which is the only thing that may differ",
  );
});

test("tesseract's spaces between Chinese characters are collapsed before matching", async () => {
  assert.equal(collapseCjkSpacing("加 微 信 abc123"), "加微信 abc123");
  assert.equal(collapseCjkSpacing("加微信 abc123"), "加微信 abc123", "already-clean text is untouched");
  assert.equal(collapseCjkSpacing("SALE 50%"), "SALE 50%", "Latin spacing is never touched");

  // The exact shape tesseract 5.5.3 produced on this machine's render.
  const h = await makeRuntime();
  const screen = await screenOcrText(h.rt, -1001, "加 微 信 abc123", picture());
  assert.equal(screen.hit, true, "without the collapse no Chinese keyword could ever match");
  assert.equal(screen.label, "加微信");
});

test("text with no keyword does nothing at all", async () => {
  const h = await makeRuntime();
  const run = await recognizeAndScreen(h.rt, -1001, new Uint8Array([1]), picture(), {
    engine: fakeEngine("SALE 50%\n今日特价，欢迎光临"),
  });
  assert.equal(run.ok && run.screen.hit, false);
  assert.deepEqual(changes(h.fake), []);
});

test("a configured whitelist still only records a hit", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, { keywordAction: "record" });
  const screen = await screenOcrText(h.rt, -1001, "加微信", picture());
  assert.equal(screen.hit, true);
  assert.equal(screen.action, "record");
  assert.deepEqual(changes(h.fake), [], "recorded, never touched");
});

test("keywordAction=mute mutes without climbing the ladder", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, { keywordAction: "mute", muteMinutes: 30 });
  const screen = await screenOcrText(h.rt, -1001, "加微信", picture());
  assert.equal(screen.action, "mute");
  assert.deepEqual(
    changes(h.fake).map((call) => call.method),
    ["deleteMessage", "restrictChatMember"],
  );
});

test("recognised text alone never punishes anyone: no message, no action", async () => {
  const h = await makeRuntime();
  const screen = await screenOcrText(h.rt, -1001, "加微信");
  assert.equal(screen.hit, true);
  assert.equal(screen.action, "record", "nothing to delete, so only the fact is recorded");
  assert.deepEqual(changes(h.fake), []);
});

// ---------------------------------------------------------------------------
// Failure and empty text are passed through untouched
// ---------------------------------------------------------------------------

test("a recognition failure deletes nothing and returns the reason", async () => {
  const h = await makeRuntime();
  const run = await recognizeAndScreen(h.rt, -1001, new Uint8Array([9, 9]), picture(), {
    engine: async () => ({ ok: false, error: "识别失败：tesseract 退出码 1" }),
  });
  assert.equal(run.ok, false);
  assert.match(run.ok === false ? run.error : "", /tesseract 退出码 1/);
  assert.deepEqual(h.fake.calls, [], "not even a read: the failure path is short-circuited");
});

test("the master switch off leaves a recognised ad alone", async () => {
  const h = await makeRuntime();
  await h.rt.saveConfig(-1001, { enabled: false });
  const screen = await screenOcrText(h.rt, -1001, "加微信", picture());
  assert.equal(screen.hit, false);
  assert.deepEqual(changes(h.fake), []);
});

// ---------------------------------------------------------------------------
// Length cap
// ---------------------------------------------------------------------------

test("a 5000-character result is screened on the capped prefix only", async () => {
  const h = await makeRuntime();
  const keywordBeyondCap = "A".repeat(OCR_SCREEN_MAX_CHARS) + "加微信";
  const run = await recognizeAndScreen(h.rt, -1001, new Uint8Array([1]), picture(), {
    engine: fakeEngine(keywordBeyondCap),
  });
  assert.equal(run.ok, true);
  if (!run.ok) return;
  assert.equal(run.screen.screened.length, OCR_SCREEN_MAX_CHARS, "the matcher saw exactly the capped string");
  assert.equal(run.screen.screened, keywordBeyondCap.slice(0, OCR_SCREEN_MAX_CHARS));
  assert.equal(run.screen.truncated, true);
  assert.equal(run.screen.hit, false, "a keyword past the cap is deliberately not screened");
  assert.deepEqual(changes(h.fake), []);

  // Same length, keyword inside the prefix: it must still fire.
  const inside = "加微信" + "A".repeat(5_000);
  const hit = await screenOcrText(h.rt, -1001, inside, picture({ from: user(501) }));
  assert.equal(hit.hit, true);
  assert.equal(hit.screened.length, OCR_SCREEN_MAX_CHARS);
});
