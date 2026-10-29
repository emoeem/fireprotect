/**
 * PDF → images, for reading a document on a phone.
 *
 * A PDF in Telegram opens in a viewer you have to pinch and pan. The useful
 * transformation for a chat group is "each page as one image you can swipe
 * through" — which is what this file does. It is deliberately a *capability*
 * (like `sliceImage`), not a hard dependency: the Worker renders with a WASM
 * PDFium build shipped as an asset, the Node runner shells out to poppler.
 * Either way the caller sees the same two functions.
 *
 * Two rules shaped by where this runs:
 *  - the renderer is injected, because the two platforms share no code: a
 *    `node:` subprocess on one side, WebAssembly on the other;
 *  - every limit is enforced here, not by the caller: page count, output
 *    width and total bytes, because a 400-page 50 MB PDF must cost one
 *    rejected render, not a timed-out request.
 */

/** What one rendered page looks like to the caller. */
export type PdfPageImage = {
  /** 1-based page number. */
  page: number;
  /** PNG bytes. */
  data: Uint8Array;
  width: number;
  height: number;
};

export type PdfRenderResult = { ok: true; pages: PdfPageImage[]; total: number } | { ok: false; error: string };

/**
 * Render at most `maxPages` pages of `bytes` to PNGs.
 *
 * Throws nothing: a broken PDF, an unsupported encryption or a renderer that is
 * simply not available on this platform all come back as `{ ok: false }` with a
 * message an admin can act on.
 */
export type PdfRenderer = (
  bytes: Uint8Array,
  options: { width: number; maxPages: number },
) => Promise<PdfRenderResult>;

/** Telegram's bot download ceiling is 20 MB; renders above this are not worth it. */
export const PDF_RENDER_MAX_BYTES = 12 * 1024 * 1024;
/** One command/reaction must not turn into fifty uploads. */
export const PDF_RENDER_MAX_PAGES = 20;
/** Phone-readable: roughly a 3x-DPR 360px viewport. */
export const PDF_RENDER_WIDTH = 1080;

/** Is this document a PDF we should offer to render? */
export function isPdfDocument(doc: { mime_type?: string; file_name?: string } | undefined): boolean {
  if (!doc) return false;
  return /pdf/i.test(doc.mime_type ?? "") || /\.pdf$/i.test(doc.file_name ?? "");
}

/**
 * Cheap structural probe used before paying for a full render.
 *
 * A PDF whose trailer carries `/Encrypt` cannot be opened by either renderer
 * without a password, and saying so up front beats a parser stack trace.
 */
export function looksEncryptedPdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 2_048)));
  const tailStart = Math.max(0, bytes.length - 4_096);
  const tail = new TextDecoder("latin1").decode(bytes.subarray(tailStart));
  return /\/Encrypt\s+\d+\s+\d+\s+R/.test(head + tail) || /\/Encrypt\s*<</.test(head + tail);
}

/** One caption line per page: "第 1/3 页"。 */
export function pageCaption(page: number, total: number): string {
  return `第 ${page}/${total} 页`;
}
