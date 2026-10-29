/**
 * PDF rendering on the edge: PDFium compiled to WebAssembly.
 *
 * Three constraints shaped this file, each verified against the real runtime:
 *
 *  1. **No runtime wasm compilation.** Cloudflare rejects
 *     `WebAssembly.instantiate(bytes)` with "Wasm code generation disallowed by
 *     embedder" — locally *and* on the edge. The wasm must be a statically
 *     imported module (`import ... from "./pdfium.wasm"`, wrangler's
 *     CompiledWasm rule), handed to Emscripten through `instantiateWasm`.
 *  2. **No canvas.** PDFium renders into its own bitmap; this file encodes that
 *     bitmap to PNG itself (`png.ts`). Encoding is not a detail: the raw page is
 *     1.3 MB, Sub-filter + zlib brings it to a few KB.
 *  3. **Licence.** MuPDF renders marginally faster but is AGPL-3.0, which would
 *     relicense the whole project on anyone serving it. PDFium is BSD/MIT.
 *
 * A 900–1080 px width is the "read it on a phone" size: a 300-page A4 becomes
 * legible without pinch-zoom, and the file stays under 100 KB.
 */
import { PDFiumLibrary } from "@hyzyla/pdfium";
import pdfiumModule from "../assets/pdfium.wasm";
import { encodePng } from "./png.ts";
import { PDF_RENDER_MAX_BYTES, looksEncryptedPdf, type PdfRenderResult, type PdfRenderer } from "./pdf-render.ts";

type Library = Awaited<ReturnType<typeof PDFiumLibrary.init>>;

let library: Promise<Library> | null = null;

function getLibrary(): Promise<Library> {
  if (!library) {
    library = PDFiumLibrary.init({
      instantiateWasm: (imports: WebAssembly.Imports, successCallback: (instance: WebAssembly.Instance) => void) => {
        const instance = new WebAssembly.Instance(pdfiumModule as WebAssembly.Module, imports);
        successCallback(instance);
        return instance.exports;
      },
    }).catch((err) => {
      // A failed warm-up must not poison the isolate: retry on the next PDF.
      library = null;
      throw err;
    });
  }
  return library;
}

export function workerPdfRenderer(): PdfRenderer {
  return async (bytes: Uint8Array, options): Promise<PdfRenderResult> => {
    if (bytes.byteLength > PDF_RENDER_MAX_BYTES) return { ok: false, error: "PDF 太大" };
    if (looksEncryptedPdf(bytes)) return { ok: false, error: "PDF 有打开密码，先解锁再发" };
    let doc: Awaited<ReturnType<Library["loadDocument"]>> | null = null;
    try {
      const lib = await getLibrary();
      doc = await lib.loadDocument(bytes);
      const total = doc.getPageCount();
      const limit = Math.min(total, options.maxPages);
      const pages = [];
      for (let index = 0; index < limit; index++) {
        const page = doc.getPage(index);
        // The callback receives the raw bitmap; encoding happens here so the
        // page never becomes a 1.3 MB buffer we would have to upload.
        const rendered = await page.render({
          width: options.width,
          colorSpace: "Gray",
          render: async ({ width, height, data }) => encodePng(width, height, 1, data),
        });
        pages.push({ page: index + 1, data: rendered.data, width: rendered.width, height: rendered.height });
      }
      return { ok: true, pages, total };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/out of memory|OOM|exceeded/i.test(message)) return { ok: false, error: "PDF 太大，渲染内存不够" };
      return { ok: false, error: `PDF 渲染失败：${message.slice(0, 120)}` };
    } finally {
      try {
        doc?.destroy();
      } catch {
        // A destroy failure must not mask a successful render.
      }
    }
  };
}

/** Tests only: forget the cached wasm instance. */
export function resetPdfium(): void {
  library = null;
}
