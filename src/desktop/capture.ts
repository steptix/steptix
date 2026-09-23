/**
 * Capture, zoom and the coordinate mapping between them
 * (docs/specs/SPEC-use-computer.md §5.2, §5.3).
 *
 * The model never sees the framebuffer. It sees a PNG that has been downscaled
 * so its longer side is at most `desktop.maxImageWidth`, and it answers in
 * that image's pixel space. Two factors stand between its answer and the
 * mouse, and both live in {@link mapToScreen}:
 *
 * ```
 * physical = source.origin + image × (source.size / image.size)
 * logical  = physical / grab.scaleX            (and scaleY for y)
 * ```
 *
 * `source` is the rectangle of the FULL-RESOLUTION grab the image was made
 * from: the whole grab for a full view, the crop rectangle for a zoomed one
 * (§5.3). Writing it that way is what makes a click after a zoom land where
 * the model pointed — the zoom is not a special case in the mapping, only a
 * different source rectangle.
 *
 * An {@link ImageView} carries the grab it came from, at full resolution, for
 * exactly that reason: a zoom crops out of the pixels already held rather than
 * grabbing again, so it costs a model turn and nothing on the screen.
 */
import Jimp from 'jimp';
import type { DesktopAdapter, ImageRegion, Point, ScreenGrab } from './adapter.js';

/** §5.10 — the default longer side of the image the model is shown. */
export const DEFAULT_MAX_IMAGE_WIDTH = 1600;

export interface CaptureOptions {
  /** The longer side, in pixels, of the image handed to the model. A full
   *  grab smaller than this is NOT upscaled; a zoom is (§5.3). */
  maxImageWidth: number;
}

/**
 * One image the model has been, or is about to be, shown — plus everything
 * needed to turn a point in it back into a screen point.
 */
export interface ImageView {
  /** The PNG the model sees, base64, no data: prefix. */
  pngBase64: string;
  /** The PNG's own pixel size — the space the model answers in. */
  imageWidth: number;
  imageHeight: number;
  /** The full-resolution capture this image was derived from. Kept so a zoom
   *  can crop out of real pixels instead of an already-downscaled image. */
  grab: ScreenGrab;
  /** For a zoomed view, the crop rectangle in the GRAB's physical pixel
   *  space. Absent on a full view, where the source is the whole grab. */
  region?: ImageRegion;
  /** For a zoomed view, the region as the MODEL asked for it — in the
   *  coordinates of the image it was looking at when it asked. This is what
   *  §5.3's note quotes back, because those are the numbers it wrote. */
  requestedRegion?: ImageRegion;
  kind: 'full' | 'zoom';
}

/** The rectangle of `view.grab` that `view`'s image was made from. */
export function viewSourceRect(view: ImageView): ImageRegion {
  return view.region ?? { x: 0, y: 0, width: view.grab.width, height: view.grab.height };
}

/**
 * §5.2's two factors, in one function. `imagePoint` is in the CURRENT image's
 * pixel space; the result is a logical screen point, which is what nut.js's
 * mouse takes.
 */
export function mapToScreen(imagePoint: { x: number; y: number }, view: ImageView): Point {
  const source = viewSourceRect(view);
  const perImageX = view.imageWidth > 0 ? source.width / view.imageWidth : 1;
  const perImageY = view.imageHeight > 0 ? source.height / view.imageHeight : 1;

  const physicalX = source.x + imagePoint.x * perImageX;
  const physicalY = source.y + imagePoint.y * perImageY;

  // A grab with no density reported is density 1. Guarding against 0 here is
  // not defensive noise: a fake or a provider that left the field unset would
  // otherwise map every point to Infinity and click a corner of the screen.
  const scaleX = view.grab.scaleX > 0 ? view.grab.scaleX : 1;
  const scaleY = view.grab.scaleY > 0 ? view.grab.scaleY : 1;

  return { x: Math.round(physicalX / scaleX), y: Math.round(physicalY / scaleY) };
}

/** Build a jimp image over a grab's pixels. The buffer is copied: jimp's
 *  resize and crop mutate the bitmap in place, and a grab may be cropped more
 *  than once (a zoom of a zoom). */
function jimpFromGrab(grab: ScreenGrab): Jimp {
  const expected = grab.width * grab.height * 4;
  if (grab.rgba.length !== expected) {
    throw new Error(
      `Screen grab is ${grab.rgba.length} bytes but ${grab.width}×${grab.height} RGBA needs ${expected}`,
    );
  }
  return new Jimp({ data: Buffer.from(grab.rgba), width: grab.width, height: grab.height });
}

/** The size an image of `width`×`height` is shown at, given the longer-side
 *  cap and whether upscaling is allowed. */
function fitTo(
  width: number,
  height: number,
  maxImageWidth: number,
  allowUpscale: boolean,
): { width: number; height: number } {
  const longer = Math.max(width, height);
  if (longer <= 0) return { width: Math.max(1, width), height: Math.max(1, height) };
  if (!allowUpscale && longer <= maxImageWidth) return { width, height };

  const factor = maxImageWidth / longer;
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

async function toPngBase64(image: Jimp): Promise<string> {
  const buffer = await image.getBufferAsync(Jimp.MIME_PNG);
  return buffer.toString('base64');
}

/**
 * Encode a grab as the full-screen view the model is shown: downscaled so the
 * longer side is at most `maxImageWidth`, never upscaled.
 *
 * Separate from {@link captureView} so the executor can re-encode a grab it
 * already holds, and so tests can build a view from a synthetic grab with no
 * adapter in the picture.
 */
export async function viewFromGrab(grab: ScreenGrab, opts: CaptureOptions): Promise<ImageView> {
  const size = fitTo(grab.width, grab.height, opts.maxImageWidth, false);

  let image = jimpFromGrab(grab);
  if (size.width !== grab.width || size.height !== grab.height) {
    image = image.resize(size.width, size.height);
  }

  return {
    pngBase64: await toPngBase64(image),
    imageWidth: size.width,
    imageHeight: size.height,
    grab,
    kind: 'full',
  };
}

/** Grab the primary display and encode it as the next turn's image (§5.2). */
export async function captureView(
  adapter: DesktopAdapter,
  opts: CaptureOptions,
): Promise<ImageView> {
  return viewFromGrab(await adapter.grab(), opts);
}

/**
 * §5.3 — crop `region` (in the coordinates of the image `previous` showed the
 * model) out of the FULL-RESOLUTION grab `previous` holds, and scale it so its
 * longer side is `maxImageWidth`. Upscaling is the point: this is what makes a
 * dialog's small text readable in a downscaled 4K desktop.
 *
 * Nothing on the screen is touched, and no new grab is taken — the returned
 * view shares `previous.grab`, so a zoom of a zoom still crops real pixels.
 */
export async function zoomView(
  previous: ImageView,
  region: ImageRegion,
  opts: CaptureOptions,
): Promise<ImageView> {
  const clamped = clampToImage(region, previous);
  const source = toGrabRect(clamped, previous);

  const cropped = jimpFromGrab(previous.grab).crop(
    source.x,
    source.y,
    source.width,
    source.height,
  );
  const size = fitTo(source.width, source.height, opts.maxImageWidth, true);
  const scaled =
    size.width === source.width && size.height === source.height
      ? cropped
      : cropped.resize(size.width, size.height);

  return {
    pngBase64: await toPngBase64(scaled),
    imageWidth: size.width,
    imageHeight: size.height,
    grab: previous.grab,
    region: source,
    requestedRegion: { ...region },
    kind: 'zoom',
  };
}

/**
 * Keep a requested region inside the image it was expressed in.
 *
 * Two different mistakes, answered two different ways. A region that OVERLAPS
 * the image and runs off an edge is clamped: the model named a readable
 * rectangle and got its width a little wrong, and refusing would spend a turn
 * teaching it bounds it was already told. A region that does not overlap the
 * image AT ALL is refused, with the image size in the message — clamping that
 * one produces a one-pixel crop blown up to full size, which is a turn spent
 * looking at a corner with nothing to say why.
 */
function clampToImage(region: ImageRegion, view: ImageView): ImageRegion {
  for (const [name, value] of Object.entries(region)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`zoom region.${name} must be a finite number (got ${JSON.stringify(value)})`);
    }
  }
  const outside =
    region.width <= 0 ||
    region.height <= 0 ||
    region.x >= view.imageWidth ||
    region.y >= view.imageHeight ||
    region.x + region.width <= 0 ||
    region.y + region.height <= 0;
  if (outside) {
    throw new Error(
      `zoom region (${region.x}, ${region.y}, ${region.width}, ${region.height}) is outside the ` +
        `${view.imageWidth}×${view.imageHeight} image`,
    );
  }

  const x = Math.max(0, region.x);
  const y = Math.max(0, region.y);
  const width = Math.min(region.width - (x - region.x), view.imageWidth - x);
  const height = Math.min(region.height - (y - region.y), view.imageHeight - y);
  return { x, y, width, height };
}

/** A rectangle in `view`'s image space → the same rectangle in the grab's
 *  physical pixel space, rounded to whole pixels (which is what can actually
 *  be cropped) and clamped to the grab. */
function toGrabRect(region: ImageRegion, view: ImageView): ImageRegion {
  const source = viewSourceRect(view);
  const perImageX = view.imageWidth > 0 ? source.width / view.imageWidth : 1;
  const perImageY = view.imageHeight > 0 ? source.height / view.imageHeight : 1;

  const x = Math.max(0, Math.min(view.grab.width - 1, Math.round(source.x + region.x * perImageX)));
  const y = Math.max(0, Math.min(view.grab.height - 1, Math.round(source.y + region.y * perImageY)));
  const width = Math.max(1, Math.min(view.grab.width - x, Math.round(region.width * perImageX)));
  const height = Math.max(1, Math.min(view.grab.height - y, Math.round(region.height * perImageY)));
  return { x, y, width, height };
}
