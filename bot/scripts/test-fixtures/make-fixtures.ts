/**
 * Acceptance fixtures, generated on demand.
 *
 * Nothing here is committed as a binary: a checked-in 24 MB PDF is a repo
 * problem, and a hand-made "encrypted" file is a lie waiting to happen. Run
 * `npm run fixtures` before `npm test` (the tools test does it automatically
 * when the directory is missing).
 *
 *   npx tsx scripts/test-fixtures/make-fixtures.ts [outDir]
 *
 * Every file is deterministic — same seed, same bytes — so a failure points at
 * the code and not at the fixture.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

const outDir = process.argv[2] ?? join(import.meta.dirname, "out");

function write(name: string, data: Uint8Array | string): string {
  const path = join(outDir, name);
  writeFileSync(path, data);
  return path;
}

/** A page with a little text, so a page count is not the only thing to assert. */
async function makePdf(pages: number, label: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let index = 0; index < pages; index++) {
    const page = doc.addPage([200, 120]);
    page.drawText(`${label} ${index + 1}/${pages}`, { x: 12, y: 60, size: 10 });
  }
  return doc.save();
}

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const made: string[] = [];

  made.push(write("pdf-1page.pdf", await makePdf(1, "one")));
  made.push(write("pdf-50page.pdf", await makePdf(50, "page")));

  // Real encryption: pdf-lib cannot write encrypted files, qpdf can. If qpdf is
  // missing the fixture is skipped loudly instead of pretending to be encrypted.
  const plain = await makePdf(2, "secret");
  const plainPath = write("pdf-plain-for-qpdf.pdf", plain);
  try {
    execFileSync("qpdf", ["--encrypt", "userpass", "ownerpass", "256", "--", plainPath, join(outDir, "pdf-encrypted.pdf")]);
    made.push(join(outDir, "pdf-encrypted.pdf"));
  } catch {
    console.warn("qpdf 不可用：跳过 pdf-encrypted.pdf（加密 PDF 用例会自跳过）");
    writeFileSync(join(outDir, "pdf-encrypted.MISSING"), "qpdf not installed");
  }

  made.push(write("empty.bin", new Uint8Array(0)));
  made.push(write("fake.pdf", "this is not a pdf at all, just text pretending to be one\n"));
  made.push(write("header-only.pdf", "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n"));

  // 24 MiB: over both the 8 MB command limit and the 20 MB download guard.
  const big = new Uint8Array(24 * 1024 * 1024);
  big.set(new TextEncoder().encode("%PDF-1.7\n"), 0);
  made.push(write("big-24mb.pdf", big));

  // 30000 px tall, 100 px wide: the extreme long-screenshot case.
  made.push(
    write(
      "long-100x30000.png",
      await sharp({
        create: { width: 100, height: 30_000, channels: 3, background: { r: 20, g: 40, b: 60 } },
      })
        .png({ compressionLevel: 9 })
        .toBuffer(),
    ),
  );

  made.push(
    write("tiny-1x1.png", await sharp({ create: { width: 1, height: 1, channels: 3, background: "#ffffff" } }).png().toBuffer()),
  );

  // EXIF orientation 6 = "rotate 90° CW on display". Dimensions stay 40×20 in
  // the file; only a viewer rotates them, which is exactly the trap.
  made.push(
    write(
      "rotated-exif.jpg",
      await sharp({ create: { width: 40, height: 20, channels: 3, background: "#884422" } })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toBuffer(),
    ),
  );

  console.log(`fixtures written to ${outDir}`);
  for (const path of made) console.log("  " + path.replace(outDir + "/", ""));
}

await main();
