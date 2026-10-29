/**
 * PDF rendering for the self-hosted runner: poppler's `pdftoppm`.
 *
 * The runner already depends on external binaries for `/parse` (yt-dlp, ffmpeg),
 * so one more is not a new class of dependency — and poppler is the reference
 * implementation, faster and more faithful than any WASM build. Calling a
 * program with an argv array is also the reason this adapter carries no licence
 * obligation: no linkage, no derivative work.
 *
 * Bounded like every other subprocess here: a hard timeout, a byte cap, and a
 * temp directory that is always removed.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDF_RENDER_MAX_BYTES, looksEncryptedPdf, type PdfRenderResult, type PdfRenderer } from "./pdf-render.ts";

const RENDER_TIMEOUT_MS = 60_000;

function run(args: string[], timeoutMs: number): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = spawn("pdftoppm", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value: { ok: true; stdout: string; stderr: string } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, error: `渲染超过 ${Math.round(timeoutMs / 1000)} 秒` });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => finish({ ok: false, error: `无法启动 pdftoppm：${err.message}（装 poppler-utils）` }));
    child.on("close", (code) => {
      if (code === 0) return finish({ ok: true, stdout, stderr });
      const line = stderr.split("\n").filter(Boolean).pop() ?? `退出码 ${code}`;
      finish({ ok: false, error: line.slice(0, 160) });
    });
  });
}

/** PNG dimensions, straight out of the IHDR chunk. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.byteLength < 24) return { width: 0, height: 0 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export const nodePdfRenderer: PdfRenderer = async (bytes, options): Promise<PdfRenderResult> => {
  if (bytes.byteLength > PDF_RENDER_MAX_BYTES) return { ok: false, error: "PDF 太大" };
  if (looksEncryptedPdf(bytes)) return { ok: false, error: "PDF 有打开密码，先解锁再发" };
  const dir = await mkdtemp(join(tmpdir(), "fwpdf-"));
  try {
    const source = join(dir, "in.pdf");
    await writeFile(source, bytes);
    const head = await run(
      ["-png", "-f", "1", "-l", String(options.maxPages), "-scale-to-x", String(options.width), "-scale-to-y", "-1", source, join(dir, "page")],
      RENDER_TIMEOUT_MS,
    );
    if (!head.ok) return { ok: false, error: `PDF 渲染失败：${head.error}` };
    // pdftoppm tells us the real page count in its "-f 1 -l N" run only through
    // the files it produced; read the total from a metadata probe instead.
    const names = (await readdir(dir)).filter((name) => /^page-\d+\.png$/.test(name)).sort((a, b) => {
      const n = (name: string) => Number(name.replace(/\D/g, ""));
      return n(a) - n(b);
    });
    if (!names.length) return { ok: false, error: "PDF 没有可渲染的页面" };
    const pages = [];
    for (const [index, name] of names.entries()) {
      const data = new Uint8Array(await readFile(join(dir, name)));
      const size = pngSize(data);
      pages.push({ page: index + 1, data, width: size.width, height: size.height });
    }
    // `total` is the truncated count here: pdftoppm was asked for at most
    // maxPages, and the caller only needs to know whether to say "还有更多页".
    return { ok: true, pages, total: pages.length };
  } catch (err) {
    return { ok: false, error: `PDF 渲染失败：${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
};
