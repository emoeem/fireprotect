/**
 * Local OCR through the `tesseract` CLI — Node only.
 *
 * Same isolation contract as `slice.node.ts`: this file is imported by
 * `node.ts` and by nothing else. The Worker bundle must never reach it, because
 * there is no `node:child_process` at the edge — and a missing native binary is
 * a deploy-time failure there rather than a runtime one.
 *
 * Why shell out instead of `tesseract.js`: the JavaScript build runs in wasm and
 * needs a ~40 MB language blob fetched at runtime. That is unacceptable inside a
 * 1 MiB Worker bundle *and* pointless for a self-hosted deploy that already has
 * the CLI — the same reasoning that makes `/slice` shell out to sharp and
 * `/parse` shell out to yt-dlp.
 *
 * The failure mode is the important part. Every way this can go wrong — no
 * binary, a corrupt image, a hang — comes back as `{ ok: false, error }` with a
 * sentence an admin can act on. It never throws: the caller is a group command,
 * and a throw there means a silent command instead of a readable answer.
 */
import { execFile } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type OcrResult =
  | { ok: true; text: string; lang: string }
  | { ok: false; error: string };

/**
 * 20 s. One A4 page at default settings is ~1 s; a phone screenshot of a chat
 * window is ~2 s. Ten times the honest cost is the ceiling before the update
 * becomes the slowest thing in the group.
 */
export const OCR_TIMEOUT_MS = 20_000;

/** Simplified Chinese plus Latin: an ad screenshot is bilingual by nature. */
export const OCR_LANGS = "chi_sim+eng";

/**
 * Telegram photos are re-encoded to ≤ 10 MB, so anything larger arrived as a
 * file. Copying a 200 MB "image" to /tmp to have tesseract reject it is a free
 * disk-exhaustion primitive for a group member.
 */
export const OCR_MAX_BYTES = 10 * 1024 * 1024;

/** Enough for a dense page of text; a runaway output is cut, not buffered. */
const MAX_OUTPUT = 4 * 1024 * 1024;

export type OcrExecResult =
  | { ok: true; stdout: string }
  | { ok: false; kind: "missing" | "timeout" | "exit"; detail: string };

/** The one process call, injectable so failure paths are testable without a hang. */
export type OcrExec = (file: string, args: string[], timeoutMs: number) => Promise<OcrExecResult>;

export type OcrOptions = {
  timeoutMs?: number;
  langs?: string;
  binary?: string;
  /** Where the scratch file goes; tests point this at a directory they can inspect. */
  tmpDir?: string;
  exec?: OcrExec;
};

const run: OcrExec = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT, encoding: "utf8" }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, stdout: String(stdout ?? "") });
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return resolve({ ok: false, kind: "missing", detail: file });
      // `execFile` reports its own timeout by killing the child (SIGTERM) and
      // setting `killed`; a non-zero exit is the child's own decision to quit.
      if (err.killed) return resolve({ ok: false, kind: "timeout", detail: String(timeoutMs) });
      const reason = String(stderr ?? "").trim() || err.message;
      return resolve({ ok: false, kind: "exit", detail: reason.slice(0, 200) });
    });
  });

/**
 * OCR one image.
 *
 * The bytes go through a temp file because tesseract takes paths, not stdin
 * (`-` works for some builds only, and a build without it would fail on exactly
 * the deployment that matters). The file is removed in a `finally`: a leaked
 * temp file per `/ocr` call fills a small VPS disk in a week, and nothing else
 * in this process ever cleans /tmp.
 *
 * The extension is cosmetic — Leptonica sniffs the payload — so a JPEG named
 * `.png` still reads correctly.
 */
export async function ocrImage(bytes: Uint8Array, opts: OcrOptions = {}): Promise<OcrResult> {
  if (!bytes.byteLength) return { ok: false, error: "图片是空的（0 字节）" };
  if (bytes.byteLength > OCR_MAX_BYTES) {
    return { ok: false, error: `图片超过 ${Math.round(OCR_MAX_BYTES / 1024 / 1024)}MB，跳过 OCR` };
  }

  const langs = opts.langs ?? OCR_LANGS;
  const timeoutMs = opts.timeoutMs ?? OCR_TIMEOUT_MS;
  const binary = opts.binary ?? "tesseract";
  const path = join(opts.tmpDir ?? tmpdir(), `ocr-${randomUUID()}.png`);

  try {
    // `writeFile` accepts the typed array directly; wrapping it in a Buffer
    // would be a second copy of up to 10 MB for nothing.
    await writeFile(path, bytes);
    const result = await (opts.exec ?? run)(binary, [path, "stdout", "-l", langs], timeoutMs);
    if (result.ok) return { ok: true, text: result.stdout.trim(), lang: langs };
    if (result.kind === "missing") {
      return { ok: false, error: `本机没有 ${binary}，装 tesseract-ocr 与中文语言包后可用` };
    }
    if (result.kind === "timeout") {
      return { ok: false, error: `识别超时（${Math.round(timeoutMs / 1000)} 秒），图可能太大或太复杂` };
    }
    return { ok: false, error: `识别失败：${result.detail}` };
  } catch (err) {
    // Disk full, no /tmp, permission denied on the scratch dir: all arrive here.
    return { ok: false, error: `识别失败：${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
  }
}
