/**
 * Long-screenshot slicing — Node only.
 *
 * `sharp` is a native module, so this file is imported by `node.ts` and by
 * nothing else. The Worker bundle never sees it: `wrangler deploy --dry-run`
 * plus a grep for `sharp` in the output is how that is verified, because a
 * missing native binding at the edge is a deploy-time failure, not a runtime
 * one.
 */
import sharp from "sharp";

export type Slice = { index: number; data: Uint8Array; width: number; height: number };

export type SliceResult = {
  slices: Slice[];
  /** How many strips the image would need in total. */
  total: number;
  /** True when `maxSlices` cut the job short — the caller must say so. */
  truncated: boolean;
  width: number;
  height: number;
};

export const MAX_SLICES = 10;

/**
 * Cut an image into readable vertical strips.
 *
 * A 400×18000 screenshot becomes ten 1800px strips instead of one unreadable
 * sliver. No overlap: an overlap looks nicer when scrolling but duplicates
 * text, and the point here is legibility.
 */
export async function sliceImage(bytes: Uint8Array, sliceHeight = 1800, maxSlices = MAX_SLICES): Promise<SliceResult> {
  const image = sharp(bytes, { limitInputPixels: 268_402_689 });
  const meta = await image.metadata();
  if (!meta.width || !meta.height) throw new Error("读不出图片尺寸");

  // EXIF orientation is display-only: a phone screenshot stored 4000×40 with
  // orientation 6 is a 40×4000 image to the reader. Normalise once so the
  // strips are cut along the axis people actually see.
  const swapped = typeof meta.orientation === "number" && meta.orientation >= 5;
  const width = swapped ? meta.height : meta.width;
  const height = swapped ? meta.width : meta.height;
  if (height <= sliceHeight) throw new Error(`图片只有 ${height}px 高，不需要切分`);

  const source = swapped ? new Uint8Array(await sharp(bytes).rotate().toBuffer()) : bytes;

  const total = Math.ceil(height / sliceHeight);
  const emit = Math.min(total, maxSlices);
  const out: Slice[] = [];
  for (let index = 0; index < emit; index++) {
    const top = index * sliceHeight;
    const sliceH = Math.min(sliceHeight, height - top);
    if (sliceH <= 0) break;
    const data = await sharp(source)
      .extract({ left: 0, top, width, height: sliceH })
      .png()
      .toBuffer();
    out.push({ index: index + 1, data: new Uint8Array(data), width, height: sliceH });
  }
  return { slices: out, total, truncated: total > emit, width, height };
}
