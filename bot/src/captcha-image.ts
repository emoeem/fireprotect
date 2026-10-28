/**
 * The image captcha: a rendered PNG, no native deps.
 *
 * Why an image at all: button/math captchas are answered by tapping a button
 * whose label the script can read out of the message, and a plain-text question
 * is readable too. The answer inside a rendered image forces an OCR step — the
 * same bar every major Telegram manager sets.
 *
 * The whole thing is hand-rolled because the Worker has no canvas and no image
 * library:
 *  - a 5×7 bitmap font for an unambiguous 31-char alphabet (no O/0/I/1/L);
 *  - scanlines with per-character jitter and noise, so a naive template match
 *    against the font fails;
 *  - PNG encoding via CompressionStream("deflate") — zlib-wrapped, exactly what
 *    the IDAT chunk wants — plus a CRC32 over each chunk.
 *
 * Everything is driven by an injected `random`, so tests are deterministic and
 * the renderer itself never touches globals.
 */

/** Unambiguous alphabet: the confusable pairs (0/O, 1/I/L) are excluded. */
export const CAPTCHA_CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const FONT: Record<string, number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17],
  J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 25, 21, 19, 17, 17, 17],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 10, 10, 4],
  W: [17, 17, 17, 21, 21, 27, 17],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
  "2": [14, 17, 1, 6, 8, 16, 31],
  "3": [30, 1, 1, 14, 1, 1, 30],
  "4": [2, 6, 10, 18, 31, 2, 2],
  "5": [31, 16, 16, 30, 1, 1, 30],
  "6": [14, 16, 16, 30, 17, 17, 14],
  "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 1, 14],
};

export const CAPTCHA_CODE_LENGTH = 5;
const SCALE = 5;
const PAD = 10;
const GLYPH_W = 5;
const GLYPH_H = 7;

export function captchaCode(random: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < CAPTCHA_CODE_LENGTH; i++) {
    code += CAPTCHA_CHARSET[Math.floor(random() * CAPTCHA_CHARSET.length)];
  }
  return code;
}

const BG: [number, number, number] = [246, 247, 250];
const INK: [number, number, number] = [24, 32, 48];

class Raster {
  readonly width: number;
  readonly height: number;
  private readonly px: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.px = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      this.px[i * 3] = BG[0];
      this.px[i * 3 + 1] = BG[1];
      this.px[i * 3 + 2] = BG[2];
    }
  }

  dot(x: number, y: number, color: [number, number, number]): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 3;
    this.px[i] = color[0];
    this.px[i + 1] = color[1];
    this.px[i + 2] = color[2];
  }

  rect(x0: number, y0: number, w: number, h: number, color: [number, number, number]): void {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.dot(x, y, color);
  }

  bytes(): Uint8Array {
    return this.px;
  }
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
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
  const stream = new Blob([raw.slice().buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Render `code` into a PNG. Deterministic for a given (code, random) pair.
 *
 * The jitter and the stray dots exist so the glyphs do not sit on a fixed grid:
 * without them the image is a font atlas a script could diff away.
 */
export async function renderCaptchaPng(code: string, random: () => number = Math.random): Promise<Uint8Array> {
  const chars = [...code.toUpperCase()].filter((c) => FONT[c]);
  const width = PAD * 2 + chars.length * (GLYPH_W + 1) * SCALE - SCALE;
  const height = PAD * 2 + GLYPH_H * SCALE;
  const img = new Raster(width, height);

  chars.forEach((char, index) => {
    const rows = FONT[char] as number[];
    const jitterY = Math.floor(random() * 3) - 1;
    const x0 = PAD + index * (GLYPH_W + 1) * SCALE;
    const y0 = PAD + jitterY * SCALE;
    rows.forEach((bits, row) => {
      for (let col = 0; col < GLYPH_W; col++) {
        if (!(bits & (1 << (GLYPH_W - 1 - col)))) continue;
        // One pixel in five is mid-tone: still readable, hostile to a clean
        // threshold pass.
        const color: [number, number, number] = random() < 0.2 ? [90, 105, 130] : INK;
        img.rect(x0 + col * SCALE, y0 + row * SCALE, SCALE, SCALE, color);
      }
    });
  });

  // Noise: speckles plus two slashes across the text.
  for (let i = 0; i < Math.floor((width * height) / 60); i++) {
    img.dot(Math.floor(random() * width), Math.floor(random() * height), [130, 140, 158]);
  }
  for (let line = 0; line < 2; line++) {
    let y = PAD + Math.floor(random() * (height - PAD * 2));
    for (let x = 0; x < width; x += 2) {
      img.rect(x, y, 2, 2, [120, 132, 152]);
      y += random() < 0.5 ? -1 : 1;
      y = Math.max(2, Math.min(height - 4, y));
    }
  }

  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  const source = img.bytes();
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(source.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  putU32(ihdr, 0, width);
  putU32(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
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
