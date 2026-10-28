/**
 * PDF page splitting.
 *
 * `pdf-lib` is pure JavaScript with no `node:` imports, so the same code runs
 * in the Worker. Each page becomes its own one-page document and is sent back
 * as a file — that is what people actually want from "split this PDF": a
 * per-page image they can forward, not a zip.
 */
import { PDFDocument } from "pdf-lib";

/** Telegram's bot download limit is 20 MB; we stay well under it. */
export const MAX_PDF_BYTES = 8 * 1024 * 1024;
export const MAX_PAGES = 20;

export type PageFile = { page: number; total: number; data: Uint8Array };

/**
 * Is the file encrypted?
 *
 * `pdf-lib` cannot decrypt, and its failure mode is a stack-shaped parser error
 * that means nothing to the person in the chat. Checking for an `/Encrypt`
 * dictionary in the trailer is a one-line heuristic that lets us answer
 * "有密码，先解锁" instead of "Expected instance of PDFDict".
 */
export function looksEncrypted(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 2_048)));
  const tailStart = Math.max(0, bytes.length - 4_096);
  const tail = new TextDecoder("latin1").decode(bytes.subarray(tailStart));
  return /\/Encrypt\s+\d+\s+\d+\s+R/.test(head + tail) || /\/Encrypt\s*<</.test(head + tail);
}

/** Turn a parser exception into something a group member can act on. */
export function describePdfError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/No PDF header/i.test(message)) return "这不是有效的 PDF（没有 PDF 文件头），可能只是改了扩展名";
  if (/PDFDict|Invalid object|invalid object|Expected instance/i.test(message)) {
    return "PDF 结构损坏或不完整（常见于下载中断，或加了密的文件）";
  }
  if (/password|encrypt/i.test(message)) return "PDF 有打开密码，先解锁再发";
  if (/too large|memory/i.test(message)) return "PDF 太大，处理时内存不够";
  return message.slice(0, 120);
}

export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  return doc.getPageCount();
}

/** Split into one document per page, capped so one command cannot send 300 files. */
export async function splitPdf(bytes: Uint8Array, maxPages = MAX_PAGES): Promise<PageFile[]> {
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const total = source.getPageCount();
  const limit = Math.min(total, maxPages);
  const out: PageFile[] = [];
  for (let index = 0; index < limit; index++) {
    const single = await PDFDocument.create();
    const [page] = await single.copyPages(source, [index]);
    if (page) single.addPage(page);
    out.push({ page: index + 1, total, data: await single.save() });
  }
  return out;
}
