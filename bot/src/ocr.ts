/**
 * Reply-to-image OCR: the portable half.
 *
 * Two things live here, and the split matters:
 *
 *  - `extractText` calls the OCR engine that the entry point injected. The
 *    Worker has nothing to inject (`node:child_process` does not exist at the
 *    edge), so a Worker deployment answers with a readable 「需要自托管部署」
 *    reason instead of crashing or silently doing nothing.
 *  - `screenOcrText` hands the recognised text to the *existing* keyword
 *    matcher and, on a hit, runs the *existing* disposal chain. Nothing about
 *    moderation is re-implemented here: an ad written on an image is an ad, and
 *    the only new question is where the text came from.
 *
 * The default is always pass. Recognition failure, empty text, no keyword, an
 * admin author, the master switch off — every one of those returns without
 * touching the message. A bot that deletes someone's photo because OCR guessed
 * wrong is worse than a bot that misses one ad.
 */
import { keywordPolicy, matchKeywords } from "./keywords.ts";
import { muteFor, punishAuto, record } from "./moderation.ts";
import type { Runtime } from "./context.ts";
import type { TgMessage } from "./types.ts";

export type OcrOutcome =
  | { ok: true; text: string; lang: string }
  | { ok: false; error: string };

/** What an entry point injects: bytes in, text out, never a throw. */
export type OcrEngine = (bytes: Uint8Array) => Promise<OcrOutcome>;

/**
 * Where the engine lives on the runtime.
 *
 * Declared here rather than imported from `tools/ocr.node.ts`, so the Worker
 * dependency graph never reaches a `node:child_process` module — the same
 * reason `Runtime.sliceImage` declares sharp's shape inline instead of naming
 * `sharp`'s types.
 *
 * It is an intersection and not a bare `{ ocr?: OcrEngine }` on purpose: a type
 * whose properties are *all* optional is a "weak type", and TypeScript refuses
 * to accept an object that shares none of them. A bare optional field would
 * therefore reject a `Runtime` that has no engine — which is exactly the Worker
 * deployment, i.e. the case that has to compile.
 */
export type OcrHost = Runtime & { ocr?: OcrEngine };

export type OcrDeps = {
  /** Overrides the injected engine; the test seam that keeps tesseract out. */
  engine?: OcrEngine;
};

/** The sentence a Worker deployment gets. Explicit about what to do next. */
export const WORKER_OCR_REASON = "图片文字识别需要自托管部署（本机版本调用 tesseract，Worker 里没有子进程）";

/**
 * How much recognised text is screened.
 *
 * OCR output is attacker-controlled: the whole point of `/ocr` is to read text
 * somebody else put in a picture. 500 characters is roughly a full screen of a
 * chat screenshot — the part a reader actually sees — and it keeps the match
 * cost flat no matter what the image contains. The residual risk is stated
 * rather than hidden: an ad whose keyword sits at character 900 is not caught,
 * because a spammer who knows about `/ocr` can pad the top of the picture.
 */
export const OCR_SCREEN_MAX_CHARS = 500;

export type OcrScreenAction = "pass" | "record" | "mute" | "punish";

export type OcrScreen = {
  /** True only when a keyword matched and something was decided. */
  hit: boolean;
  /** What the keyword path did — the same four outcomes a text message has. */
  action: OcrScreenAction;
  /** Exactly the string handed to the matcher (capped and CJK-normalised). */
  screened: string;
  /** Human-readable, shown in the group; empty on a pass. */
  reason: string;
  /** The matched keyword or regex source. */
  label: string;
  /** True when the cap cut the text. */
  truncated: boolean;
  /** Telegram's own errors, if the disposal partly failed. */
  errors: string[];
};

export type OcrRun = { ok: false; error: string } | { ok: true; text: string; lang: string; screen: OcrScreen };

/** True only when an engine was injected — the Worker's answer is false. */
export function ocrAvailable(rt: OcrHost): boolean {
  return typeof rt.ocr === "function";
}

/**
 * Run the engine.
 *
 * Failure is a value, not an exception, for the same reason `Vision.check`
 * returns `{ hit: false, failed: true }`: this sits in the message path, and a
 * throw there costs the group a working command. A third-party engine that
 * throws is caught and turned into the same readable shape.
 */
export async function extractText(rt: OcrHost, deps: OcrDeps, bytes: Uint8Array): Promise<OcrOutcome> {
  const engine = deps.engine ?? rt.ocr;
  if (!engine) return { ok: false, error: WORKER_OCR_REASON };
  if (!bytes.byteLength) return { ok: false, error: "图片是空的（0 字节）" };
  try {
    return await engine(bytes);
  } catch (err) {
    return { ok: false, error: `识别失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Screen recognised text the way the message pipeline screens a message.
 *
 * `msg` is the message the picture was attached to — the one that gets deleted
 * and whose author climbs the warning ladder. Without it there is nothing to
 * delete, so the hit is only recorded; that keeps a bare `screenOcrText(rt,
 * chatId, text)` call meaningful instead of pretending to act.
 */
export async function screenOcrText(rt: Runtime, chatId: number, text: string, msg?: TgMessage): Promise<OcrScreen> {
  if (!text.trim()) return pass("", false);

  const capped = text.length > OCR_SCREEN_MAX_CHARS ? text.slice(0, OCR_SCREEN_MAX_CHARS) : text;
  const screened = collapseCjkSpacing(capped);
  const truncated = text.length > OCR_SCREEN_MAX_CHARS;

  const config = await rt.configFor(chatId);
  // The master switch stops every automatic action, in this path too.
  if (!config.enabled) return pass(screened, truncated);

  const hit = matchKeywords(screened, config.keywords, config.keywordPatterns ?? []);
  if (!hit) return pass(screened, truncated);

  const reason =
    hit.via === "pattern" ? `图片文字命中正则 /${hit.label}/` : `图片文字命中关键词「${hit.label}」`;
  const userId = msg?.from?.id ?? 0;

  // Admins are never filtered — the same rule as step 3 of `handleMessage`.
  // Checked after the match so a clean image costs no API call.
  if (userId && (await rt.admin.isAdmin(chatId, userId))) return pass(screened, truncated, hit.label);

  // The sponsor whitelist and `keywordAction: record` both mean "tell me, do
  // not touch it"; `keywordPolicy` owns that decision for text messages.
  if (keywordPolicy(config, userId) === "record") {
    await record(rt, { chatId, userId, kind: "watch", reason: `只记录：${reason}` });
    return { ...pass(screened, truncated, hit.label), hit: true, action: "record", reason };
  }

  if (!msg) {
    // No message to act on. Recording the hit is the honest degradation: an
    // admin still learns the keyword fired, nothing is deleted on a guess.
    await record(rt, { chatId, userId, kind: "watch", reason: `只记录（无可删除消息）：${reason}` });
    return { ...pass(screened, truncated, hit.label), hit: true, action: "record", reason };
  }

  if (config.keywordAction === "mute") {
    const result = await muteFor(rt, msg, config.muteMinutes, reason);
    return {
      hit: true,
      action: "mute",
      screened,
      reason,
      label: hit.label,
      truncated,
      errors: result.errors,
    };
  }

  const result = await punishAuto(rt, msg, config, reason);
  return {
    hit: true,
    action: "punish",
    screened,
    reason,
    label: hit.label,
    truncated,
    errors: result.errors,
  };
}

/**
 * Recognise, then screen — the one call a command needs.
 *
 * Keeping this here rather than in the handler is what makes 「识别失败原样放行」
 * a property of the code instead of a habit of the caller: on `ok: false` the
 * text is never screened, so no keyword and no punishment can follow from a
 * failure.
 */
export async function recognizeAndScreen(
  rt: Runtime,
  chatId: number,
  bytes: Uint8Array,
  msg?: TgMessage,
  deps: OcrDeps = {},
): Promise<OcrRun> {
  const outcome = await extractText(rt, deps, bytes);
  if (!outcome.ok) return { ok: false, error: outcome.error };
  const screen = await screenOcrText(rt, chatId, outcome.text, msg);
  return { ok: true, text: outcome.text, lang: outcome.lang, screen };
}

function pass(screened: string, truncated: boolean, label = ""): OcrScreen {
  return { hit: false, action: "pass", screened, reason: "", label, truncated, errors: [] };
}

/**
 * Remove the spaces tesseract inserts between Chinese characters.
 *
 * `chi_sim` has no word boundaries, so its output is "加 微 信 abc123" — one
 * space per glyph. A keyword configured as 「加微信」 then never matches, which
 * would make Chinese ad screening on OCR text quietly useless. Only spaces
 * *between two CJK characters* are removed, so "加微信 abc123" keeps its space
 * and the Latin part is unchanged.
 *
 * This runs before matching only; the text shown to the group is untouched.
 */
export function collapseCjkSpacing(text: string): string {
  if (!text) return "";
  return text.replace(/([\u2e80-\u9fff\uf900-\ufaff])\s+(?=[\u2e80-\u9fff\uf900-\ufaff])/g, "$1");
}
