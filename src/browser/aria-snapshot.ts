/**
 * Accessibility-ref page snapshots, supplementary `[ref=sN]` targets,
 * per-page ref resolution, and diff-polled snapshot waits
 * (`docs/specs/SPEC-aria-ref-snapshots.md` §3, §6.2, §7.2).
 *
 * Captures Playwright's `html`-rooted `ariaSnapshot({ mode: 'ai' })` (§3.1),
 * redacts run secrets and live secret-field values without corrupting
 * `[ref=...]` handles (§3.2), supplements Playwright blind spots using
 * browser-native `checkVisibility()` (§3.3), resolves main-frame (`eN`),
 * iframe (`f<seq>eN`), and supplementary (`sN`) refs against the live DOM
 * (§3.4), and polls locally for snapshot changes during `waitType: "change"`
 * (§6.2).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Frame, FrameLocator, Locator, Page } from 'playwright';
import type { DialogReader, DialogRecord } from './dialogs.js';
import {
  dialogNote,
  domCaptureFailure,
  expandDomSubtree,
  loadSecretFieldRule,
  PageCaptureError,
  toPageCaptureError,
} from './dom-cleaner.js';
import { noticeNote } from './notices.js';
import { logger } from '../utils/logger.js';
import { MASK, RECORD_SECRET_MIN_LENGTH, redact } from '../utils/secrets.js';

const DEFAULT_ARIA_SNAPSHOT_CHAR_LIMIT = 100_000;
const DEFAULT_MAX_IFRAME_DEPTH = 5;
const PAGE_EVALUATE_TIMEOUT_MS = 30_000;
const FRAME_EVALUATE_TIMEOUT_MS = 10_000;
const REF_RESOLVE_TIMEOUT_MS = 2_000;
const IFRAME_HANDLE_TIMEOUT_MS = 5_000;
const EXPAND_STAMP_CAP = 200;

const SUPPLEMENTARY_REF_ATTR = 'data-steptix-ref';
const SNAPSHOT_REF_CAPTURE_RE = /^(?:aria-ref=)?((?:f\d+)?e\d+|s\d+)$/;
const ARIA_REF_IN_YAML_RE = /\[ref=((?:f\d+)?e\d+)\]/g;
const REF_TOKEN_SPLIT_RE = /(\[ref=(?:(?:f\d+)?e\d+|s\d+)\])/g;
const FRAME_REF_PREFIX_RE = /^(f\d+)e\d+$/;
const BAD_SELECTOR_RE = /while parsing (?:css )?selector|Unexpected token .* selector|Unknown engine/i;
const YAML_CONTROL_VALUE_WITH_REF_RE =
  /^(\s*-\s+["']?(?:textbox|searchbox|combobox|spinbutton)\b[^\n]*\[ref=(?:(?:f\d+)?e\d+|s\d+)\](?:\s*\[[^\]]+\])*["']?:\s*)(.+)$/;
const YAML_CONTROL_VALUE_RE =
  /^(\s*-\s+["']?(?:textbox|searchbox|combobox|spinbutton)\b[^\n]*?:\s*)(.+)$/;
const YAML_CONTROL_BLOCK_OPEN_RE =
  /^(\s*)-\s+["']?(?:textbox|searchbox|combobox|spinbutton)\b[^\n]*:\s*$/;
const YAML_CHILD_TEXT_VALUE_RE = /^(\s*-\s+text:\s*)(.+)$/;

let cachedSecretFieldRule: string | undefined;
function getSecretFieldRule(): string {
  if (cachedSecretFieldRule === undefined) {
    // Call lazily so unit tests that partially mock `./dom-cleaner.js` without
    // exporting `loadSecretFieldRule` still load; fall back to reading the
    // shared fragment directly only in that partial-mock case.
    cachedSecretFieldRule =
      typeof loadSecretFieldRule === 'function'
        ? loadSecretFieldRule()
        : readFileSync(
            fileURLToPath(new URL('./scripts/secret-field.js', import.meta.url)),
            'utf8',
          );
  }
  return cachedSecretFieldRule;
}

export const ARIA_SNAPSHOT_TRUNCATION_MARKER =
  '\n<!-- Page snapshot truncated — page content exceeds size limit; use find or scroll -->';

export interface CaptureAriaOptions {
  maxIframeDepth?: number | undefined;
  domSnapshotCharLimit?: number | undefined;
  dialogReader?: DialogReader | undefined;
  onDialogNote?: ((listed: readonly DialogRecord[]) => void) | undefined;
  onClipped?: (() => void) | undefined;
  /** Run secrets (`secretsNow()` / `secretsFor(opts)`) to redact alongside live secret-field values (§3.2). */
  secrets?: string[] | undefined;
  /** When `false`, read-only diagnostic/report/API capture: leaves existing
   *  `data-steptix-ref` attributes and the active `SnapshotRefRegistry` intact.
   *  Defaults to `true`. */
  updateRegistry?: boolean | undefined;
}

export interface ResolvedRef {
  /** Locator pointing to the exact element in its owning frame. */
  locator: Locator;
  /** Selector string usable with `root.locator(selectorInRoot)`
   *  (`aria-ref=e15`, `aria-ref=f1e4`, or `[data-steptix-ref="s1"]`). */
  selectorInRoot: string;
  /** Owning Page or FrameLocator, for relative scoping and measurement. */
  root: Page | FrameLocator;
  /** Deterministic CSS frame chain (e.g. "#outer >> #inner"), undefined for main frame. */
  frameSelector?: string | undefined;
}

export class StaleRefError extends Error {
  readonly ref: string;

  constructor(ref: string, message?: string) {
    super(
      message
        ?? `Ref "${ref}" is no longer in the current page snapshot (the page updated or navigated). Inspect the fresh snapshot on the next turn and pick the current ref.`,
    );
    this.name = 'StaleRefError';
    this.ref = ref;
  }
}

interface SupplementaryRefEntry {
  frameSelector?: string | undefined;
  selectorInRoot: string;
}

interface FramePrefixEntry {
  frame: Frame;
  frameSelector?: string | undefined;
}

interface SnapshotRefRegistry {
  generationId: number;
  nextSupplementarySeq: number;
  validAriaRefs: Set<string>;
  supplementaryRefs: Map<string, SupplementaryRefEntry>;
  /** Refs stamped by `expandAriaSubtree` that must survive the next
   *  `captureAriaPageSnapshot` so the continuation turn acting on
   *  `explorationResults` can resolve them. */
  pendingExpandedRefs: Map<string, SupplementaryRefEntry>;
  framesByPrefix: Map<string, FramePrefixEntry>;
}

interface ReachableFrame {
  frame: Frame;
  frameSelector?: string | undefined;
}

interface ScannedFileInput {
  ref: string;
  label: string;
  section: string;
  accept: string;
  multiple: boolean;
}

interface ScannedControl {
  ref: string;
  kind: string;
  label: string;
  checked?: boolean;
  tag?: string;
}

interface ScannedTableRowGroup {
  tableName: string;
  rows: Array<{ rowNumber: string; ref: string }>;
}

interface FrameScanResult {
  nextSeq: number;
  secretValues: string[];
  fileInputs: ScannedFileInput[];
  controls: ScannedControl[];
  tableGroups: ScannedTableRowGroup[];
  stampedRefs: string[];
  alivePreservedRefs: string[];
}

class AriaEvaluateTimeout extends Error {}

const registries = new WeakMap<Page, SnapshotRefRegistry>();
const navListenersAttached = new WeakSet<Page>();

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new AriaEvaluateTimeout(`evaluate timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function evaluateWithTimeout<T>(target: Page | Frame, script: string, ms: number): Promise<T> {
  return withTimeout(target.evaluate(script) as Promise<T>, ms);
}

function normalizeRefString(value: string): string | null {
  const match = SNAPSHOT_REF_CAPTURE_RE.exec(value.trim());
  return match ? (match[1] ?? null) : null;
}

export function isSnapshotRefString(value: string): boolean {
  return /^(?:aria-ref=)?(?:(?:f\d+)?e\d+|s\d+)$/.test(value.trim());
}

/**
 * Split a frame selector chain into per-level iframe selectors without
 * breaking inside quoted strings or attribute brackets.
 *
 * When `>>` appears at top level (outside quotes and `[...]`), splits on
 * top-level `>>`; otherwise splits on top-level whitespace.
 */
export function splitFrameChain(frameSelector: string): string[] {
  const input = frameSelector.trim();
  if (input === '') return [];

  const splitAtTopLevel = (delimiter: '>>' | 'ws'): { segments: string[]; found: boolean } => {
    const segments: string[] = [];
    let quote: '"' | "'" | null = null;
    let bracketDepth = 0;
    let start = 0;
    let found = false;

    for (let i = 0; i < input.length; i++) {
      const ch = input[i]!;
      if (quote !== null) {
        if (ch === '\\' && i + 1 < input.length) {
          i++;
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }

      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '[') {
        bracketDepth++;
        continue;
      }
      if (ch === ']') {
        if (bracketDepth > 0) bracketDepth--;
        continue;
      }

      if (bracketDepth === 0) {
        if (delimiter === '>>' && ch === '>' && input[i + 1] === '>') {
          found = true;
          const seg = input.slice(start, i).trim();
          if (seg.length > 0) segments.push(seg);
          i++;
          start = i + 1;
        } else if (delimiter === 'ws' && /\s/.test(ch)) {
          found = true;
          const seg = input.slice(start, i).trim();
          if (seg.length > 0) segments.push(seg);
          start = i + 1;
        }
      }
    }

    const tail = input.slice(start).trim();
    if (tail.length > 0) segments.push(tail);
    return { segments, found };
  };

  const byChain = splitAtTopLevel('>>');
  if (byChain.found) return byChain.segments;
  return splitAtTopLevel('ws').segments;
}

function resolveFrameLocatorChain(page: Page, frameSelector?: string): Page | FrameLocator {
  if (!frameSelector) return page;
  let root: Page | FrameLocator = page;
  for (const segment of splitFrameChain(frameSelector)) {
    root = root.frameLocator(segment);
  }
  return root;
}

function attachMainFrameInvalidation(page: Page): void {
  if (navListenersAttached.has(page) || typeof page.on !== 'function') return;
  navListenersAttached.add(page);
  // Invalidate on real document loads rather than `framenavigated`, so SPA
  // `history.replaceState` calls that keep the live DOM intact do not
  // spuriously expire active snapshot refs.
  page.on('domcontentloaded', () => {
    const reg = registries.get(page);
    if (!reg) return;
    reg.validAriaRefs.clear();
    reg.supplementaryRefs.clear();
    reg.pendingExpandedRefs.clear();
    reg.framesByPrefix.clear();
  });
}

/**
 * Compute a deterministic, unique CSS selector for `childFrame`'s `<iframe>`
 * element inside its parent frame. Uses a helper-free arrow so esbuild never
 * injects `__name` helpers into the browser context.
 */
async function computeFrameElementSelector(childFrame: Frame): Promise<string | null> {
  let handle: Awaited<ReturnType<Frame['frameElement']>> | null = null;
  try {
    handle = await withTimeout(childFrame.frameElement(), IFRAME_HANDLE_TIMEOUT_MS);
    const selector = await withTimeout(
      handle.evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (el: any): string => {
          const rootNode = typeof el.getRootNode === 'function' ? el.getRootNode() : el.ownerDocument;
          const scope = rootNode && typeof rootNode.querySelectorAll === 'function'
            ? rootNode
            : el.ownerDocument;
          const tag = String(el.tagName || 'iframe').toLowerCase();
          const candidates: string[] = [];

          const testId = el.getAttribute('data-testid');
          if (testId) {
            candidates.push('[data-testid=' + JSON.stringify(String(testId)) + ']');
          }
          const id = el.getAttribute('id');
          if (id) {
            candidates.push(
              /^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)
                ? '#' + id
                : '[id=' + JSON.stringify(String(id)) + ']',
            );
          }
          const name = el.getAttribute('name');
          if (name) {
            candidates.push(tag + '[name=' + JSON.stringify(String(name)) + ']');
          }
          const title = el.getAttribute('title');
          if (title) {
            candidates.push(tag + '[title=' + JSON.stringify(String(title)) + ']');
          }
          const src = el.getAttribute('src');
          if (src && String(src).length <= 200) {
            candidates.push(tag + '[src=' + JSON.stringify(String(src)) + ']');
          }

          for (let i = 0; i < candidates.length; i++) {
            const candidate = candidates[i];
            if (!candidate) continue;
            try {
              const found = scope.querySelectorAll(candidate);
              if (found.length === 1 && found[0] === el) return candidate;
            } catch {
              // Ignore unparseable selector candidates.
            }
          }

          const parts: string[] = [];
          const body = el.ownerDocument ? el.ownerDocument.body : null;
          const docEl = el.ownerDocument ? el.ownerDocument.documentElement : null;
          let cur = el;
          while (cur && cur !== body && cur !== docEl && cur.parentElement) {
            const parent = cur.parentElement;
            const curTag = String(cur.tagName || '').toLowerCase();
            let n = 1;
            let sib = cur.previousElementSibling;
            while (sib) {
              if (String(sib.tagName || '').toLowerCase() === curTag) n++;
              sib = sib.previousElementSibling;
            }
            parts.unshift(curTag + ':nth-of-type(' + n + ')');

            const pCandidates: string[] = [];
            const pTestId = parent.getAttribute('data-testid');
            if (pTestId) pCandidates.push('[data-testid=' + JSON.stringify(String(pTestId)) + ']');
            const pId = parent.getAttribute('id');
            if (pId) {
              pCandidates.push(
                /^[A-Za-z_][A-Za-z0-9_-]*$/.test(pId)
                  ? '#' + pId
                  : '[id=' + JSON.stringify(String(pId)) + ']',
              );
            }
            let anchored = false;
            for (let k = 0; k < pCandidates.length; k++) {
              const pCand = pCandidates[k];
              if (!pCand) continue;
              try {
                const pFound = scope.querySelectorAll(pCand);
                if (pFound.length === 1 && pFound[0] === parent) {
                  parts.unshift(pCand);
                  anchored = true;
                  break;
                }
              } catch {
                // Ignore unparseable parent candidates.
              }
            }
            if (anchored) return parts.join('>');
            cur = parent;
          }
          if (cur === body) {
            parts.unshift('body');
          } else if (cur === docEl) {
            parts.unshift('html');
          }
          return parts.length > 0 ? parts.join('>') : tag;
        },
      ),
      IFRAME_HANDLE_TIMEOUT_MS,
    );
    return selector || null;
  } catch {
    return null;
  } finally {
    if (handle) await handle.dispose().catch(() => {});
  }
}

async function computeFrameChain(page: Page, frame: Frame): Promise<string | undefined> {
  const mainFrame = page.mainFrame();
  if (frame === mainFrame) return undefined;
  const segments: string[] = [];
  let cur: Frame | null = frame;
  let guard = 0;
  while (cur && cur !== mainFrame && guard < 20) {
    guard++;
    const parent: Frame | null = cur.parentFrame();
    if (!parent) break;
    const seg = await computeFrameElementSelector(cur);
    if (!seg) return undefined;
    segments.unshift(seg);
    cur = parent;
  }
  return segments.length > 0 ? segments.join(' >> ') : undefined;
}

async function walkReachableFrames(page: Page, maxDepth: number): Promise<ReachableFrame[]> {
  if (typeof page.mainFrame !== 'function') return [];
  const mainFrame = page.mainFrame();
  const visited = new Set<Frame>();
  const out: ReachableFrame[] = [];

  const visit = async (frame: Frame, depth: number, frameSelector?: string): Promise<void> => {
    if (visited.has(frame) || frame.isDetached()) return;
    visited.add(frame);
    out.push({
      frame,
      ...(frameSelector !== undefined && { frameSelector }),
    });
    if (depth >= maxDepth) return;
    let children: Frame[];
    try {
      children = frame.childFrames();
    } catch {
      return;
    }
    for (const child of children) {
      if (child.isDetached()) continue;
      const seg = await computeFrameElementSelector(child);
      const childSelector = seg
        ? frameSelector
          ? `${frameSelector} >> ${seg}`
          : seg
        : undefined;
      if (childSelector !== undefined) {
        await visit(child, depth + 1, childSelector);
      }
    }
  };

  await visit(mainFrame, 0, undefined);
  return out;
}

/**
 * Self-contained browser script run in each reachable frame during snapshot
 * capture to:
 *  1. Clear stale `data-steptix-ref` attributes across light and open shadow
 *     DOM (preserving any `preservedRefs` still alive from a preceding `expand`).
 *  2. Collect non-empty live values from secret-styled fields (§3.2).
 *  3. Stamp supplementary `[ref=sN]` handles on elements Playwright's
 *     `ariaSnapshot({ mode: 'ai' })` omits or drops (§3.3).
 */
function buildSupplementaryScanScript(
  startSeq: number,
  mutateDom: boolean,
  preservedRefs: readonly string[] = [],
): string {
  return `(() => {
    var nextSeq = ${Math.max(1, Math.floor(startSeq))};
    var mutateDom = ${mutateDom ? 'true' : 'false'};
    var refAttr = ${JSON.stringify(SUPPLEMENTARY_REF_ATTR)};
    var preservedSet = new Set(${JSON.stringify(preservedRefs)});
    var alivePreservedRefs = [];
    var SKIP_DESCENT = new Set(['head', 'script', 'style', 'noscript', 'template']);
    // Inputs whose .value is not user-entered secret text (e.g. a checkbox
    // named "show_password" has default .value === "on", which would corrupt
    // the entire snapshot if added to the redaction list).
    var STATIC_VALUE_INPUT_TYPES = new Set([
      'checkbox', 'radio', 'file', 'hidden', 'submit', 'reset', 'button', 'image',
    ]);
    var SUPPLEMENTARY_ROLES = new Set([
      'button', 'link', 'checkbox', 'radio', 'combobox', 'tab', 'menuitem', 'option',
    ]);

    ${getSecretFieldRule()}

    function cleanText(v) {
      return String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
    }

    function parentOrHost(el) {
      if (el.parentElement) return el.parentElement;
      var root = typeof el.getRootNode === 'function' ? el.getRootNode() : null;
      if (root && root.host) return root.host;
      return null;
    }

    function clearStaleRefs(root) {
      if (!root || typeof root.querySelectorAll !== 'function') return;
      var existing = root.querySelectorAll('[' + refAttr + ']');
      for (var i = 0; i < existing.length; i++) {
        var existingVal = cleanText(existing[i].getAttribute(refAttr));
        if (existingVal && preservedSet.has(existingVal)) {
          alivePreservedRefs.push(existingVal);
        } else {
          existing[i].removeAttribute(refAttr);
        }
      }
      var all = root.querySelectorAll('*');
      for (var j = 0; j < all.length; j++) {
        if (all[j].shadowRoot) clearStaleRefs(all[j].shadowRoot);
      }
    }

    if (mutateDom) clearStaleRefs(document);

    var elements = [];
    function collect(root) {
      if (!root || !root.children) return;
      for (var i = 0; i < root.children.length; i++) {
        var child = root.children[i];
        var tag = String(child.tagName || '').toLowerCase();
        if (SKIP_DESCENT.has(tag)) continue;
        elements.push(child);
        if (child.shadowRoot) collect(child.shadowRoot);
        collect(child);
      }
    }
    if (document.documentElement) {
      elements.push(document.documentElement);
      if (document.documentElement.shadowRoot) collect(document.documentElement.shadowRoot);
      collect(document.documentElement);
    }

    // Delegate visibility strictly to the browser's native checkVisibility(),
    // walking up past display:contents to the nearest box-generating ancestor
    // (matching captureVisibleText in src/browser/dom-cleaner.ts).
    function checkVisible(el, checkOpacity) {
      if (!el || el.nodeType !== 1) return false;
      if (typeof el.checkVisibility !== 'function') return true;
      var probe = el;
      while (probe) {
        var cs;
        try {
          cs = window.getComputedStyle(probe);
        } catch (e) {
          return false;
        }
        if (!cs || cs.display !== 'contents') break;
        probe = parentOrHost(probe);
      }
      if (!probe || typeof probe.checkVisibility !== 'function') return false;
      return probe.checkVisibility({
        checkVisibilityCSS: true,
        checkOpacity: Boolean(checkOpacity),
      });
    }

    function receivesPointerEvents(el) {
      var cur = el;
      while (cur) {
        var cs = window.getComputedStyle(cur);
        if (!cs) return true;
        if (cs.pointerEvents) return cs.pointerEvents !== 'none';
        cur = parentOrHost(cur);
      }
      return true;
    }

    function isEmptyCustomElement(el) {
      return el.tagName.indexOf('-') !== -1
        && !el.shadowRoot
        && el.children.length === 0
        && cleanText(el.textContent) === '';
    }

    function gotPlaywrightAriaRef(el) {
      if (!checkVisible(el, false)) return false;
      // Checking rect.width > 0 && rect.height > 0 here solely mirrors
      // Playwright's computeBox() to know whether Playwright ALREADY stamped
      // [ref=eN] (a 0x0 width:0;height:0 input returns true from
      // checkVisibility(), whereas Playwright's computeBox requires a
      // non-empty layout box; display:contents defers box visibility to its
      // children, and mode:'ai' uses visibility:'ariaOrVisible' so visible
      // elements still receive refs under aria-hidden="true"). Deciding
      // whether a supplementary control or stand-in is visible uses ONLY
      // checkVisibility().
      var cs;
      try {
        cs = window.getComputedStyle(el);
      } catch (e) {
        return false;
      }
      if (!cs) return false;
      if (cs.display !== 'contents') {
        var rect = el.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) return false;
      }
      if (!receivesPointerEvents(el)) return false;
      var role = cleanText(el.getAttribute('role')).toLowerCase();
      if (role === 'none' || role === 'presentation') return false;
      if (isEmptyCustomElement(el) && (!role || role === 'generic')) {
        return false;
      }
      return true;
    }

    function isTextSecurityMasked(el) {
      var cs;
      try {
        cs = window.getComputedStyle(el);
      } catch (e) {
        return false;
      }
      if (!cs) return false;
      var sec = cs.webkitTextSecurity
        || (typeof cs.getPropertyValue === 'function' ? cs.getPropertyValue('-webkit-text-security') : '');
      return Boolean(sec && sec !== 'none');
    }

    function resolveAriaLabelledBy(el) {
      var raw = el.getAttribute('aria-labelledby');
      if (!raw) return '';
      var root = typeof el.getRootNode === 'function' ? el.getRootNode() : document;
      var ids = String(raw).trim().split(/\\s+/);
      var parts = [];
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        if (!id) continue;
        var node = root && typeof root.getElementById === 'function'
          ? root.getElementById(id)
          : document.getElementById(id);
        if (node) {
          var t = cleanText(node.textContent);
          if (t) parts.push(t);
        }
      }
      return parts.join(' ').trim();
    }

    function associatedLabels(el) {
      var found = [];
      if (el.labels && el.labels.length > 0) {
        for (var i = 0; i < el.labels.length; i++) found.push(el.labels[i]);
      }
      var id = el.getAttribute('id');
      if (id) {
        var root = typeof el.getRootNode === 'function' ? el.getRootNode() : document;
        var scope = root && typeof root.querySelectorAll === 'function' ? root : document;
        try {
          var byFor = scope.querySelectorAll('label[for=' + JSON.stringify(String(id)) + ']');
          for (var j = 0; j < byFor.length; j++) {
            if (found.indexOf(byFor[j]) === -1) found.push(byFor[j]);
          }
        } catch (e) {}
      }
      var wrap = el.closest ? el.closest('label') : null;
      if (wrap && found.indexOf(wrap) === -1) found.push(wrap);
      return found;
    }

    function firstLabelText(labels) {
      for (var i = 0; i < labels.length; i++) {
        var t = cleanText(labels[i].textContent);
        if (t) return t;
      }
      return '';
    }

    function fileInputLabel(el) {
      var fromLabels = firstLabelText(associatedLabels(el));
      if (fromLabels) return fromLabels;
      return cleanText(el.getAttribute('aria-label'))
        || resolveAriaLabelledBy(el)
        || cleanText(el.getAttribute('name'))
        || cleanText(el.getAttribute('id'));
    }

    function enclosingSectionLabel(el) {
      var cur = parentOrHost(el);
      var depth = 0;
      while (cur && cur !== document.body && cur !== document.documentElement && depth < 5) {
        var cTag = String(cur.tagName || '').toLowerCase();
        if (cTag === 'main') break;
        depth++;
        if (cTag === 'fieldset' && cur.querySelector) {
          var leg = cur.querySelector('legend');
          if (leg) {
            var legText = cleanText(leg.textContent);
            if (legText) return legText.slice(0, 80);
          }
        }
        var ariaName = cleanText(cur.getAttribute('aria-label')) || resolveAriaLabelledBy(cur);
        if (ariaName) return ariaName.slice(0, 80);
        if (cur.querySelector && cur.querySelectorAll('input[type="file"]').length <= 1) {
          var heading = cur.querySelector('h1, h2, h3, h4, h5, h6');
          if (
            heading
            && (!heading.closest || heading.closest('section, article, fieldset') === (cur.closest ? cur.closest('section, article, fieldset') : null))
          ) {
            var hText = cleanText(heading.textContent);
            if (hText) return hText.slice(0, 80);
          }
        }
        cur = parentOrHost(cur);
      }
      return '';
    }

    function controlLabel(el, labels, fallbackParent) {
      var direct = cleanText(el.getAttribute('aria-label'))
        || resolveAriaLabelledBy(el)
        || firstLabelText(labels)
        || cleanText(el.getAttribute('placeholder'))
        || cleanText(el.getAttribute('title'));
      if (direct) return direct;
      var ownText = cleanText(typeof el.innerText === 'string' ? el.innerText : el.textContent);
      if (ownText) return ownText.slice(0, 100);
      var attrName = cleanText(el.getAttribute('name')) || cleanText(el.getAttribute('id'));
      if (attrName) return attrName;
      if (fallbackParent) {
        var parentText = cleanText(fallbackParent.textContent);
        if (parentText && parentText.length <= 120) return parentText;
      }
      return '';
    }

    function closestTableAcrossShadow(el) {
      var cur = parentOrHost(el);
      while (cur) {
        if (cur.matches && cur.matches('table, [role="grid"], [role="table"], [role="treegrid"]')) {
          return cur;
        }
        cur = parentOrHost(cur);
      }
      return null;
    }

    function tableNameFor(table) {
      if (!table) return 'table';
      var aria = cleanText(table.getAttribute('aria-label')) || resolveAriaLabelledBy(table);
      if (aria) return aria;
      var caption = table.querySelector ? table.querySelector('caption') : null;
      if (caption) {
        var capText = cleanText(caption.textContent);
        if (capText) return capText;
      }
      var id = cleanText(table.getAttribute('id'));
      if (id) return id;
      return 'table';
    }

    var secretSet = new Set();
    var stampedByEl = new Map();
    var stampedRefs = [];
    var fileInputs = [];
    var controls = [];
    var tableGroupMap = new Map();

    function stamp(el) {
      var existing = stampedByEl.get(el);
      if (existing) return existing;
      var priorPreserved = cleanText(el.getAttribute(refAttr));
      if (priorPreserved && (!mutateDom || preservedSet.has(priorPreserved))) {
        stampedByEl.set(el, priorPreserved);
        return priorPreserved;
      }
      var ref = 's' + nextSeq++;
      if (mutateDom) {
        el.setAttribute(refAttr, ref);
        stampedRefs.push(ref);
      }
      stampedByEl.set(el, ref);
      return ref;
    }

    for (var idx = 0; idx < elements.length; idx++) {
      var el = elements[idx];
      var tag = String(el.tagName || '').toLowerCase();
      var inputType = tag === 'input' ? String(el.getAttribute('type') || 'text').toLowerCase() : '';
      var explicitRole = cleanText(el.getAttribute('role')).toLowerCase();

      // 1. Secret-field live values (§3.2)
      if ((tag === 'input' && !STATIC_VALUE_INPUT_TYPES.has(inputType)) || tag === 'textarea') {
        var rawVal = el.value == null ? '' : String(el.value);
        if (rawVal.trim().length > 0 && (isSecretField(el) || isTextSecurityMasked(el))) {
          secretSet.add(rawVal);
        }
      }

      // 2a. Hidden <input type="file">
      if (tag === 'input' && inputType === 'file') {
        if (!gotPlaywrightAriaRef(el)) {
          var fRef = stamp(el);
          fileInputs.push({
            ref: fRef,
            label: fileInputLabel(el),
            section: enclosingSectionLabel(el),
            accept: cleanText(el.getAttribute('accept')),
            multiple: Boolean(el.multiple || el.hasAttribute('multiple')),
          });
        }
      } else if (tag === 'input' && (inputType === 'checkbox' || inputType === 'radio')) {
        // 2b.1 Hidden checkbox / radio with a visible label or parent stand-in box
        if (!gotPlaywrightAriaRef(el)) {
          var labels = associatedLabels(el);
          var hasVisibleLabel = false;
          for (var li = 0; li < labels.length; li++) {
            if (checkVisible(labels[li], true)) {
              hasVisibleLabel = true;
              break;
            }
          }
          var parent = el.parentElement;
          var hasVisibleParent = Boolean(
            parent
            && parent !== document.body
            && parent !== document.documentElement
            && checkVisible(parent, true),
          );
          if (hasVisibleLabel || hasVisibleParent || checkVisible(el, true)) {
            var tRef = stamp(el);
            controls.push({
              ref: tRef,
              kind: inputType,
              label: controlLabel(el, labels, hasVisibleParent ? parent : null),
              checked: Boolean(el.checked),
            });
          }
        }
      } else if (
        (tag === 'input' && inputType !== 'hidden' && inputType !== 'file')
        || tag === 'textarea'
        || tag === 'select'
        || tag === 'button'
        || SUPPLEMENTARY_ROLES.has(explicitRole)
      ) {
        // 2b.2 Visible interactive control omitted by Playwright ariaSnapshot
        if (checkVisible(el, true) && !gotPlaywrightAriaRef(el)) {
          var cRef = stamp(el);
          var cLabels = associatedLabels(el);
          var roleOrTag = SUPPLEMENTARY_ROLES.has(explicitRole) ? explicitRole : tag;
          controls.push({
            ref: cRef,
            kind: roleOrTag,
            label: controlLabel(el, cLabels, null),
          });
        }
      } else if (isEmptyCustomElement(el) && checkVisible(el, true) && !gotPlaywrightAriaRef(el)) {
        // 2b.3 Visible closed-shadow / empty custom element
        var ceRef = stamp(el);
        var ceLabel = cleanText(el.getAttribute('aria-label'))
          || cleanText(el.getAttribute('title'))
          || cleanText(el.getAttribute('name'))
          || cleanText(el.getAttribute('id'))
          || tag;
        controls.push({
          ref: ceRef,
          kind: 'custom-element',
          label: ceLabel,
          tag: tag,
        });
      }

      // 2c. Stamped table rows ([data-steptix-row])
      if (el.hasAttribute('data-steptix-row') && checkVisible(el, false)) {
        var rowNumber = cleanText(el.getAttribute('data-steptix-row'));
        if (rowNumber) {
          var rRef = stamp(el);
          var tableEl = closestTableAcrossShadow(el);
          var group = tableGroupMap.get(tableEl);
          if (!group) {
            group = { tableName: tableNameFor(tableEl), rows: [] };
            tableGroupMap.set(tableEl, group);
          }
          group.rows.push({ rowNumber: rowNumber, ref: rRef });
        }
      }
    }

    var tableGroups = [];
    tableGroupMap.forEach(function (g) {
      tableGroups.push(g);
    });

    return {
      nextSeq: nextSeq,
      secretValues: Array.from(secretSet),
      fileInputs: fileInputs,
      controls: controls,
      tableGroups: tableGroups,
      stampedRefs: stampedRefs,
      alivePreservedRefs: alivePreservedRefs,
    };
  })()`;
}

function sliceWholeCodePoints(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= 0) return '';
  let end = limit;
  const lastCode = text.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }
  return text.slice(0, end);
}

function isTimeoutFailure(err: unknown): boolean {
  if (err instanceof AriaEvaluateTimeout) return true;
  if (err instanceof Error) {
    if (err.name === 'TimeoutError') return true;
    if (/Timeout \d+ms exceeded/i.test(err.message)) return true;
    if (err.message.includes('evaluate timed out after')) return true;
  }
  return false;
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function collectAriaSecrets(
  runSecrets: readonly string[] | undefined,
  secretFieldValues: readonly string[],
): { longSecrets: string[]; shortFieldSecrets: string[] } {
  const longSet = new Set<string>();
  const shortSet = new Set<string>();

  for (const s of runSecrets ?? []) {
    if (s.length === 0) continue;
    longSet.add(s);
    const escaped = JSON.stringify(s).slice(1, -1);
    if (escaped.length > 0) longSet.add(escaped);
    // Playwright's ariaSnapshot collapses whitespace (including newlines in
    // `<pre>` or multiline nodes) into single spaces, so a multiline run secret
    // appears collapsed in the YAML text.
    const collapsed = s.replace(/\s+/g, ' ').trim();
    if (collapsed.length >= RECORD_SECRET_MIN_LENGTH) {
      longSet.add(collapsed);
      const collapsedEscaped = JSON.stringify(collapsed).slice(1, -1);
      if (collapsedEscaped.length > 0) longSet.add(collapsedEscaped);
    }
  }
  for (const raw of secretFieldValues) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length < RECORD_SECRET_MIN_LENGTH) {
      shortSet.add(raw);
      shortSet.add(trimmed);
      const collapsed = raw.replace(/\s+/g, ' ').trim();
      if (collapsed.length > 0) shortSet.add(collapsed);
    } else {
      longSet.add(raw);
      const collapsed = raw.replace(/\s+/g, ' ').trim();
      if (collapsed.length > 0) {
        longSet.add(collapsed);
        const collapsedEscaped = JSON.stringify(collapsed).slice(1, -1);
        if (collapsedEscaped.length > 0) longSet.add(collapsedEscaped);
      }
      const escaped = JSON.stringify(raw).slice(1, -1);
      if (escaped.length > 0) longSet.add(escaped);
    }
  }

  return {
    longSecrets: [...longSet],
    shortFieldSecrets: [...shortSet],
  };
}

function redactPreservingRefs(
  text: string,
  longSecrets: string[],
  shortFieldSecrets: string[],
): string {
  let out = text;

  if (shortFieldSecrets.length > 0) {
    const shortSet = new Set(shortFieldSecrets);
    const matchesShortSecret = (valuePart: string): boolean => {
      const trimmed = valuePart.trim();
      if (shortSet.has(trimmed)) return true;
      const unquoted = unquoteYamlScalar(trimmed);
      return shortSet.has(unquoted) || shortSet.has(unquoted.trim());
    };

    let controlBlockIndent: number | null = null;
    const lines = out.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (controlBlockIndent !== null) {
        const leading = /^(\s*)/.exec(line)?.[1]?.length ?? 0;
        if (line.trim().length > 0 && leading <= controlBlockIndent) {
          controlBlockIndent = null;
        } else {
          const childTextMatch = YAML_CHILD_TEXT_VALUE_RE.exec(line);
          if (childTextMatch && matchesShortSecret(childTextMatch[2]!)) {
            lines[i] = `${childTextMatch[1]}${MASK}`;
          }
          continue;
        }
      }

      const blockOpen = YAML_CONTROL_BLOCK_OPEN_RE.exec(line);
      if (blockOpen) {
        controlBlockIndent = blockOpen[1]!.length;
        continue;
      }

      const match =
        YAML_CONTROL_VALUE_WITH_REF_RE.exec(line) ?? YAML_CONTROL_VALUE_RE.exec(line);
      if (match && matchesShortSecret(match[2]!)) {
        lines[i] = `${match[1]}${MASK}`;
      }
    }
    out = lines.join('\n');
  }

  if (longSecrets.length === 0) return out;

  // Split around `[ref=...]` tokens and redact only non-ref segments (even
  // indices), so even a short author secret like "e1" cannot corrupt a handle.
  const parts = out.split(REF_TOKEN_SPLIT_RE);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = redact(parts[i]!, longSecrets);
  }
  return parts.join('');
}

export async function captureAriaPageSnapshot(
  page: Page,
  opts: CaptureAriaOptions = {},
): Promise<string> {
  const maxIframeDepth = opts.maxIframeDepth ?? DEFAULT_MAX_IFRAME_DEPTH;
  const charLimit = opts.domSnapshotCharLimit ?? DEFAULT_ARIA_SNAPSHOT_CHAR_LIMIT;

  let rawYaml: string;
  try {
    rawYaml = await page.locator('html').ariaSnapshot({
      mode: 'ai',
      timeout: PAGE_EVALUATE_TIMEOUT_MS,
    });
  } catch (err) {
    if (isTimeoutFailure(err)) {
      const detail = err instanceof Error ? err.message : String(err);
      return `<error>DOM capture timed out: evaluate timed out after ${PAGE_EVALUATE_TIMEOUT_MS}ms (${detail})</error>`;
    }
    return `<error>Page snapshot capture failed: ${String(err)}</error>`;
  }

  const prev = registries.get(page);
  const validAriaRefs = new Set<string>();
  for (const match of rawYaml.matchAll(ARIA_REF_IN_YAML_RE)) {
    const captured = match[1];
    if (captured) validAriaRefs.add(captured);
  }

  const supplementaryRefs = new Map<string, SupplementaryRefEntry>();
  const framesByPrefix = new Map<string, FramePrefixEntry>();
  if (typeof page.mainFrame === 'function') {
    framesByPrefix.set('', { frame: page.mainFrame() });
  }

  const shouldUpdateRegistry = opts.updateRegistry !== false;
  const hasPendingExpanded =
    shouldUpdateRegistry && prev !== undefined && prev.pendingExpandedRefs.size > 0;
  const preservedRefs = hasPendingExpanded ? [...prev.pendingExpandedRefs.keys()] : [];
  const reachableFrames = await walkReachableFrames(page, maxIframeDepth);
  let nextSeq = hasPendingExpanded
    ? Math.max(1, prev.nextSupplementarySeq)
    : shouldUpdateRegistry
      ? 1
      : Math.max(1, prev?.nextSupplementarySeq ?? 1);
  const secretFieldValues: string[] = [];
  const iframeLines: string[] = [];
  const fileInputLines: string[] = [];
  const controlLines: string[] = [];
  const tableRowLines: string[] = [];

  for (const entry of reachableFrames) {
    if (entry.frameSelector !== undefined) {
      iframeLines.push(`- iframe [frame=${JSON.stringify(entry.frameSelector)}]`);
    }
    const timeoutMs = entry.frameSelector === undefined
      ? PAGE_EVALUATE_TIMEOUT_MS
      : FRAME_EVALUATE_TIMEOUT_MS;
    let scan: FrameScanResult | null = null;
    try {
      scan = await evaluateWithTimeout<FrameScanResult>(
        entry.frame,
        buildSupplementaryScanScript(nextSeq, shouldUpdateRegistry, preservedRefs),
        timeoutMs,
      );
    } catch {
      scan = null;
    }
    if (!scan) continue;

    nextSeq = scan.nextSeq;
    for (const sVal of scan.secretValues) {
      secretFieldValues.push(sVal);
    }
    for (const sRef of scan.stampedRefs) {
      supplementaryRefs.set(sRef, {
        ...(entry.frameSelector !== undefined && { frameSelector: entry.frameSelector }),
        selectorInRoot: `[${SUPPLEMENTARY_REF_ATTR}="${sRef}"]`,
      });
    }
    if (hasPendingExpanded && prev && Array.isArray(scan.alivePreservedRefs)) {
      for (const aliveRef of scan.alivePreservedRefs) {
        const priorEntry = prev.pendingExpandedRefs.get(aliveRef);
        if (priorEntry) {
          supplementaryRefs.set(aliveRef, priorEntry);
        }
      }
    }

    const framePart = entry.frameSelector !== undefined
      ? ` [frame=${JSON.stringify(entry.frameSelector)}]`
      : '';

    for (const item of scan.fileInputs) {
      const labelPart = item.label ? ` ${JSON.stringify(item.label)}` : '';
      const sectionPart =
        item.section && item.section.toLowerCase() !== item.label.toLowerCase()
          ? ` [section=${JSON.stringify(item.section)}]`
          : '';
      const acceptPart = item.accept ? ` [accept=${JSON.stringify(item.accept)}]` : '';
      const multiplePart = item.multiple ? ' [multiple]' : '';
      fileInputLines.push(
        `- file-input${labelPart}${sectionPart}${acceptPart}${multiplePart}${framePart} [ref=${item.ref}]`,
      );
    }

    for (const item of scan.controls) {
      if (item.kind === 'custom-element') {
        const tag = item.tag ?? item.label;
        controlLines.push(
          `- custom-element ${JSON.stringify(item.label)} (<${tag}>)${framePart} [ref=${item.ref}]`,
        );
      } else if (item.checked !== undefined) {
        const labelPart = item.label ? ` ${JSON.stringify(item.label)}` : '';
        controlLines.push(
          `- ${item.kind}${labelPart} [checked=${item.checked}]${framePart} [ref=${item.ref}]`,
        );
      } else {
        const labelPart = item.label ? ` ${JSON.stringify(item.label)}` : '';
        controlLines.push(`- ${item.kind}${labelPart}${framePart} [ref=${item.ref}]`);
      }
    }

    for (const group of scan.tableGroups) {
      if (group.rows.length === 0) continue;
      const mapped = group.rows.map((r) => `row ${r.rowNumber} [ref=${r.ref}]`).join(', ');
      tableRowLines.push(
        `# Stamped Table Rows: table ${JSON.stringify(group.tableName)}${framePart} -> ${mapped}`,
      );
    }
  }

  if (shouldUpdateRegistry) {
    const registry: SnapshotRefRegistry = {
      generationId: (prev?.generationId ?? 0) + 1,
      nextSupplementarySeq: nextSeq,
      validAriaRefs,
      supplementaryRefs,
      pendingExpandedRefs: new Map(),
      framesByPrefix,
    };
    registries.set(page, registry);
    attachMainFrameInvalidation(page);
  }

  const sections: string[] = [];
  if (rawYaml.length > 0) sections.push(rawYaml);
  if (iframeLines.length > 0) {
    sections.push(`# Iframes\n${iframeLines.join('\n')}`);
  }
  if (fileInputLines.length > 0) {
    sections.push(`# File Inputs (hidden native upload targets)\n${fileInputLines.join('\n')}`);
  }
  if (controlLines.length > 0) {
    sections.push(`# Supplementary Controls\n${controlLines.join('\n')}`);
  }
  if (tableRowLines.length > 0) {
    sections.push(tableRowLines.join('\n'));
  }
  const assembled = sections.join('\n\n');

  const { longSecrets, shortFieldSecrets } = collectAriaSecrets(opts.secrets, secretFieldValues);
  const redacted = redactPreservingRefs(assembled, longSecrets, shortFieldSecrets);

  let output = redacted;
  if (output.length > charLimit) {
    output = sliceWholeCodePoints(output, charLimit) + ARIA_SNAPSHOT_TRUNCATION_MARKER;
    opts.onClipped?.();
  }

  return output + dialogNote(page, opts.dialogReader, opts.onDialogNote) + (await noticeNote(page));
}

/**
 * Capture a read-only accessibility snapshot scoped to the first element
 * matching `selector`, masking run secrets and live secret-field values across
 * reachable frames without mutating the DOM or the active ref registry (§3.2).
 */
export async function captureAriaSubtreeSnapshot(
  page: Page,
  selector: string,
  opts: { secrets?: string[] | undefined } = {},
): Promise<string> {
  let rawYaml: string;
  try {
    const loc = page.locator(selector);
    const count = await loc.count();
    if (count === 0) {
      throw new PageCaptureError(
        'selector-miss',
        `No element matches selector: ${selector}`,
      );
    }
    rawYaml = await loc.first().ariaSnapshot({
      mode: 'ai',
      timeout: PAGE_EVALUATE_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof PageCaptureError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (BAD_SELECTOR_RE.test(msg)) {
      throw new PageCaptureError('bad-selector', `Invalid selector "${selector}": ${msg}`);
    }
    if (isTimeoutFailure(err)) {
      throw new PageCaptureError('timeout', `Aria capture timed out: ${msg}`);
    }
    throw toPageCaptureError(err, 'Aria capture', true);
  }

  const secretFieldValues: string[] = [];
  const frames = typeof page.frames === 'function' ? page.frames() : [];
  const mainFrame = typeof page.mainFrame === 'function' ? page.mainFrame() : null;
  for (const frame of frames) {
    if (frame.isDetached()) continue;
    const timeoutMs = frame === mainFrame ? PAGE_EVALUATE_TIMEOUT_MS : FRAME_EVALUATE_TIMEOUT_MS;
    try {
      const scan = await evaluateWithTimeout<FrameScanResult>(
        frame,
        buildSupplementaryScanScript(1, false),
        timeoutMs,
      );
      if (scan && Array.isArray(scan.secretValues)) {
        secretFieldValues.push(...scan.secretValues);
      }
    } catch {
      // Cross-origin or detached frames are best-effort here.
    }
  }

  const { longSecrets, shortFieldSecrets } = collectAriaSecrets(opts.secrets, secretFieldValues);
  return redactPreservingRefs(rawYaml, longSecrets, shortFieldSecrets);
}

export function ariaSnapshotWasClipped(content: string): boolean {
  return content.includes(ARIA_SNAPSHOT_TRUNCATION_MARKER);
}

export function ariaCaptureFailure(content: string): PageCaptureError | null {
  const err = domCaptureFailure(content, 'snapshot');
  if (!err) return null;
  if (err.kind === 'evaluate-failed' && /Timeout \d+ms exceeded/i.test(content)) {
    return new PageCaptureError('timeout', err.message);
  }
  return err;
}

export async function resolveRefTarget(page: Page, rawRef: string): Promise<ResolvedRef> {
  const ref = normalizeRefString(rawRef);
  if (!ref) {
    throw new StaleRefError(rawRef);
  }

  const registry = registries.get(page);
  if (!registry) {
    throw new StaleRefError(ref);
  }

  if (ref.startsWith('s')) {
    const supp = registry.supplementaryRefs.get(ref);
    if (!supp) {
      throw new StaleRefError(ref);
    }
    const root = resolveFrameLocatorChain(page, supp.frameSelector);
    const locator = root.locator(supp.selectorInRoot);
    let count = 0;
    try {
      count = await withTimeout(locator.count(), REF_RESOLVE_TIMEOUT_MS);
    } catch {
      count = 0;
    }
    if (count === 0) {
      throw new StaleRefError(ref);
    }
    return {
      locator,
      selectorInRoot: supp.selectorInRoot,
      root,
      ...(supp.frameSelector !== undefined && { frameSelector: supp.frameSelector }),
    };
  }

  if (!registry.validAriaRefs.has(ref)) {
    throw new StaleRefError(ref);
  }

  const selectorInRoot = `aria-ref=${ref}`;
  const pageLoc = page.locator(selectorInRoot);
  let pageCount = 0;
  try {
    pageCount = await withTimeout(pageLoc.count(), REF_RESOLVE_TIMEOUT_MS);
  } catch {
    pageCount = 0;
  }
  if (pageCount === 0) {
    throw new StaleRefError(ref);
  }

  const frameMatch = FRAME_REF_PREFIX_RE.exec(ref);
  if (!frameMatch) {
    return {
      locator: pageLoc,
      selectorInRoot,
      root: page,
    };
  }

  const prefix = frameMatch[1]!;
  let frameEntry = registry.framesByPrefix.get(prefix);
  if (!frameEntry) {
    let handle: Awaited<ReturnType<Locator['elementHandle']>> = null;
    try {
      handle = await pageLoc.first().elementHandle({ timeout: REF_RESOLVE_TIMEOUT_MS });
      const ownerFrame = handle ? await handle.ownerFrame() : null;
      if (ownerFrame) {
        const frameSelector = await computeFrameChain(page, ownerFrame);
        frameEntry = {
          frame: ownerFrame,
          ...(frameSelector !== undefined && { frameSelector }),
        };
        registry.framesByPrefix.set(prefix, frameEntry);
      }
    } catch {
      // Fall through to pageLoc if frame metadata could not be resolved.
    } finally {
      if (handle) await handle.dispose().catch(() => {});
    }
  }

  const frameSelector = frameEntry?.frameSelector;
  if (frameSelector) {
    const root = resolveFrameLocatorChain(page, frameSelector);
    const scopedLocator = root.locator(selectorInRoot);
    let scopedCount = 0;
    try {
      scopedCount = await withTimeout(scopedLocator.count(), REF_RESOLVE_TIMEOUT_MS);
    } catch {
      scopedCount = 0;
    }
    if (scopedCount > 0) {
      return {
        locator: scopedLocator,
        selectorInRoot,
        root,
        frameSelector,
      };
    }
  }

  return {
    locator: pageLoc,
    selectorInRoot,
    root: page,
    ...(frameSelector !== undefined && { frameSelector }),
  };
}

function getOrCreateRegistry(page: Page): SnapshotRefRegistry {
  let registry = registries.get(page);
  if (!registry) {
    const framesByPrefix = new Map<string, FramePrefixEntry>();
    if (typeof page.mainFrame === 'function') {
      framesByPrefix.set('', { frame: page.mainFrame() });
    }
    registry = {
      generationId: 1,
      nextSupplementarySeq: 1,
      validAriaRefs: new Set(),
      supplementaryRefs: new Map(),
      pendingExpandedRefs: new Map(),
      framesByPrefix,
    };
    registries.set(page, registry);
    attachMainFrameInvalidation(page);
  }
  return registry;
}

/**
 * Stamp visible interactive or leaf elements inside `targetLocator` with fresh
 * `data-steptix-ref="sN"` handles so a follow-up AI turn can target inner
 * elements exposed by `expand` directly via `"ref": "sN"`. Uses a helper-free
 * iterative traversal so esbuild never emits `__name` helpers into the browser.
 */
async function stampExpandSubtree(
  targetLocator: Locator,
  registry: SnapshotRefRegistry,
  frameSelector?: string,
): Promise<void> {
  let count = 0;
  try {
    count = await withTimeout(targetLocator.count(), REF_RESOLVE_TIMEOUT_MS);
  } catch {
    count = 0;
  }
  if (count === 0) return;

  const startSeq = registry.nextSupplementarySeq;
  let stamped: { refs: string[]; existingRefs: string[]; nextSeq: number } | null = null;
  try {
    stamped = await targetLocator.first().evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (rootEl: any, arg: { startSeq: number; cap: number; attr: string }) => {
        const view = rootEl.ownerDocument ? rootEl.ownerDocument.defaultView : null;
        const skipTags = new Set([
          'script', 'style', 'noscript', 'svg', 'meta', 'link', 'base', 'title', 'br', 'hr',
        ]);
        const interactiveTags = new Set([
          'a', 'button', 'input', 'select', 'textarea', 'label', 'option', 'summary',
        ]);
        const refs: string[] = [];
        const existingRefs: string[] = [];
        let seq = arg.startSeq;

        const rootExisting = String(rootEl.getAttribute(arg.attr) || '').trim();
        if (rootExisting) existingRefs.push(rootExisting);

        // Iterative pre-order walk across light DOM and open shadow roots.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stack: any[] = [];
        if (rootEl.children) {
          for (let i = rootEl.children.length - 1; i >= 0; i--) {
            stack.push(rootEl.children[i]);
          }
        }
        if (rootEl.shadowRoot && rootEl.shadowRoot.children) {
          for (let i = rootEl.shadowRoot.children.length - 1; i >= 0; i--) {
            stack.push(rootEl.shadowRoot.children[i]);
          }
        }

        while (stack.length > 0 && refs.length < arg.cap) {
          const el = stack.pop();
          if (!el || el.nodeType !== 1) continue;
          const tag = String(el.tagName || '').toLowerCase();
          if (skipTags.has(tag)) continue;

          const inputType = tag === 'input'
            ? String(el.getAttribute('type') || 'text').toLowerCase()
            : '';
          const isFileInput = tag === 'input' && inputType === 'file';
          const cs = view && typeof view.getComputedStyle === 'function'
            ? view.getComputedStyle(el)
            : null;
          if (!isFileInput && typeof el.checkVisibility === 'function') {
            let probe = el;
            while (probe && view && typeof view.getComputedStyle === 'function') {
              const pcs = view.getComputedStyle(probe);
              if (!pcs || pcs.display !== 'contents') break;
              if (probe.parentElement) {
                probe = probe.parentElement;
              } else {
                const pRoot = typeof probe.getRootNode === 'function' ? probe.getRootNode() : null;
                probe = pRoot && pRoot.host ? pRoot.host : null;
              }
            }
            if (
              !probe
              || typeof probe.checkVisibility !== 'function'
              || !probe.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
            ) {
              continue;
            }
          }

          if (el.hasAttribute(arg.attr)) {
            const existingVal = String(el.getAttribute(arg.attr) || '').trim();
            if (existingVal) existingRefs.push(existingVal);
          } else {
            const role = String(el.getAttribute('role') || '').trim().toLowerCase();
            const hasSemanticRole = role.length > 0 && role !== 'none' && role !== 'presentation';
            const isInteractive =
              interactiveTags.has(tag)
              || hasSemanticRole
              || el.getAttribute('contenteditable') === 'true'
              || el.hasAttribute('tabindex')
              || el.getAttribute('draggable') === 'true'
              || (cs !== null && cs.cursor === 'pointer');

            let hasDirectText = false;
            if (!isInteractive && el.childNodes) {
              for (let c = 0; c < el.childNodes.length; c++) {
                const node = el.childNodes[c];
                if (node && node.nodeType === 3 && String(node.textContent || '').trim().length > 0) {
                  hasDirectText = true;
                  break;
                }
              }
            }
            const isLeaf =
              (!el.children || el.children.length === 0)
              && !el.shadowRoot
              && (String(el.textContent || '').trim().length > 0
                || tag === 'img'
                || tag === 'canvas'
                || isFileInput);

            if (isInteractive || hasDirectText || isLeaf) {
              const ref = 's' + seq++;
              el.setAttribute(arg.attr, ref);
              refs.push(ref);
            }
          }

          if (el.children) {
            for (let i = el.children.length - 1; i >= 0; i--) {
              stack.push(el.children[i]);
            }
          }
          if (el.shadowRoot && el.shadowRoot.children) {
            for (let i = el.shadowRoot.children.length - 1; i >= 0; i--) {
              stack.push(el.shadowRoot.children[i]);
            }
          }
        }

        return { refs, existingRefs, nextSeq: seq };
      },
      { startSeq, cap: EXPAND_STAMP_CAP, attr: SUPPLEMENTARY_REF_ATTR },
      { timeout: REF_RESOLVE_TIMEOUT_MS },
    );
  } catch {
    stamped = null;
  }

  if (!stamped) return;
  registry.nextSupplementarySeq = stamped.nextSeq;
  for (const sRef of [...stamped.refs, ...stamped.existingRefs]) {
    const entry: SupplementaryRefEntry = {
      ...(frameSelector !== undefined && { frameSelector }),
      selectorInRoot: `[${SUPPLEMENTARY_REF_ATTR}="${sRef}"]`,
    };
    registry.supplementaryRefs.set(sRef, entry);
    registry.pendingExpandedRefs.set(sRef, entry);
  }
}

export async function expandAriaSubtree(
  page: Page,
  target: {
    ref?: string | undefined;
    selector?: string | undefined;
    frame?: string | undefined;
  },
): Promise<{ content: string; label: string }> {
  let selectorForExpand: string;
  let frameSelector: string | undefined;
  let targetLocator: Locator;
  let label: string;

  if (target.ref !== undefined && target.ref.trim().length > 0) {
    label = target.ref;
    let resolved: ResolvedRef;
    try {
      resolved = await resolveRefTarget(page, target.ref);
    } catch (err) {
      if (err instanceof StaleRefError) {
        return { content: `[expand] ${err.message}`, label };
      }
      return { content: `[expand] Error: ${String(err)}`, label };
    }
    selectorForExpand = resolved.selectorInRoot;
    frameSelector = resolved.frameSelector;
    targetLocator = resolved.locator;
  } else if (target.selector !== undefined && target.selector.trim().length > 0) {
    label = target.selector;
    selectorForExpand = target.selector;
    frameSelector = target.frame;
    const root = resolveFrameLocatorChain(page, frameSelector);
    targetLocator = root.locator(selectorForExpand);
  } else {
    return { content: '[expand] No target ref or selector provided.', label: '' };
  }

  const registry = getOrCreateRegistry(page);
  await stampExpandSubtree(targetLocator, registry, frameSelector);

  const content = await expandDomSubtree(page, selectorForExpand, frameSelector);
  return { content, label };
}

// ─── Diff-polled waits & snapshot diffing (§6.2, §7.2) ──────────────────────

const COUNTDOWN_CLOCK_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
const COUNTDOWN_UNIT_RE =
  /\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/gi;
const COUNTDOWN_REMAINING_RE =
  /\b(?:in|remaining:?|left:?)\s+\d+\b|\b\d+\s+(?:remaining|left)\b/gi;
const DIFF_REF_LINE_RE =
  /-\s+["']?([a-z][a-z0-9-]*)(?:\s+"((?:[^"\\]|\\.)*)")?[^\n]*\[ref=((?:f\d+)?e\d+|s\d+)\]/g;
const STRIP_REF_AND_ACTIVE_RE = /\s*\[(?:ref=(?:(?:f\d+)?e\d+|s\d+)|active)\]/g;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const SUPPLEMENTARY_SECTION_START_RE =
  /(?:^|\n\n)# (?:Iframes\n|File Inputs \(hidden native upload targets\)\n|Supplementary Controls\n|Stamped Table Rows:)/;
/** Standard Playwright ARIA widget roles valid in `page.getByRole(role, ...)`. */
const PLAYWRIGHT_INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option',
  'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'slider', 'spinbutton', 'treeitem',
]);
/**
 * Interactive control roles counted as interactive signatures during snapshot
 * diffing (`normalizeSnapshotForDiff` / `waitForSnapshotChange`). Playwright
 * `mode: 'ai'` also stamps `[ref=eN]` on passive roles (`status`, `heading`,
 * `alert`, `progressbar`, `generic`, `paragraph`, `region`, `img`, `cell`, ...),
 * whose text mutations must be treated as `textChanged` (subject to backoff)
 * rather than `newInteractiveControl`.
 */
const INTERACTIVE_CONTROL_ROLES = new Set([
  ...PLAYWRIGHT_INTERACTIVE_ROLES,
  'file-input', 'custom-element', 'input', 'textarea', 'select',
]);
const HEARTBEAT_INTERVAL_MS = 15_000;
const NAV_CONTEXT_DESTROYED_RE =
  /Execution context was destroyed|Cannot find context|frame was detached/i;

function unescapeQuotedName(raw: string): string {
  return raw.replace(/\\(.)/g, '$1');
}

function normalizeCountdownText(text: string): string {
  return text
    .replace(COUNTDOWN_CLOCK_RE, '#:#')
    .replace(COUNTDOWN_UNIT_RE, '#s')
    .replace(COUNTDOWN_REMAINING_RE, '# remaining');
}

function stripSnapshotComments(snapshot: string): string {
  return snapshot
    .replaceAll(ARIA_SNAPSHOT_TRUNCATION_MARKER, '')
    .replace(HTML_COMMENT_RE, '');
}

/**
 * Strip framework-appended supplementary sections (`# Iframes`, `# File Inputs`,
 * `# Supplementary Controls`, `# Stamped Table Rows`) from a full
 * `captureAriaPageSnapshot` output so diff-polling compares `rawYaml` against
 * `rawYaml` apples-to-apples.
 */
function stripSupplementaryAriaSections(snapshot: string): string {
  const withoutComments = stripSnapshotComments(snapshot);
  const match = SUPPLEMENTARY_SECTION_START_RE.exec(withoutComments);
  if (!match) return withoutComments;
  return withoutComments.slice(0, match.index);
}

export interface NormalizedAriaDiff {
  normalized: string;
  interactiveRefCount: number;
  interactiveSignatures: Set<string>;
}

export function normalizeSnapshotForDiff(snapshot: string): NormalizedAriaDiff {
  const withoutComments = stripSnapshotComments(snapshot);

  let interactiveRefCount = 0;
  const interactiveSignatures = new Set<string>();
  for (const match of withoutComments.matchAll(DIFF_REF_LINE_RE)) {
    const role = match[1];
    const ref = match[3];
    if (!role || !ref || !INTERACTIVE_CONTROL_ROLES.has(role)) continue;
    const rawName = match[2];
    const name = rawName !== undefined ? normalizeCountdownText(unescapeQuotedName(rawName)) : '';
    interactiveRefCount++;
    interactiveSignatures.add(`${role}:${name}`);
  }

  const normalized = normalizeCountdownText(
    withoutComments.replace(STRIP_REF_AND_ACTIVE_RE, ''),
  )
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    normalized,
    interactiveRefCount,
    interactiveSignatures,
  };
}

interface ParsedRefItem {
  ref: string;
  role: string;
  name: string;
  signature: string;
}

function parseInteractiveRefItems(snapshot: string): ParsedRefItem[] {
  const cleaned = stripSnapshotComments(snapshot);
  const items: ParsedRefItem[] = [];
  for (const match of cleaned.matchAll(DIFF_REF_LINE_RE)) {
    const role = match[1];
    const ref = match[3];
    if (!role || !ref || !INTERACTIVE_CONTROL_ROLES.has(role)) continue;
    const rawName = match[2];
    const name = rawName !== undefined ? unescapeQuotedName(rawName) : '';
    const signature = `${role}:${normalizeCountdownText(name)}`;
    items.push({ ref, role, name, signature });
  }
  return items;
}

export function diffNewInteractiveRef(
  beforeSnapshot: string,
  afterSnapshot: string,
): { ref: string; role: string; name: string } | undefined {
  const beforeItems = parseInteractiveRefItems(beforeSnapshot);
  const afterItems = parseInteractiveRefItems(afterSnapshot);

  const beforeCounts = new Map<string, number>();
  const beforeRefSig = new Map<string, string>();
  for (const item of beforeItems) {
    beforeCounts.set(item.signature, (beforeCounts.get(item.signature) ?? 0) + 1);
    beforeRefSig.set(item.ref, item.signature);
  }

  const matchedAfter = new Array<boolean>(afterItems.length).fill(false);

  // Consume exact ref+signature matches first so a newly inserted control
  // above an existing identical control is identified accurately.
  for (let i = 0; i < afterItems.length; i++) {
    const item = afterItems[i]!;
    if (beforeRefSig.get(item.ref) === item.signature) {
      const remaining = beforeCounts.get(item.signature) ?? 0;
      if (remaining > 0) {
        beforeCounts.set(item.signature, remaining - 1);
        matchedAfter[i] = true;
      }
    }
  }

  const added: Array<{ ref: string; role: string; name: string }> = [];
  for (let i = 0; i < afterItems.length; i++) {
    if (matchedAfter[i]) continue;
    const item = afterItems[i]!;
    const remaining = beforeCounts.get(item.signature) ?? 0;
    if (remaining > 0) {
      beforeCounts.set(item.signature, remaining - 1);
    } else {
      added.push({ ref: item.ref, role: item.role, name: item.name });
    }
  }

  if (added.length !== 1) return undefined;
  const only = added[0]!;
  // Only return a main-frame Playwright ARIA widget ref: supplementary `sN`
  // tags (`file-input`, `custom-element`, `input`, `textarea`, `select`) are
  // not valid `getByRole()` roles, and un-framed `f<seq>eN` refs live inside
  // an iframe whose frame chain this diff helper does not carry.
  if (
    only.ref.startsWith('s')
    || FRAME_REF_PREFIX_RE.test(only.ref)
    || !PLAYWRIGHT_INTERACTIVE_ROLES.has(only.role)
  ) {
    return undefined;
  }
  return only;
}

export interface WaitForSnapshotChangeOptions {
  baselineSnapshot: string;
  baselineUrl: string;
  budgetMs: number;
  totalBudgetMs?: number | undefined;
  alreadyElapsedMs?: number | undefined;
  minTextChangeIntervalMs?: number | undefined;
  debounceMs?: number | undefined;
  maxIframeDepth?: number | undefined;
  domSnapshotCharLimit?: number | undefined;
  /** Run secrets (`secretsNow()`) to redact from polled ARIA snapshots before diffing against a redacted baseline. */
  secrets?: string[] | undefined;
  signal?: AbortSignal | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  onHeartbeat?: ((elapsedMs: number, totalBudgetMs: number) => void) | undefined;
}

export interface WaitForSnapshotChangeResult {
  changed: boolean;
  timedOut: boolean;
  urlChanged: boolean;
  newInteractiveControl: boolean;
  elapsedMs: number;
}

function makeAbortError(): DOMException {
  return new DOMException('Run aborted by client', 'AbortError');
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(makeAbortError());
  }
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      reject(makeAbortError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    void work.catch(() => undefined);
    return Promise.reject(makeAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      void work.catch(() => undefined);
      reject(makeAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

async function collectSecretFieldValuesAcrossFrames(
  page: Page,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const secretFieldValues: string[] = [];
  if (typeof page.frames !== 'function') return secretFieldValues;
  let frames: Frame[];
  try {
    frames = page.frames();
  } catch {
    return secretFieldValues;
  }
  const script = buildSupplementaryScanScript(1, false);
  for (const frame of frames) {
    if (signal?.aborted) throw makeAbortError();
    if (frame.isDetached()) continue;
    try {
      const scan = await raceAbort(
        evaluateWithTimeout<FrameScanResult>(frame, script, timeoutMs),
        signal,
      );
      if (scan && Array.isArray(scan.secretValues)) {
        secretFieldValues.push(...scan.secretValues);
      }
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) throw err;
      // Cross-origin or detached frames are best-effort here.
    }
  }
  return secretFieldValues;
}

export async function waitForSnapshotChange(
  page: Page,
  opts: WaitForSnapshotChangeOptions,
): Promise<WaitForSnapshotChangeResult> {
  const now = opts.now ?? Date.now;
  const sleepFn = opts.sleep ?? abortableSleep;

  if (opts.signal?.aborted) {
    throw makeAbortError();
  }

  const baselineWasClipped = opts.baselineSnapshot.includes(ARIA_SNAPSHOT_TRUNCATION_MARKER);
  const clipLimit =
    opts.domSnapshotCharLimit ?? (baselineWasClipped ? DEFAULT_ARIA_SNAPSHOT_CHAR_LIMIT : undefined);
  const initialSecrets = collectAriaSecrets(opts.secrets, []);
  const strippedBaseline = stripSupplementaryAriaSections(opts.baselineSnapshot);
  const baseline = normalizeSnapshotForDiff(
    initialSecrets.longSecrets.length > 0
      ? redactPreservingRefs(strippedBaseline, initialSecrets.longSecrets, [])
      : strippedBaseline,
  );

  const canScanFrames = typeof page.frames === 'function';
  let hasScannedSecretFields = !canScanFrames;
  let cachedSecrets = initialSecrets;
  let lastScannedRawYaml: string | undefined;

  const diffPolledSnapshot = (
    yaml: string,
    secrets: { longSecrets: string[]; shortFieldSecrets: string[] },
  ): { newInteractiveControl: boolean; textChanged: boolean } => {
    const redacted = redactPreservingRefs(yaml, secrets.longSecrets, secrets.shortFieldSecrets);
    const clipped =
      clipLimit !== undefined && redacted.length > clipLimit
        ? sliceWholeCodePoints(redacted, clipLimit)
        : redacted;
    const current = normalizeSnapshotForDiff(clipped);
    let newInteractiveControl = false;
    for (const sig of current.interactiveSignatures) {
      if (!baseline.interactiveSignatures.has(sig)) {
        newInteractiveControl = true;
        break;
      }
    }
    const textChanged = current.normalized !== baseline.normalized;
    return { newInteractiveControl, textChanged };
  };

  const start = now();
  const budget = Math.max(0, opts.budgetMs);
  const deadline = start + budget;
  const baseElapsed = Math.max(0, opts.alreadyElapsedMs ?? 0);
  const totalBudget = opts.totalBudgetMs ?? opts.budgetMs;
  const minTextInterval = Math.max(0, opts.minTextChangeIntervalMs ?? 0);
  const debounceMs = Math.max(0, opts.debounceMs ?? 150);

  if (baseElapsed === 0) {
    logger.info(`Waiting up to ${Math.ceil(totalBudget / 1000)}s for page change…`);
  }

  let nextHeartbeatAt = (Math.floor(baseElapsed / HEARTBEAT_INTERVAL_MS) + 1) * HEARTBEAT_INTERVAL_MS;
  const maybeEmitHeartbeat = (): void => {
    const totalElapsed = baseElapsed + Math.max(0, now() - start);
    while (totalElapsed >= nextHeartbeatAt) {
      logger.info(
        `Still waiting for page change — ${Math.floor(totalElapsed / 1000)}s of ${Math.ceil(totalBudget / 1000)}s elapsed`,
      );
      opts.onHeartbeat?.(totalElapsed, totalBudget);
      nextHeartbeatAt += HEARTBEAT_INTERVAL_MS;
    }
  };

  const readUrlSafe = (): string => {
    try {
      return page.url();
    } catch {
      return opts.baselineUrl;
    }
  };

  while (now() < deadline) {
    if (opts.signal?.aborted) {
      throw makeAbortError();
    }
    maybeEmitHeartbeat();

    const currentUrl = readUrlSafe();
    const urlChanged = currentUrl !== '' && currentUrl !== opts.baselineUrl;

    const snapTimeout = Math.max(500, Math.min(5_000, Math.max(0, deadline - now())));
    let rawYaml: string | null = null;
    let navInterrupted = false;
    try {
      rawYaml = await raceAbort(
        page.locator('html').ariaSnapshot({ mode: 'ai', timeout: snapTimeout }),
        opts.signal,
      );
    } catch (err) {
      if (opts.signal?.aborted || isAbortError(err)) {
        throw err;
      }
      if (typeof page.isClosed === 'function' && page.isClosed()) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (NAV_CONTEXT_DESTROYED_RE.test(msg)) {
        navInterrupted = true;
      }
    }

    if (opts.signal?.aborted) {
      throw makeAbortError();
    }

    if (navInterrupted) {
      const loadWait = Math.min(2_000, Math.max(0, deadline - now()));
      if (loadWait > 0 && typeof page.waitForLoadState === 'function') {
        try {
          await raceAbort(
            page.waitForLoadState('domcontentloaded', { timeout: loadWait }),
            opts.signal,
          );
        } catch (err) {
          if (opts.signal?.aborted || isAbortError(err)) {
            throw err;
          }
        }
      }
      const postNavUrl = readUrlSafe();
      if (postNavUrl !== '' && postNavUrl !== opts.baselineUrl) {
        const d = Math.min(debounceMs, Math.max(0, deadline - now()));
        if (d > 0) await sleepFn(d, opts.signal);
        if (opts.signal?.aborted) throw makeAbortError();
        return {
          changed: true,
          timedOut: false,
          urlChanged: true,
          newInteractiveControl: false,
          elapsedMs: Math.max(0, now() - start),
        };
      }
      const rem = deadline - now();
      if (rem <= 0) break;
      await sleepFn(Math.min(200, rem), opts.signal);
      if (opts.signal?.aborted) throw makeAbortError();
      continue;
    }

    let newInteractiveControl = false;
    let textChanged = false;
    if (rawYaml !== null) {
      ({ newInteractiveControl, textChanged } = diffPolledSnapshot(rawYaml, cachedSecrets));
      // Lazily scan live secret fields on the first poll that differs from the
      // redacted baseline, and re-scan once per newly changed raw snapshot in
      // case a newly rendered or updated password input appeared. Keeps
      // unchanged polls free of extra evaluate() round-trips while preventing
      // password inputs or run secrets from false-triggering `textChanged`.
      if (
        (textChanged || newInteractiveControl)
        && canScanFrames
        && (!hasScannedSecretFields || rawYaml !== lastScannedRawYaml)
      ) {
        const scanTimeout = Math.max(500, Math.min(FRAME_EVALUATE_TIMEOUT_MS, Math.max(0, deadline - now())));
        const freshSecretFieldValues = await collectSecretFieldValuesAcrossFrames(
          page,
          scanTimeout,
          opts.signal,
        );
        hasScannedSecretFields = true;
        lastScannedRawYaml = rawYaml;
        cachedSecrets = collectAriaSecrets(opts.secrets, freshSecretFieldValues);
        ({ newInteractiveControl, textChanged } = diffPolledSnapshot(rawYaml, cachedSecrets));
      }
    }

    if (urlChanged || newInteractiveControl) {
      const d = Math.min(debounceMs, Math.max(0, deadline - now()));
      if (d > 0) await sleepFn(d, opts.signal);
      if (opts.signal?.aborted) throw makeAbortError();
      return {
        changed: true,
        timedOut: false,
        urlChanged,
        newInteractiveControl,
        elapsedMs: Math.max(0, now() - start),
      };
    }

    if (textChanged && now() - start >= minTextInterval) {
      const d = Math.min(debounceMs, Math.max(0, deadline - now()));
      if (d > 0) await sleepFn(d, opts.signal);
      if (opts.signal?.aborted) throw makeAbortError();
      return {
        changed: true,
        timedOut: false,
        urlChanged: false,
        newInteractiveControl: false,
        elapsedMs: Math.max(0, now() - start),
      };
    }

    const rem = deadline - now();
    if (rem <= 0) break;
    const totalElapsed = baseElapsed + Math.max(0, now() - start);
    const cadence = totalElapsed < 3_000 ? 200 : totalElapsed < 15_000 ? 500 : 1_000;
    await sleepFn(Math.min(cadence, rem), opts.signal);
    if (opts.signal?.aborted) throw makeAbortError();
  }

  return {
    changed: false,
    timedOut: true,
    urlChanged: false,
    newInteractiveControl: false,
    elapsedMs: Math.max(0, now() - start),
  };
}
