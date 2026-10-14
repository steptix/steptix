/**
 * The interaction highlight for code Steptix did not write the calls of:
 * compiled code-behind entries and fixture tools
 * (docs/specs/SPEC-interaction-highlight.md §2.3, phase 3).
 *
 * An entry's `run(ctx)` and a tool's `run(ctx)` drive Playwright directly —
 * `page.locator(…).click()` — so nothing passes through `executeAction` to
 * mark. Instead the `page` they are handed is a `Proxy` that marks before
 * each call that acts or reads, and hands back proxies for whatever locators,
 * frame locators and frames it creates, so a chain of any length is covered.
 *
 * **Best effort, by design (§2.3).** What escapes it:
 *   - pages reached around it — `ctx.context.pages()`, `ctx.browser.contexts()`,
 *     an `ElementHandle` from `locator.elementHandle()`;
 *   - input with no element — `page.mouse` / `page.keyboard` at coordinates;
 *   - acting inside the page — `page.evaluate(() => el.click())`.
 * Generated code rarely uses any of these; src/codebehind/entry-actions.ts
 * already classifies them as acting calls the review pass watches.
 *
 * Three properties the wrapper has to keep, each because something reads it:
 *   - **Playwright's own reads of its arguments.** `dragTo(target)`,
 *     `and(other)`, `or(other)` and `{ has: locator }` read `_frame` and
 *     `_selector` off the locator they are given. Proxied arguments are
 *     unwrapped before the call, and property reads on a proxy reach the
 *     target anyway, so either way Playwright sees its own object.
 *   - **`instanceof` and identity.** A proxy's prototype is its target's, and
 *     one target always yields the same proxy (a WeakMap per sink), so
 *     `proxy instanceof Locator` holds and `ctx.page === await ctx.tabs.active()`
 *     compares two proxies of one page as equal. Steptix's own trackers never
 *     see a proxy: the tab and browser APIs take strings, events hand out the
 *     real objects, and the run reads its own page after the entry ends.
 *   - **No recursion.** Every method runs on the TARGET, and every mark is
 *     made on a target locator, so neither Playwright's internal calls (a
 *     locator's `click` is its frame's `click`) nor the ring's own
 *     `evaluateAll` pass through a proxy again.
 */
import type { Locator, Page } from 'playwright';
import { HIGHLIGHT_MANY_MAX, type HighlightKind, type HighlightSink, type MarkOptions } from './highlight.js';

/** Locator methods that act on the element (§2.3). `dragTo` marks its target too. */
const LOCATOR_ACTS = new Set([
  'click', 'dblclick', 'tap', 'fill', 'type', 'pressSequentially', 'press', 'check',
  'uncheck', 'setChecked', 'selectOption', 'hover', 'setInputFiles', 'dragTo',
]);

/** Locator methods that read the element, and the plural ones capped at
 *  {@link HIGHLIGHT_MANY_MAX} like a read of every match (§5.3). */
const LOCATOR_READS = new Set(['textContent', 'innerText', 'inputValue', 'getAttribute']);
const LOCATOR_READS_MANY = new Set(['allTextContents', 'allInnerTexts', 'count']);

/** The selector-taking shorthands on Page and Frame: `page.click(selector)`. */
const SHORTHAND_ACTS = new Set([
  'click', 'dblclick', 'tap', 'fill', 'type', 'press', 'check', 'uncheck', 'setChecked',
  'selectOption', 'hover', 'setInputFiles',
]);
const SHORTHAND_READS = new Set(['textContent', 'innerText', 'inputValue', 'getAttribute']);

/** The Playwright client classes the wrapper hands out proxies for, by their
 *  class name: the package exports types for them but no values to test
 *  `instanceof` against. */
type Kind = 'Page' | 'Frame' | 'Locator' | 'FrameLocator';
const KINDS = new Set<string>(['Page', 'Frame', 'Locator', 'FrameLocator']);

function kindOf(value: unknown): Kind | null {
  if (typeof value !== 'object' || value === null) return null;
  const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === 'string' && KINDS.has(name) ? (name as Kind) : null;
}

/** One sink's proxies: target → proxy, proxy → target, and each target's
 *  wrapped methods, so `proxy.click === proxy.click`. */
interface Registry {
  sink: HighlightSink;
  proxies: WeakMap<object, object>;
  targets: WeakMap<object, object>;
  methods: WeakMap<object, Map<PropertyKey, unknown>>;
}

/** The registry each sink keeps, so every wrap through one sink shares it. */
const registries = new WeakMap<HighlightSink, Registry>();

function registryFor(sink: HighlightSink): Registry {
  let registry = registries.get(sink);
  if (registry === undefined) {
    registry = { sink, proxies: new WeakMap(), targets: new WeakMap(), methods: new WeakMap() };
    registries.set(sink, registry);
  }
  return registry;
}

/** The real object behind a proxy this registry made, or the value itself. */
function unwrap(registry: Registry, value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  return registry.targets.get(value) ?? value;
}

/** Arguments with any proxy replaced by its target — at the top level, and
 *  one level into a plain options object, where `{ has, hasNot }` live. */
function unwrapArgs(registry: Registry, args: unknown[]): unknown[] {
  return args.map((arg) => {
    const direct = unwrap(registry, arg);
    if (direct !== arg) return direct;
    if (typeof arg !== 'object' || arg === null || Array.isArray(arg)) return arg;
    if (Object.getPrototypeOf(arg) !== Object.prototype) return arg;
    let copy: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(arg)) {
      const inner = unwrap(registry, value);
      if (inner !== value) {
        copy ??= { ...(arg as Record<string, unknown>) };
        copy[key] = inner;
      }
    }
    return copy ?? arg;
  });
}

/** A result, with any Playwright object in it (or in the array it is, or
 *  that it resolves to) swapped for its proxy. */
function wrapResult(registry: Registry, result: unknown): unknown {
  if (result instanceof Promise) return result.then((value) => wrapResult(registry, value));
  if (Array.isArray(result)) return result.some((v) => kindOf(v) !== null) ? result.map((v) => wrapResult(registry, v)) : result;
  return kindOf(result) !== null ? wrap(registry, result as object) : result;
}

function mark(registry: Registry, locator: Locator, kind: HighlightKind, max?: number, settled?: Promise<boolean>): void {
  try {
    registry.sink.mark(locator, kind, max, settled ? ({ settled } satisfies MarkOptions) : undefined);
  } catch {
    // A ring never fails the code it decorates.
  }
}

/** Mark what this call is about to act on or read, if anything. */
function markBefore(
  registry: Registry,
  target: object,
  kind: Kind,
  prop: string,
  args: unknown[],
  settled: Promise<boolean>,
): void {
  if (kind === 'Locator') {
    const locator = target as Locator;
    if (LOCATOR_ACTS.has(prop)) {
      mark(registry, locator, 'act', undefined, settled);
      if (prop === 'dragTo' && kindOf(args[0]) === 'Locator') mark(registry, args[0] as Locator, 'act', undefined, settled);
    } else if (LOCATOR_READS.has(prop)) {
      mark(registry, locator, 'read', undefined, settled);
    } else if (LOCATOR_READS_MANY.has(prop)) {
      mark(registry, locator, 'read', HIGHLIGHT_MANY_MAX);
    }
    return;
  }
  if (kind !== 'Page' && kind !== 'Frame') return;
  const owner = target as Pick<Page, 'locator'>;
  // The shorthands act on the first match, not strictly; so does the ring.
  const at = (selector: unknown): Locator | null =>
    typeof selector === 'string' ? owner.locator(selector).first() : null;
  if (prop === 'dragAndDrop') {
    for (const selector of [args[0], args[1]]) {
      const locator = at(selector);
      if (locator) mark(registry, locator, 'act', undefined, settled);
    }
    return;
  }
  const locator = SHORTHAND_ACTS.has(prop) || SHORTHAND_READS.has(prop) ? at(args[0]) : null;
  if (locator) mark(registry, locator, SHORTHAND_ACTS.has(prop) ? 'act' : 'read', undefined, settled);
}

function wrap<T extends object>(registry: Registry, target: T): T {
  // Already one of ours: wrapping it again would mark every call twice.
  if (registry.targets.has(target)) return target;
  const existing = registry.proxies.get(target);
  if (existing !== undefined) return existing as T;
  const kind = kindOf(target);
  if (kind === null) return target;
  const methods = new Map<PropertyKey, unknown>();
  registry.methods.set(target, methods);
  const proxy = new Proxy(target, {
    get(t, prop) {
      const value: unknown = Reflect.get(t, prop, t);
      // `constructor` is a class, not a method to wrap: `proxy.constructor`
      // must stay `Locator`, which is also what {@link kindOf} reads.
      if (typeof value !== 'function' || typeof prop !== 'string' || prop === 'constructor') return value;
      const cached = methods.get(prop);
      if (cached !== undefined) return cached;
      const method = value as (...args: unknown[]) => unknown;
      const wrapped = function (this: unknown, ...args: unknown[]): unknown {
        const real = unwrapArgs(registry, args);
        // When this call is over, and whether it worked: a mark that found
        // nothing may ring a late element only while the call still waits
        // for it (`MarkOptions.settled`). A `try { click({ timeout }) } catch {}`
        // for an optional banner must not ring the banner when it turns up
        // later, unclicked.
        let settle: (ok: boolean) => void = () => {};
        const settled = new Promise<boolean>((resolve) => {
          settle = resolve;
        });
        markBefore(registry, t, kind, prop, real, settled);
        let result: unknown;
        try {
          result = method.apply(t, real);
        } catch (err) {
          settle(false);
          throw err;
        }
        if (result instanceof Promise) result.then(() => settle(true), () => settle(false));
        else settle(true);
        return wrapResult(registry, result);
      };
      methods.set(prop, wrapped);
      return wrapped;
    },
  });
  registry.proxies.set(target, proxy);
  registry.targets.set(proxy, target);
  return proxy;
}

/**
 * `page` as the code-behind entry or tool sees it while the highlight is on:
 * every locator it builds rings what it acts on or reads. The same proxy for
 * the same page every time through one sink.
 */
export function highlightingPage(page: Page, sink: HighlightSink): Page {
  return wrap(registryFor(sink), page);
}

/**
 * Wrap whatever an API object's methods return — `ctx.tabs.open(url)`,
 * `ctx.browsers.switchTo(label)` — so the pages an entry is handed after a
 * switch ring too. The API's own arguments are strings and functions, so
 * nothing proxied ever reaches the trackers behind it.
 */
export function highlightingApi<T extends object>(api: T, sink: HighlightSink): T {
  const registry = registryFor(sink);
  return new Proxy(api, {
    get(t, prop) {
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]): unknown => wrapResult(registry, method.apply(t, args));
    },
  });
}

/** The real object behind a proxy this sink made, or `value` itself. For tests
 *  and for any Steptix code that must compare against its own objects. */
export function unwrapHighlighted<T>(value: T, sink: HighlightSink): T {
  return unwrap(registryFor(sink), value) as T;
}
