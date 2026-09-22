/**
 * Performing one computer-mode action
 * (docs/specs/SPEC-use-computer.md §5.4, §5.5, §5.8, §10.2).
 *
 * The division of labour here is the whole design. This file owns everything
 * that touches the screen — mapping the model's image coordinates to logical
 * screen points, driving the adapter, waiting `desktop.settleMs` afterwards,
 * and polling the window list. It owns NOTHING about the run: `read`,
 * `assert`, `noop`, `prompt`, `return`, `fail`, `api_call` and `extract_value`
 * come back with `performed: false` so the caller's turn loop handles them the
 * way it already handles their page-surface twins (§5.4: "as today — they
 * touch no surface").
 *
 * `zoom` is the one action that changes what the model sees without touching
 * anything: it returns a new {@link ImageView} and makes no adapter call at
 * all (§5.3). For every other action the returned view is the one that was
 * current — the caller captures a fresh full screenshot for the next turn
 * (§5.3: "after any real action the next capture is a fresh full screenshot").
 */
import { logger } from '../utils/logger.js';
import type { DesktopAdapter, Point } from './adapter.js';
import { DEFAULT_MAX_IMAGE_WIDTH, mapToScreen, zoomView, type ImageView } from './capture.js';
import { SCREEN_ACTION_TYPES, type ComputerAction } from './actions.js';

/** §5.4 — how often `wait_window` asks the window list. */
export const WINDOW_POLL_INTERVAL_MS = 250;

export interface ComputerExecutionContext {
  adapter: DesktopAdapter;
  /** The image the model was looking at when it chose this action. */
  view: ImageView;
  /** §5.5 — how long to wait after any action that touches the screen. */
  settleMs: number;
  /** §5.10 — the longer side of a zoomed image. Defaults to 1600. */
  maxImageWidth?: number;
  /** Where the `[computer]` lines go. Defaults to `logger.info`. */
  log?: (message: string) => void;
  /** Injectable for tests, which must not spend real seconds proving a poll. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ComputerExecutionResult {
  /** The view the next turn should use: a new one after `zoom`, otherwise the
   *  one that came in (the caller re-captures after a screen action). */
  view: ImageView;
  /** True when this file handled the action. False means "your loop owns
   *  this one" — see the header. */
  performed: boolean;
  /** False when a performed action FAILED (no window matched, a wait timed
   *  out). Always true for `performed: false`, which is not a verdict. */
  ok: boolean;
  /** The logical screen point a pointer action reached, for the report's
   *  click marker (§10.1) and for the log line (§10.2). */
  screenPoint?: Point;
  /** Human- and model-readable detail. Present on every failure. */
  message?: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `click image(812,544) → screen(1746,1170)` — §10.2's line, verbatim. */
function pointerLine(verb: string, image: { x: number; y: number }, screen: Point): string {
  return `${verb} image(${image.x},${image.y}) → screen(${screen.x},${screen.y})`;
}

export async function executeComputerAction(
  action: ComputerAction,
  ctx: ComputerExecutionContext,
): Promise<ComputerExecutionResult> {
  const { adapter, view } = ctx;
  const sleep = ctx.sleep ?? defaultSleep;
  const now = ctx.now ?? Date.now;
  const log = ctx.log ?? ((message: string) => logger.info(message));
  const emit = (message: string): void => log(`[computer] ${message}`);

  const settle = async (): Promise<void> => {
    if (ctx.settleMs > 0) await sleep(ctx.settleMs);
  };

  if (!SCREEN_ACTION_TYPES.has(action.action) && action.action !== 'zoom') {
    // Not ours. Said once, here, rather than as a default case further down,
    // so the switch below reads as the list of things that DO touch a screen.
    return { view, performed: false, ok: true };
  }

  switch (action.action) {
    case 'click': {
      const screenPoint = mapToScreen({ x: action.x, y: action.y }, view);
      const extra =
        action.button === 'left' && action.count === 1
          ? ''
          : ` [${action.button}${action.count > 1 ? ` ×${action.count}` : ''}]`;
      emit(pointerLine('click', action, screenPoint) + extra);
      await adapter.click(screenPoint, { button: action.button, count: action.count });
      await settle();
      return { view, performed: true, ok: true, screenPoint };
    }

    case 'move': {
      const screenPoint = mapToScreen({ x: action.x, y: action.y }, view);
      emit(pointerLine('move', action, screenPoint));
      await adapter.move(screenPoint);
      await settle();
      return { view, performed: true, ok: true, screenPoint };
    }

    case 'drag': {
      const from = mapToScreen(action.from, view);
      const to = mapToScreen(action.to, view);
      emit(
        `drag image(${action.from.x},${action.from.y})→(${action.to.x},${action.to.y}) ` +
          `→ screen(${from.x},${from.y})→(${to.x},${to.y})`,
      );
      await adapter.drag(from, to);
      await settle();
      return { view, performed: true, ok: true, screenPoint: to };
    }

    case 'scroll': {
      const screenPoint = mapToScreen({ x: action.x, y: action.y }, view);
      emit(`${pointerLine('scroll', action, screenPoint)} ${action.direction} ×${action.amount}`);
      await adapter.scroll(screenPoint, action.direction, action.amount);
      await settle();
      return { view, performed: true, ok: true, screenPoint };
    }

    case 'type': {
      // The TEXT is not logged. There is no field name here to match against
      // `src/utils/secrets.ts`'s vocabulary — a computer-mode `type` into a
      // password box looks exactly like one into a filename box — so the only
      // safe thing to print is how much was typed.
      emit(`type ${action.text.length} character${action.text.length === 1 ? '' : 's'}`);
      await adapter.type(action.text);
      await settle();
      return { view, performed: true, ok: true };
    }

    case 'key': {
      emit(`key ${action.key}`);
      await adapter.key(action.key);
      await settle();
      return { view, performed: true, ok: true };
    }

    case 'wait': {
      emit(`wait ${action.seconds}s`);
      await sleep(Math.round(action.seconds * 1000));
      // No settle: the wait IS one, and doubling it would silently stretch
      // every author-requested pause by `settleMs`.
      return { view, performed: true, ok: true };
    }

    case 'zoom': {
      const zoomed = await zoomView(view, action.region, {
        maxImageWidth: ctx.maxImageWidth ?? DEFAULT_MAX_IMAGE_WIDTH,
      });
      const source = zoomed.region!;
      emit(
        `zoom image(${action.region.x},${action.region.y},${action.region.width},${action.region.height}) ` +
          `→ grab(${source.x},${source.y},${source.width},${source.height}) ` +
          `→ ${zoomed.imageWidth}×${zoomed.imageHeight}`,
      );
      // Nothing touched the screen, so nothing has to settle.
      return { view: zoomed, performed: true, ok: true };
    }

    case 'focus_window': {
      emit(`focus_window "${action.title}"`);
      const found = await adapter.focusWindow(action.title);
      if (!found) {
        const titles = (await adapter.windows()).map((w) => w.title).filter((t) => t.trim() !== '');
        const shown = titles.slice(0, 10);
        const suffix =
          shown.length === 0
            ? 'No windows were listed.'
            : `Open windows: ${shown.map((t) => JSON.stringify(t)).join(', ')}` +
              (titles.length > shown.length ? ` (+${titles.length - shown.length} more)` : '');
        return {
          view,
          performed: true,
          ok: false,
          message: `No window's title contains "${action.title}". ${suffix}`,
        };
      }
      await settle();
      return { view, performed: true, ok: true };
    }

    case 'wait_window': {
      emit(`wait_window "${action.title}" ${action.state} (${action.timeoutMs}ms)`);
      const needle = action.title.toLowerCase();
      const deadline = now() + action.timeoutMs;
      for (;;) {
        const windows = await adapter.windows();
        const present = windows.some((w) => w.title.toLowerCase().includes(needle));
        if (present === (action.state === 'open')) {
          await settle();
          return {
            view,
            performed: true,
            ok: true,
            message: `Window matching "${action.title}" is ${action.state}.`,
          };
        }
        if (now() >= deadline) {
          return {
            view,
            performed: true,
            ok: false,
            message:
              `Timed out after ${action.timeoutMs}ms waiting for a window whose title contains ` +
              `"${action.title}" to be ${action.state}.`,
          };
        }
        await sleep(WINDOW_POLL_INTERVAL_MS);
      }
    }

    default:
      // Every remaining member is one the run loop owns, and the guard above
      // already answered for it.
      return { view, performed: false, ok: true };
  }
}
