/**
 * Minimal PNG encoder — no native canvas, no dependency.
 *
 * Two callers need it: the image captcha (renders a small RGB raster) and the
 * PDF renderer (turns a page bitmap into a photo). Both run in the Worker, where
 * `canvas` and `sharp` do not exist, and both produce images that are mostly
 * flat colour — which is what makes a hand-rolled encoder worth it: PNG's Sub
 * filter plus zlib takes a 1080px text page from 1.3 MB of raw bitmap to a few
 * kilobytes.
 *
 * `deflate` uses CompressionStream("deflate"), a zlib wrapper — exactly what an
 * IDAT chunk wants (a bare deflate stream would fail to decode).
 */

export type PngChannels = 1 | 3;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function putU32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength);
  putU32(out, 0, data.byteLength);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  putU32(out, 8 + data.byteLength, crc32(out.subarray(4, 8 + data.byteLength)));
  return out;
}

async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  const buffer = raw.slice().buffer as ArrayBuffer;
  const stream = new Blob([buffer]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Encode `pixels` (row-major, `channels` bytes per pixel) as a PNG.
 *
 * Sub filter, not None: adjacent pixels in a rendered page are usually nearly
 * identical, so differencing them turns long runs into zeros and zlib eats them.
 * The filter byte per row costs one byte and pays for itself many times over.
 */
export async function encodePng(
  width: number,
  height: number,
  channels: PngChannels,
  pixels: Uint8Array,
  options: { filter?: "sub" | "none" } = {},
): Promise<Uint8Array> {
  const stride = width * channels;
  const useSub = (options.filter ?? "sub") === "sub";
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = y * stride;
    const dst = y * (stride + 1);
    raw[dst] = useSub ? 1 : 0;
    if (!useSub) {
      raw.set(pixels.subarray(src, src + stride), dst + 1);
      continue;
    }
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? (pixels[src + i - channels] as number) : 0;
      raw[dst + 1 + i] = ((pixels[src + i] as number) - left) & 0xff;
    }
  }

  const ihdr = new Uint8Array(13);
  putU32(ihdr, 0, width);
  putU32(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 1 ? 0 : 2; // colour type: grayscale | truecolor

  const parts = [chunk("IHDR", ihdr), chunk("IDAT", await deflate(raw)), chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(8 + parts.reduce((sum, part) => sum + part.byteLength, 0));
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let offset = 8;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.byteLength;
  }
  return png;
}

/**
 * RGBA → 3 channels. PDFium renders RGBA; the alpha channel is always 255 on an
 * opaque page, so dropping it saves a quarter of the pixels before compression
 * even starts.
 */
export function rgbaToRgb(rgba: Uint8Array, pixels: number): Uint8Array {
  const rgb = new Uint8Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    rgb[i * 3] = rgba[i * 4] as number;
    rgb[i * 3 + 1] = rgba[i * 4 + 1] as number;
    rgb[i * 3 + 2] = rgba[i * 4 + 2] as number;
  }
  return rgb;
}
