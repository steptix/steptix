/**
 * Capture, zoom and the image→screen mapping
 * (docs/specs/SPEC-use-computer.md §5.2, §5.3; acceptance §13.1 "`mapToScreen`
 * table").
 *
 * §5.2 names the two factors and asks for a unit test "for a Retina-style
 * density of 2, a downscale, and both together". The fourth case here is the
 * one the spec only implies and the one a wrong implementation passes the
 * other three without: a point inside a ZOOMED image must map to the same
 * screen point as the corresponding point in the full image. That is the whole
 * promise of §5.3 — "a click after a zoom lands where the model pointed" — and
 * it is the case where an implementation that folds the crop into the scale
 * factor instead of into the origin gives a plausible, wrong answer.
 *
 * Grabs here are small. Nothing in the mapping cares about the size, and a
 * real 3440×1440 RGBA buffer is 20 MB to allocate and a second to PNG-encode
 * per case. The 3440×1440 numbers DO appear — in the table cases, which build
 * a view directly and never encode anything.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_IMAGE_WIDTH,
  captureView,
  mapToScreen,
  viewFromGrab,
  viewSourceRect,
  zoomView,
  type ImageView,
} from '../src/desktop/capture.js';
import { FakeDesktopAdapter, makeFakeGrab } from '../src/desktop/fake-adapter.js';
import type { ScreenGrab } from '../src/desktop/adapter.js';

/** A view with no pixels behind it — everything `mapToScreen` reads. */
function view(grab: Partial<ScreenGrab>, imageWidth: number, imageHeight: number): ImageView {
  return {
    pngBase64: '',
    imageWidth,
    imageHeight,
    kind: 'full',
    grab: {
      width: grab.width ?? imageWidth,
      height: grab.height ?? imageHeight,
      scaleX: grab.scaleX ?? 1,
      scaleY: grab.scaleY ?? 1,
      rgba: Buffer.alloc(0),
    },
  };
}

/** Read a PNG's own IHDR dimensions, so the assertion is about the bytes the
 *  model will be sent rather than about the fields we wrote beside them. */
function pngSize(base64: string): { width: number; height: number } {
  const bytes = Buffer.from(base64, 'base64');
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('mapToScreen — §5.2, the two factors', () => {
  it('density 1, no downscale: the image IS the screen', () => {
    expect(mapToScreen({ x: 400, y: 300 }, view({ width: 800, height: 600 }, 800, 600))).toEqual({
      x: 400,
      y: 300,
    });
  });

  it('density 2, no downscale: physical halves into logical', () => {
    // A Retina-style display: the grab is 800×600 physical pixels of a 400×300
    // logical screen, and the image was not resized.
    expect(
      mapToScreen(
        { x: 400, y: 300 },
        view({ width: 800, height: 600, scaleX: 2, scaleY: 2 }, 800, 600),
      ),
    ).toEqual({ x: 200, y: 150 });
  });

  it('density 1, downscaled 3440 → 1600: the image factor alone', () => {
    // 1440 × 1600/3440 = 669.767 → the encoder rounds to 670, and the mapping
    // must use the SAME 670 rather than the exact ratio.
    const full = view({ width: 3440, height: 1440 }, 1600, 670);
    expect(mapToScreen({ x: 800, y: 335 }, full)).toEqual({ x: 1720, y: 720 });
    expect(mapToScreen({ x: 0, y: 0 }, full)).toEqual({ x: 0, y: 0 });
    expect(mapToScreen({ x: 1600, y: 670 }, full)).toEqual({ x: 3440, y: 1440 });
  });

  it('both together: downscale THEN density', () => {
    const full = view({ width: 3440, height: 1440, scaleX: 2, scaleY: 2 }, 1600, 670);
    expect(mapToScreen({ x: 800, y: 335 }, full)).toEqual({ x: 860, y: 360 });
  });

  it('non-square density: x and y use their own factor', () => {
    expect(
      mapToScreen(
        { x: 100, y: 100 },
        view({ width: 400, height: 400, scaleX: 2, scaleY: 4 }, 200, 200),
      ),
    ).toEqual({ x: 100, y: 50 });
  });

  it('rounds to whole logical points — a mouse takes no fractions', () => {
    // 101 × (300/200) = 151.5 → 152.
    expect(mapToScreen({ x: 101, y: 0 }, view({ width: 300, height: 300 }, 200, 200))).toEqual({
      x: 152,
      y: 0,
    });
  });

  it('treats a density of 0 as 1 rather than mapping everything to Infinity', () => {
    // A provider that left `pixelDensity` unset, or a fake built by hand. The
    // alternative is not a wrong click but a click at Infinity, which lands in
    // a screen corner with nothing in the log to say why.
    expect(
      mapToScreen({ x: 10, y: 10 }, view({ width: 100, height: 100, scaleX: 0, scaleY: 0 }, 100, 100)),
    ).toEqual({ x: 10, y: 10 });
  });
});

describe('captureView — §5.2', () => {
  it('downscales so the LONGER side is the cap, and says so in the PNG', async () => {
    const adapter = new FakeDesktopAdapter({ width: 344, height: 144 });
    const captured = await captureView(adapter, { maxImageWidth: 160 });

    // 144 × 160/344 = 66.98 → 67.
    expect({ width: captured.imageWidth, height: captured.imageHeight }).toEqual({
      width: 160,
      height: 67,
    });
    expect(pngSize(captured.pngBase64)).toEqual({ width: 160, height: 67 });
    expect(captured.kind).toBe('full');
    expect(captured.region).toBeUndefined();
    // The FULL-resolution grab travels with the view — that is what a later
    // zoom crops out of (§5.3).
    expect(captured.grab.width).toBe(344);
    expect(adapter.callsOf('grab')).toHaveLength(1);
  });

  it('caps the height when the screen is taller than it is wide', async () => {
    const view = await viewFromGrab(makeFakeGrab({ width: 100, height: 400 }), {
      maxImageWidth: 200,
    });
    expect({ width: view.imageWidth, height: view.imageHeight }).toEqual({ width: 50, height: 200 });
  });

  it('never UPSCALES a full grab', async () => {
    // A small screen, or a big cap. Stretching it would cost bytes and add no
    // detail — there is none to add.
    const view = await viewFromGrab(makeFakeGrab({ width: 100, height: 50 }), {
      maxImageWidth: 1600,
    });
    expect({ width: view.imageWidth, height: view.imageHeight }).toEqual({ width: 100, height: 50 });
    expect(pngSize(view.pngBase64)).toEqual({ width: 100, height: 50 });
  });

  it('refuses a grab whose buffer is the wrong length', async () => {
    const grab = makeFakeGrab({ width: 10, height: 10 });
    await expect(
      viewFromGrab({ ...grab, rgba: grab.rgba.subarray(0, 40) }, { maxImageWidth: 100 }),
    ).rejects.toThrow(/10×10 RGBA needs 400/);
  });

  it('defaults the cap to 1600 (§5.10)', () => {
    expect(DEFAULT_MAX_IMAGE_WIDTH).toBe(1600);
  });
});

describe('zoomView — §5.3', () => {
  it('upscales the crop and records the region in GRAB space', async () => {
    const full = await viewFromGrab(makeFakeGrab({ width: 320, height: 160 }), {
      maxImageWidth: 160,
    });
    expect({ width: full.imageWidth, height: full.imageHeight }).toEqual({ width: 160, height: 80 });

    // The region as the MODEL sees it: in the 160×80 image it was shown.
    const zoomed = await zoomView(full, { x: 10, y: 10, width: 40, height: 20 }, {
      maxImageWidth: 160,
    });

    // Crop in the 320×160 grab, then scaled UP so its longer side is the cap.
    expect(zoomed.region).toEqual({ x: 20, y: 20, width: 80, height: 40 });
    expect({ width: zoomed.imageWidth, height: zoomed.imageHeight }).toEqual({
      width: 160,
      height: 80,
    });
    expect(pngSize(zoomed.pngBase64)).toEqual({ width: 160, height: 80 });
    expect(zoomed.kind).toBe('zoom');
    // The model's own numbers, kept for §5.3's note.
    expect(zoomed.requestedRegion).toEqual({ x: 10, y: 10, width: 40, height: 20 });
    // No new grab: the same pixels, cropped.
    expect(zoomed.grab).toBe(full.grab);
  });

  it('maps a point in the zoom to the SAME screen point as the full image', async () => {
    // §5.3's promise, and the case the other three in the mapToScreen table
    // all pass without. Full image 160×80 over a 320×160 grab; the zoom is the
    // grab rectangle (20,20)–(100,60) shown at 160×80.
    const full = await viewFromGrab(makeFakeGrab({ width: 320, height: 160 }), {
      maxImageWidth: 160,
    });
    const zoomed = await zoomView(full, { x: 10, y: 10, width: 40, height: 20 }, {
      maxImageWidth: 160,
    });

    const viaZoom = mapToScreen({ x: 40, y: 20 }, zoomed);
    const viaFull = mapToScreen({ x: 20, y: 15 }, full);
    expect(viaZoom).toEqual({ x: 40, y: 30 });
    expect(viaZoom).toEqual(viaFull);
  });

  it('zooming a zoom still crops the ORIGINAL grab', async () => {
    const full = await viewFromGrab(makeFakeGrab({ width: 320, height: 160 }), {
      maxImageWidth: 160,
    });
    const once = await zoomView(full, { x: 10, y: 10, width: 40, height: 20 }, {
      maxImageWidth: 160,
    });
    const twice = await zoomView(once, { x: 80, y: 40, width: 40, height: 20 }, {
      maxImageWidth: 160,
    });

    // once covers grab (20,20,80,40) at 160×80, so half an image pixel of
    // grab: (80,40) in it is grab (20+40, 20+20) = (60, 40).
    expect(twice.region).toEqual({ x: 60, y: 40, width: 20, height: 10 });
    expect(twice.grab).toBe(full.grab);
    expect(mapToScreen({ x: 0, y: 0 }, twice)).toEqual({ x: 60, y: 40 });
  });

  it('clamps a region that overshoots the image rather than refusing it', async () => {
    const full = await viewFromGrab(makeFakeGrab({ width: 160, height: 80 }), {
      maxImageWidth: 160,
    });
    const zoomed = await zoomView(full, { x: 140, y: 70, width: 100, height: 100 }, {
      maxImageWidth: 80,
    });
    expect(zoomed.region).toEqual({ x: 140, y: 70, width: 20, height: 10 });
  });

  it('refuses a region entirely outside the image', async () => {
    const full = await viewFromGrab(makeFakeGrab({ width: 160, height: 80 }), {
      maxImageWidth: 160,
    });
    await expect(
      zoomView(full, { x: 500, y: 500, width: 10, height: 10 }, { maxImageWidth: 160 }),
    ).rejects.toThrow(/outside the 160×80 image/);
  });

  it('viewSourceRect is the whole grab for a full view', async () => {
    const full = await viewFromGrab(makeFakeGrab({ width: 40, height: 20 }), {
      maxImageWidth: 40,
    });
    expect(viewSourceRect(full)).toEqual({ x: 0, y: 0, width: 40, height: 20 });
  });
});
