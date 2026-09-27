/**
 * Reading and using the Record Steps toolbar from a test.
 *
 * The toolbar lives in a CLOSED shadow root (stories/testbench-record-toolbar.md),
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
  return find(root, (n) => n.localName === 'aiui-recorder');
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

/** Click a toolbar button with the real (trusted) mouse. */
export async function clickToolbar(page: Page, cmd: string): Promise<void> {
  const at = await toolbarButtonAt(page, cmd);
  if (!at) throw new Error(`the toolbar has no "${cmd}" button showing`);
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
