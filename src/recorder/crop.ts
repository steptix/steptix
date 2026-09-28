import Jimp from 'jimp';
import type { ActionCrop, Box } from './types.js';

/**
 * The picture that goes with one recorded action (stories/testbench-record-steps.md,
 * decision 6): a crop of the viewport around the target, the target's box drawn
 * on it, scaled down.
 *
 * A crop rather than the whole viewport because what the model needs is the
 * NEIGHBOURHOOD of the thing the author touched — the row an identical "Edit"
 * link sits in, the card an icon belongs to — and forty full screenshots would
 * cost more than every description put together.
 */

/** Room kept around the target on every side, in CSS pixels. */
const MARGIN_PX = 140;
/** The crop is never smaller than this (when the viewport allows), so a tiny
 *  icon still comes with its surroundings. */
const MIN_CROP = { width: 520, height: 320 };
/** Longer side of the picture the model is shown. */
export const MAX_CROP_SIDE_PX = 640;
/** The outline drawn round the target: colour (RGBA) and thickness. */
const OUTLINE_RGBA = 0xe0245eff;
/** What a secret field is painted over with: solid, and nothing like the
 *  outline, so the model reads it as "hidden", not as "this one". */
const PAINT_RGBA = 0x2b2b2bff;
const OUTLINE_PX = 3;

/** Clamp `[start, start+size)` into `[0, limit)` without shrinking it below
 *  what fits. */
function clampSpan(start: number, size: number, limit: number): { start: number; size: number } {
  const s = Math.min(size, limit);
  let a = Math.round(start);
  if (a < 0) a = 0;
  if (a + s > limit) a = limit - s;
  return { start: Math.max(0, a), size: Math.max(1, s) };
}

/**
 * Crop `png` (a viewport screenshot at CSS scale) around `box`, outline the box
 * and scale the result so its longer side is at most {@link MAX_CROP_SIDE_PX}.
 *
 * Null when the box is not on the screenshot at all — a target scrolled out of
 * view by the time the picture was taken says nothing useful about itself.
 *
 * `paintOut` are page boxes to cover with a solid fill BEFORE anything is kept:
 * every secret field on screen (a toggled password box shows its value in
 * clear) and every field whose value is a secret the run knows. Painted on the
 * whole screenshot, so no crop or scale can bring the pixels back.
 */
export async function cropAround(png: Buffer, box: Box, paintOut: readonly Box[] = []): Promise<ActionCrop | null> {
  const image = await Jimp.read(png);
  const W = image.bitmap.width;
  const H = image.bitmap.height;
  if (W <= 0 || H <= 0) return null;
  for (const r of paintOut) paintBox(image, r);
  // Off the picture entirely.
  if (box.x >= W || box.y >= H || box.x + box.width <= 0 || box.y + box.height <= 0) return null;

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const wantW = Math.max(MIN_CROP.width, box.width + 2 * MARGIN_PX);
  const wantH = Math.max(MIN_CROP.height, box.height + 2 * MARGIN_PX);
  const sx = clampSpan(cx - wantW / 2, wantW, W);
  const sy = clampSpan(cy - wantH / 2, wantH, H);

  const cropped = image.crop(sx.start, sy.start, sx.size, sy.size);

  // The box in crop coordinates, clamped to the crop.
  const bx0 = Math.max(0, Math.round(box.x - sx.start));
  const by0 = Math.max(0, Math.round(box.y - sy.start));
  const bx1 = Math.min(sx.size - 1, Math.round(box.x + box.width - sx.start));
  const by1 = Math.min(sy.size - 1, Math.round(box.y + box.height - sy.start));
  drawOutline(cropped, bx0, by0, bx1, by1);

  const longer = Math.max(sx.size, sy.size);
  const factor = longer > MAX_CROP_SIDE_PX ? MAX_CROP_SIDE_PX / longer : 1;
  const outW = Math.max(1, Math.round(sx.size * factor));
  const outH = Math.max(1, Math.round(sy.size * factor));
  const scaled = factor === 1 ? cropped : cropped.resize(outW, outH);
  const buffer = await scaled.getBufferAsync(Jimp.MIME_PNG);

  return {
    dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
    width: outW,
    height: outH,
    boxInCrop: {
      x: Math.round(bx0 * factor),
      y: Math.round(by0 * factor),
      width: Math.max(1, Math.round((bx1 - bx0) * factor)),
      height: Math.max(1, Math.round((by1 - by0) * factor)),
    },
    pageBox: { ...box },
  };
}

/** Cover a page box with a solid fill, clamped to the image. */
function paintBox(image: Jimp, r: Box): void {
  const W = image.bitmap.width;
  const H = image.bitmap.height;
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(W, Math.ceil(r.x + r.width));
  const y1 = Math.min(H, Math.ceil(r.y + r.height));
  if (x1 <= x0 || y1 <= y0) return;
  image.scan(x0, y0, x1 - x0, y1 - y0, function (this: Jimp, _x: number, _y: number, idx: number) {
    this.bitmap.data.writeUInt32BE(PAINT_RGBA, idx);
  });
}

/** A rectangle outline, OUTLINE_PX thick, drawn inward from the box's edge
 *  where there is no room outside it. */
function drawOutline(image: Jimp, x0: number, y0: number, x1: number, y1: number): void {
  const W = image.bitmap.width;
  const H = image.bitmap.height;
  const set = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < W && y < H) image.setPixelColor(OUTLINE_RGBA, x, y);
  };
  for (let t = 0; t < OUTLINE_PX; t++) {
    for (let x = x0 - t; x <= x1 + t; x++) {
      set(x, y0 - t);
      set(x, y1 + t);
    }
    for (let y = y0 - t; y <= y1 + t; y++) {
      set(x0 - t, y);
      set(x1 + t, y);
    }
  }
}
