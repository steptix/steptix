/**
 * Reading and using the Record Steps toolbar from a test.
 *
 * The toolbar lives in a CLOSED shadow root (stories/steptix-record-toolbar.md),
 * so neither the page nor Playwright's selectors can look inside it. DevTools
 * can: `DOM.getDocument` with `pierce: true` returns closed roots too, with
 * their type. These helpers read the bar's text and find its buttons that way,
 * and click them with Playwright's mouse — trusted input, as a person's is.
 */
import type { CDPSession, Page } from 'playwright';

interface DomNode {
  nodeId: number;
  nodeType: number;
  nodeName: string;
  localName?: string;
  nodeValue?: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
  shadowRootType?: string;
  contentDocument?: DomNode;
}

async function withCdp<T>(page: Page, work: (cdp: CDPSession, root: DomNode) => Promise<T>): Promise<T> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode };
    return await work(cdp, root);
  } finally {
    await cdp.detach().catch(() => {});
  }
}

function attr(node: DomNode, name: string): string | undefined {
  const a = node.attributes ?? [];
  for (let i = 0; i + 1 < a.length; i += 2) if (a[i] === name) return a[i + 1];
  return undefined;
}

function find(node: DomNode, pred: (n: DomNode) => boolean, crossFrames = false): DomNode | null {
  if (pred(node)) return node;
  for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
    const hit = find(child, pred, crossFrames);
    if (hit) return hit;
  }
  if (crossFrames && node.contentDocument) return find(node.contentDocument, pred, crossFrames);
  return null;
}

/** The visible words under a node, an element's children set apart by a
 *  space (the bar lays them out side by side). */
function textOf(node: DomNode): string {
  if (node.nodeType === 3) return node.nodeValue ?? '';
  if (node.nodeType === 1 && attr(node, 'hidden') !== undefined) return '';
  const inner = [...(node.shadowRoots ?? []), ...(node.children ?? [])].map(textOf).join('');
  return node.nodeType === 1 ? ` ${inner} ` : inner;
}

/** The toolbar host in the TOP document (not in frames), or null. */
function hostOf(root: DomNode): DomNode | null {
  return find(root, (n) => n.localName === 'steptix-recorder');
}

export interface ToolbarSnapshot {
  /** 'closed' for the real thing. */
  shadowType: string | undefined;
  /** The status row's text (the second row). */
  sub: string;
  /** The status block: REC / PAUSED, the clock, the count. */
  status: string;
  /** Every visible word in the bar. */
  all: string;
  /** The pill is showing (minimised). */
  minimised: boolean;
}

/** What the toolbar in `page` shows now, or null when there is none. */
export function readToolbar(page: Page): Promise<ToolbarSnapshot | null> {
  return withCdp(page, async (_cdp, root) => {
    const host = hostOf(root);
    if (!host) return null;
    const shadow = host.shadowRoots?.[0];
    if (!shadow) return { shadowType: undefined, sub: '', status: '', all: '', minimised: false };
    const byClass = (cls: string): DomNode | null =>
      find(shadow, (n) => n.nodeType === 1 && (attr(n, 'class') ?? '').split(/\s+/).includes(cls));
    const sub = byClass('sub');
    const status = byClass('status');
    const pill = byClass('pill');
    return {
      shadowType: shadow.shadowRootType,
      sub: sub ? textOf(sub).replace(/\s+/g, ' ').trim() : '',
      status: status ? textOf(status).replace(/\s+/g, ' ').trim() : '',
      all: textOf(shadow).replace(/\s+/g, ' ').trim(),
      minimised: pill !== null && attr(pill, 'hidden') === undefined,
    };
  });
}

/** Run `fn` with `this` the bar's closed shadow root, and answer its result. */
function inBarRoot<T>(page: Page, fn: string): Promise<T> {
  return withCdp(page, async (cdp, root) => {
    const shadow = hostOf(root)?.shadowRoots?.[0];
    if (!shadow) throw new Error('the page has no toolbar');
    const { object } = (await cdp.send('DOM.resolveNode', { nodeId: shadow.nodeId })) as { object: { objectId: string } };
    const { result } = (await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: fn,
      returnByValue: true,
    })) as { result: { value: T } };
    return result.value;
  });
}

/**
 * Log every status the bar shows from now on (REC…, PAUSED…), and answer a
 * reader for the log. A MutationObserver in the bar's own root writes it as
 * the page renders, so a status the page shows for a moment — a Pause it
 * shows ahead of the server's answer, and takes back when none comes — is in
 * the log however late the test gets to read it. `readToolbar` sees only what
 * shows at the instant its read lands.
 */
export async function watchStatus(page: Page): Promise<() => Promise<string[]>> {
  await inBarRoot<void>(
    page,
    `function () {
      const root = this;
      const now = () => ((root.querySelector('.status') || {}).textContent || '').replace(/\\s+/g, ' ').trim();
      const log = [now()];
      root.__statusLog = log;
      new MutationObserver(() => {
        const s = now();
        if (s !== log[log.length - 1]) log.push(s);
      }).observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    }`,
  );
  return () => inBarRoot<string[]>(page, 'function () { return this.__statusLog || []; }');
}

/** Where a toolbar button (`data-cmd`) is on screen, or null. */
export function toolbarButtonAt(page: Page, cmd: string): Promise<{ x: number; y: number } | null> {
  return withCdp(page, async (cdp, root) => {
    const host = hostOf(root);
    const button = host ? find(host, (n) => n.nodeType === 1 && attr(n, 'data-cmd') === cmd) : null;
    if (!button) return null;
    try {
      const { model } = (await cdp.send('DOM.getBoxModel', { nodeId: button.nodeId })) as {
        model: { content: number[] };
      };
      const q = model.content;
      return { x: (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y: (q[1]! + q[3]! + q[5]! + q[7]!) / 4 };
    } catch {
      return null;
    }
  });
}

/**
 * Where a control of the bar is once it is showing and has stopped moving:
 * two reads a moment apart that agree. The bar rebuilds a row whenever what
 * it shows changes — a step lands, "updating…" comes or goes, a notice
 * shows — and the server's push can land at any moment, so a control looked
 * up just after a test's last wait may be mid-rebuild: its node detached
 * before its box is read, or moved by the time the mouse gets there. Waits up
 * to `timeoutMs`, then throws `missing` with what the bar showed instead.
 */
async function settledAt(
  page: Page,
  locate: () => Promise<{ x: number; y: number } | null>,
  missing: string,
  timeoutMs = 8_000,
): Promise<{ x: number; y: number }> {
  const end = Date.now() + timeoutMs;
  let at = await locate();
  for (;;) {
    await new Promise((r) => setTimeout(r, 60));
    const again = await locate();
    if (at && again && Math.abs(again.x - at.x) < 0.5 && Math.abs(again.y - at.y) < 0.5) return again;
    at = again;
    if (Date.now() > end) {
      const bar = await readToolbar(page).catch(() => null);
      throw new Error(`${missing}; the bar shows: ${bar ? JSON.stringify(bar.all) : 'no toolbar'}`);
    }
  }
}

/** Click a toolbar button with the real (trusted) mouse, once it is showing
 *  and has stopped moving. */
export async function clickToolbar(page: Page, cmd: string): Promise<void> {
  const at = await settledAt(page, () => toolbarButtonAt(page, cmd), `the toolbar has no "${cmd}" button showing`);
  await page.mouse.click(at.x, at.y);
}

/** The value of the toolbar's step box. */
export function stepBoxValue(page: Page): Promise<string | null> {
  return withCdp(page, async (cdp, root) => {
    const host = hostOf(root);
    const input = host ? find(host, (n) => n.localName === 'input') : null;
    if (!input) return null;
    const { object } = (await cdp.send('DOM.resolveNode', { nodeId: input.nodeId })) as { object: { objectId: string } };
    const { result } = (await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function () { return this.value; }',
      returnByValue: true,
    })) as { result: { value: string } };
    return result.value;
  });
}

/** One row of the Steps so far drawer, as it shows. */
export interface DrawerRow {
  /** The step id the row is for. */
  id: string;
  kind: 'live' | 'deleted' | 'restoring' | 'pending';
  /** Its words — or, while it is being edited, what is in its box. */
  text: string;
  /** The number shown ('' for a struck row). */
  n: string;
  yours: boolean;
  /** It is being edited in place. */
  editing: boolean;
}

export interface DrawerSnapshot {
  open: boolean;
  rows: DrawerRow[];
  foot: string;
  /** Any lock glyph anywhere in the bar (the drawer, the status row). */
  lock: boolean;
}

/** The lock icon's shackle — the path only the lock glyph draws. */
const LOCK_SHACKLE = 'M4 5.2V3.8a2 2 0 0 1 4 0v1.4';

/** The drawer of the toolbar in `page`, or null when there is no toolbar. */
export function readDrawer(page: Page): Promise<DrawerSnapshot | null> {
  return withCdp(page, async (cdp, root) => {
    const host = hostOf(root);
    const shadow = host?.shadowRoots?.[0];
    if (!shadow) return null;
    const hasClass = (n: DomNode, cls: string): boolean =>
      n.nodeType === 1 && (attr(n, 'class') ?? '').split(/\s+/).includes(cls);
    const drawer = find(shadow, (n) => hasClass(n, 'drawer'));
    const lock = find(shadow, (n) => n.localName === 'path' && attr(n, 'd') === LOCK_SHACKLE) !== null;
    if (!drawer) return { open: false, rows: [], foot: '', lock };
    const rows: DrawerRow[] = [];
    const walk = async (n: DomNode): Promise<void> => {
      if (n.localName === 'li' && hasClass(n, 'row')) {
        const cls = (attr(n, 'class') ?? '').split(/\s+/);
        const kind = (['live', 'deleted', 'restoring', 'pending'] as const).find((k) => cls.includes(k)) ?? 'live';
        const t = find(n, (c) => hasClass(c, 't'));
        const input = find(n, (c) => c.localName === 'input');
        const num = find(n, (c) => hasClass(c, 'n'));
        let text = t ? textOf(t).replace(/\s+/g, ' ').trim() : '';
        if (input) text = await valueOf(cdp, input.nodeId);
        rows.push({
          id: attr(n, 'data-row-id') ?? '',
          kind,
          text,
          n: num ? textOf(num).trim() : '',
          yours: find(n, (c) => hasClass(c, 'yours')) !== null,
          editing: input !== null,
        });
        return;
      }
      for (const c of n.children ?? []) await walk(c);
    };
    await walk(drawer);
    const foot = find(drawer, (n) => hasClass(n, 'foot'));
    return {
      open: attr(drawer, 'hidden') === undefined,
      rows,
      foot: foot ? textOf(foot).replace(/\s+/g, ' ').trim() : '',
      lock,
    };
  });
}

async function valueOf(cdp: CDPSession, nodeId: number): Promise<string> {
  const { object } = (await cdp.send('DOM.resolveNode', { nodeId })) as { object: { objectId: string } };
  const { result } = (await cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: 'function () { return this.value; }',
    returnByValue: true,
  })) as { result: { value: string } };
  return result.value;
}

async function centreOf(cdp: CDPSession, nodeId: number): Promise<{ x: number; y: number } | null> {
  try {
    const { model } = (await cdp.send('DOM.getBoxModel', { nodeId })) as { model: { content: number[] } };
    const q = model.content;
    return { x: (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y: (q[1]! + q[3]! + q[5]! + q[7]!) / 4 };
  } catch {
    return null;
  }
}

/** Where a drawer row (`cmd` null) or one of its controls is on screen:
 *  `row-edit` (its words), `row-delete` (✕), `row-restore`, `row-insert` (the
 *  + in the gap below it). */
export function drawerAt(page: Page, id: string, cmd: string | null): Promise<{ x: number; y: number } | null> {
  return withCdp(page, async (cdp, root) => {
    const host = hostOf(root);
    const node = host
      ? find(host, (n) =>
          n.nodeType === 1 &&
          (cmd === null
            ? n.localName === 'li' && attr(n, 'data-row-id') === id
            : attr(n, 'data-cmd') === cmd && attr(n, 'data-id') === id),
        )
      : null;
    return node ? centreOf(cdp, node.nodeId) : null;
  });
}

/** Use a drawer row's control with the real mouse: the pointer goes over
 *  the row first — its ✕ and + show on hover — then onto the control. Both
 *  are found once they have stopped moving: a push that adds a row
 *  ("updating…") grows a bottom-docked bar upward, and every row moves. */
export async function clickDrawer(page: Page, id: string, cmd: string): Promise<void> {
  const row = await settledAt(page, () => drawerAt(page, id, null), `the drawer has no row for ${id}`);
  await page.mouse.move(row.x, row.y);
  await new Promise((r) => setTimeout(r, 80));
  const at = await settledAt(page, () => drawerAt(page, id, cmd), `the row for ${id} has no "${cmd}"`);
  await page.mouse.move(at.x, at.y, { steps: 3 });
  await new Promise((r) => setTimeout(r, 50));
  await page.mouse.click(at.x, at.y);
}

/** Where keyboard focus is inside the bar, and whether it shows. */
export function barFocus(page: Page): Promise<{ cmd: string | null; id: string | null; row: boolean; visible: boolean } | null> {
  return withCdp(page, async (cdp, root) => {
    const shadow = hostOf(root)?.shadowRoots?.[0];
    if (!shadow) return null;
    const { object } = (await cdp.send('DOM.resolveNode', { nodeId: shadow.nodeId })) as { object: { objectId: string } };
    const { result } = (await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration:
        'function () { const a = this.activeElement; if (!a) return null; return { cmd: a.getAttribute("data-cmd"), ' +
        'id: a.getAttribute("data-row-id") || a.getAttribute("data-id"), row: a.localName === "li", ' +
        'visible: a.matches(":focus-visible") }; }',
      returnByValue: true,
    })) as { result: { value: { cmd: string | null; id: string | null; row: boolean; visible: boolean } | null } };
    return result.value;
  });
}

/** The boxes of the bar's main row and its drawer, and of the host. */
export function barBoxes(page: Page): Promise<{ main: DOMRectLike; drawer: DOMRectLike; host: DOMRectLike } | null> {
  return withCdp(page, async (cdp, root) => {
    const host = hostOf(root);
    const shadow = host?.shadowRoots?.[0];
    if (!host || !shadow) return null;
    const byClass = (cls: string): DomNode | null =>
      find(shadow, (n) => n.nodeType === 1 && (attr(n, 'class') ?? '').split(/\s+/).includes(cls));
    const box = async (n: DomNode | null): Promise<DOMRectLike | null> => {
      if (!n) return null;
      try {
        const { model } = (await cdp.send('DOM.getBoxModel', { nodeId: n.nodeId })) as { model: { border: number[] } };
        const q = model.border;
        return { x: q[0]!, y: q[1]!, width: q[2]! - q[0]!, height: q[5]! - q[1]! };
      } catch {
        return null;
      }
    };
    const [m, d, h] = await Promise.all([box(byClass('main')), box(byClass('drawer')), box(host)]);
    return m && d && h ? { main: m, drawer: d, host: h } : null;
  });
}

export interface DOMRectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Wait until `check` answers true, or throw saying what was last seen. */
export async function until<T>(
  read: () => Promise<T>,
  check: (value: T) => boolean,
  what: string,
  timeoutMs = 8_000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: T = await read();
  while (!check(last)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last seen: ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 40));
    last = await read();
  }
  return last;
}
