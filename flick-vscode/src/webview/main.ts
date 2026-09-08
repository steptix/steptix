// Flick webview UI. Runs inside the VS Code webview sandbox and talks to the
// extension host over the message protocol in src/shared/protocol.ts.
//
// Adapted from SPEC-FLICK.md: the standalone Tauri window becomes a sidebar
// webview view, so window sizing / always-on-top / window-title behaviours are
// dropped, and the colour palette follows the active VS Code theme. The chat,
// tabs, session management, result cards, screenshots, settings, connection
// status, stale-session banner and toasts are all preserved.

import type {
  BatchResult,
  CdpDiscoveryPort,
  CdpDiscoveryTab,
  CdpEngine,
  CdpInstalledBrowsers,
  ConnectionStatus,
  FlickSettings,
  HistoryEntry,
  HostToWebview,
  ServerSessionItem,
  SessionMeta,
  StepResult,
  StepStatus,
  WebviewToHost,
} from '../shared/protocol';
import { buildOutputSections } from './output-sections';
import {
  autoExpandsOnFirstRender,
  showsBatchError,
  skipReason,
  statusGlyph,
  statusLabel,
} from './step-status';

interface VsCodeApi {
  postMessage(msg: WebviewToHost): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
function post(msg: WebviewToHost): void {
  vscode.postMessage(msg);
}

// --- local UI state ---------------------------------------------------------

const state = {
  sessions: [] as SessionMeta[],
  activeSessionId: null as string | null,
  settings: { apiUrl: '', apiKey: '', defaultBaseUrl: '', defaultTimeout: '' } as FlickSettings,
  connection: 'unknown' as ConnectionStatus,
  /** Per-session chat history, only populated for sessions we've opened. */
  histories: new Map<string, HistoryEntry[]>(),
  busy: new Set<string>(),
  /** Expanded step rows, keyed by `${entryId}:${stepIndex}`. */
  expanded: new Set<string>(),
  /** Keys we've already auto-expanded once on first render. Without this,
   *  failed/error steps re-expanded on every renderChat, so a user collapse
   *  was instantly reversed by the next state broadcast. */
  autoExpanded: new Set<string>(),
  draft: '',
  settingsOpen: false,
  // Adopt-server-session dropdown.
  adoptOpen: false,
  adoptLoading: false,
  adoptError: null as string | null,
  adoptList: null as ServerSessionItem[] | null,
  // CDP discovery (lives alongside the server-session list in the dropdown).
  cdpLoading: false,
  cdpPorts: null as CdpDiscoveryPort[] | null,
  cdpInstalled: null as CdpInstalledBrowsers | null,
  /** Engines whose Launch button is currently mid-spawn. Cleared on the next
   *  cdpDiscovery or cdpLaunchResult, whichever lands first. */
  cdpLaunching: new Set<'chrome' | 'edge'>(),
};

// --- root layout (built once) ----------------------------------------------

const app = document.getElementById('app') as HTMLDivElement;
app.innerHTML = `
  <div class="topbar">
    <div class="tabs" id="tabs"></div>
    <button class="tab-add" id="tab-add" title="New session">+</button>
    <div class="adopt-wrap">
      <button class="tab-adopt" id="tab-adopt" title="Attach an existing server session" aria-haspopup="listbox" aria-expanded="false">▾</button>
      <div class="adopt-panel" id="adopt-panel" hidden role="listbox"></div>
    </div>
    <div class="topbar-right">
      <span class="status-dot" id="status-dot" title="Connection status"></span>
      <button class="icon-btn" id="settings-btn" title="Settings">⚙</button>
    </div>
  </div>
  <div class="chat" id="chat"></div>
  <div class="composer">
    <div class="stale-banner" id="stale-banner" hidden>
      Server session was reset. A new browser will start on the next step.
    </div>
    <div class="input-row">
      <textarea id="input" rows="3" placeholder="Type your steps here..."></textarea>
      <button class="send-btn" id="send-btn" title="Send (Enter)">➤</button>
    </div>
  </div>
  <div class="settings-overlay" id="settings-overlay" hidden></div>
  <div class="image-overlay" id="image-overlay" hidden>
    <img id="image-overlay-img" alt="Screenshot" />
  </div>
  <div class="toasts" id="toasts"></div>
`;

const tabsEl = byId<HTMLDivElement>('tabs');
const chatEl = byId<HTMLDivElement>('chat');
const inputEl = byId<HTMLTextAreaElement>('input');
const sendBtn = byId<HTMLButtonElement>('send-btn');
const statusDot = byId<HTMLSpanElement>('status-dot');
const staleBanner = byId<HTMLDivElement>('stale-banner');
const settingsOverlay = byId<HTMLDivElement>('settings-overlay');
const imageOverlay = byId<HTMLDivElement>('image-overlay');
const imageOverlayImg = byId<HTMLImageElement>('image-overlay-img');
const toastsEl = byId<HTMLDivElement>('toasts');
const adoptBtn = byId<HTMLButtonElement>('tab-adopt');
const adoptPanel = byId<HTMLDivElement>('adopt-panel');

// --- input box --------------------------------------------------------------

inputEl.addEventListener('input', () => {
  state.draft = inputEl.value;
});
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});
sendBtn.addEventListener('click', submit);

function submit(): void {
  const text = inputEl.value.trim();
  if (!text || !state.activeSessionId) return;
  if (state.busy.has(state.activeSessionId)) return;
  post({ type: 'submitSteps', sessionId: state.activeSessionId, rawText: text });
  inputEl.value = '';
  state.draft = '';
}

byId<HTMLButtonElement>('tab-add').addEventListener('click', () => post({ type: 'newSession' }));
byId<HTMLButtonElement>('settings-btn').addEventListener('click', openSettings);
adoptBtn.addEventListener('click', toggleAdoptDropdown);

// Close the dropdown when clicking outside it. The capture-phase listener
// fires before any inner click handler, so it can swallow without preventing
// the adoption itself (which uses `mousedown` on the panel rows? No — the
// row uses `click`, which still fires after `mousedown` so order is fine).
document.addEventListener('mousedown', (e) => {
  if (!state.adoptOpen) return;
  const target = e.target as Node | null;
  if (target && (adoptPanel.contains(target) || adoptBtn.contains(target))) return;
  closeAdoptDropdown();
});

// --- image overlay ----------------------------------------------------------

imageOverlay.addEventListener('click', (e) => {
  if (e.target === imageOverlay) closeImageOverlay();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!imageOverlay.hidden) closeImageOverlay();
    else if (state.settingsOpen) closeSettings();
  }
});

function openImageOverlay(uri: string): void {
  imageOverlayImg.src = uri;
  imageOverlay.hidden = false;
}
function closeImageOverlay(): void {
  imageOverlay.hidden = true;
  imageOverlayImg.removeAttribute('src');
}

// --- host -> webview messages ----------------------------------------------

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      state.sessions = msg.sessions;
      state.activeSessionId = msg.activeSessionId;
      state.settings = msg.settings;
      state.connection = msg.connection;
      renderTabs();
      renderConnection();
      renderChat();
      updateComposer();
      break;
    case 'sessions': {
      const switched = msg.activeSessionId !== state.activeSessionId;
      state.sessions = msg.sessions;
      state.activeSessionId = msg.activeSessionId;
      renderTabs();
      if (switched) {
        renderChat();
        if (state.activeSessionId && !state.histories.has(state.activeSessionId)) {
          post({ type: 'requestHistory', sessionId: state.activeSessionId });
        }
      } else {
        renderStaleBanner();
      }
      updateComposer();
      break;
    }
    case 'history':
      state.histories.set(msg.sessionId, msg.entries);
      if (msg.sessionId === state.activeSessionId) {
        renderChat();
        scrollToBottom();
      }
      break;
    case 'historyAppend': {
      const list = state.histories.get(msg.sessionId) ?? [];
      list.push(msg.entry);
      state.histories.set(msg.sessionId, list);
      if (msg.sessionId === state.activeSessionId) {
        renderChat();
        scrollToBottom();
      }
      break;
    }
    case 'historyReplace': {
      const list = state.histories.get(msg.sessionId);
      if (list) {
        const idx = list.findIndex((e) => e.id === msg.entryId);
        if (idx >= 0) list[idx] = msg.entry;
        else list.push(msg.entry);
      }
      if (msg.sessionId === state.activeSessionId) {
        renderChat();
        scrollToBottom();
      }
      break;
    }
    case 'connection':
      state.connection = msg.connection;
      renderConnection();
      break;
    case 'busy':
      if (msg.busy) state.busy.add(msg.sessionId);
      else state.busy.delete(msg.sessionId);
      if (msg.sessionId === state.activeSessionId) {
        updateComposer();
        // On run completion, return focus to the input so the user can type
        // the next step without reaching for the mouse. updateComposer has
        // just re-enabled the textarea.
        if (!msg.busy) inputEl.focus();
      }
      break;
    case 'settings':
      state.settings = msg.settings;
      if (state.settingsOpen) renderSettings();
      break;
    case 'showSettings':
      openSettings();
      break;
    case 'toast':
      if (msg.message) showToast(msg.level, msg.message);
      break;
    case 'serverSessions':
      state.adoptLoading = false;
      state.adoptError = msg.error;
      state.adoptList = msg.sessions;
      renderAdoptPanel();
      break;
    case 'cdpDiscovery':
      state.cdpLoading = false;
      state.cdpPorts = msg.ports;
      state.cdpInstalled = msg.installed;
      // Only clear the spinner for engines whose freshly-spawned port is now
      // visible — leave others alone so a refresh fired DURING a launch
      // (manual ⟳, or a second webview opening the dropdown) does not flip
      // the button back to clickable while the host is still spawning.
      // cdpLaunchResult is the authoritative "done" signal; this is the
      // belt-and-braces clear once the new browser actually shows up.
      for (const engine of [...state.cdpLaunching]) {
        if (engineDiscovered(engine, msg.ports, msg.installed)) {
          state.cdpLaunching.delete(engine);
        }
      }
      renderAdoptPanel();
      break;
    case 'cdpLaunchResult':
      state.cdpLaunching.delete(msg.engine);
      if (!msg.ok) {
        const engineLabel = msg.engine === 'chrome' ? 'Chrome' : 'Edge';
        showToast('error', `Couldn't launch ${engineLabel}: ${msg.error ?? 'unknown error'}`);
      }
      renderAdoptPanel();
      break;
  }
});

// --- tabs -------------------------------------------------------------------

function renderTabs(): void {
  tabsEl.innerHTML = '';
  for (const session of state.sessions) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (session.id === state.activeSessionId ? ' active' : '');
    tab.title = session.id;

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = session.name;
    name.addEventListener('click', (e) => {
      if (session.id === state.activeSessionId) {
        e.stopPropagation();
        beginRename(session, name);
      }
    });

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Delete session';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      post({ type: 'deleteSession', sessionId: session.id });
    });

    if (session.stale) {
      const dot = document.createElement('span');
      dot.className = 'tab-stale';
      dot.title = 'Server session was reset';
      tab.appendChild(dot);
    }
    tab.appendChild(name);
    if (session.cdp) {
      const badge = document.createElement('span');
      badge.className = 'cdp-badge';
      badge.textContent = `CDP:${session.cdp.port}`;
      badge.title = `Attached via CDP on port ${session.cdp.port}`;
      tab.appendChild(badge);
    }
    tab.appendChild(close);
    tab.addEventListener('click', () => {
      if (session.id !== state.activeSessionId) {
        post({ type: 'switchSession', sessionId: session.id });
      }
    });
    tab.addEventListener('dblclick', () => beginRename(session, name));
    tabsEl.appendChild(tab);
  }
}

// --- adopt-server-session dropdown -----------------------------------------

function toggleAdoptDropdown(): void {
  if (state.adoptOpen) {
    closeAdoptDropdown();
    return;
  }
  state.adoptOpen = true;
  state.adoptLoading = true;
  state.adoptError = null;
  state.cdpLoading = true;
  // Keep the previous list visible while the new one loads — refreshing
  // shouldn't blank the panel.
  adoptBtn.setAttribute('aria-expanded', 'true');
  adoptBtn.classList.add('active');
  adoptPanel.hidden = false;
  renderAdoptPanel();
  post({ type: 'listServerSessions' });
  post({ type: 'discoverCdp' });
}

function closeAdoptDropdown(): void {
  state.adoptOpen = false;
  adoptBtn.setAttribute('aria-expanded', 'false');
  adoptBtn.classList.remove('active');
  adoptPanel.hidden = true;
}

function renderAdoptPanel(): void {
  if (!state.adoptOpen) return;
  adoptPanel.innerHTML = '';

  adoptPanel.appendChild(renderServerSessionsSection());
  adoptPanel.appendChild(renderCdpSection());
  adoptPanel.appendChild(renderLaunchCta());
}

function renderServerSessionsSection(): HTMLElement {
  const section = el('div', 'adopt-section');
  section.appendChild(
    renderSectionHeader('Server sessions', () => {
      state.adoptLoading = true;
      state.adoptError = null;
      renderAdoptPanel();
      post({ type: 'listServerSessions' });
    }, state.adoptLoading),
  );

  if (state.adoptLoading && !state.adoptList) {
    section.appendChild(el('div', 'adopt-empty', 'Loading…'));
    return section;
  }
  if (state.adoptError) {
    section.appendChild(el('div', 'adopt-error', state.adoptError));
    return section;
  }
  const list = state.adoptList ?? [];
  if (list.length === 0) {
    section.appendChild(el('div', 'adopt-empty', 'No active sessions.'));
    return section;
  }
  for (const item of list) {
    section.appendChild(renderAdoptRow(item));
  }
  return section;
}

function renderCdpSection(): HTMLElement {
  const wrap = el('div', 'adopt-cdp-wrap');

  // Loading-only state: never seen any discovery yet, request is pending.
  if (state.cdpLoading && !state.cdpPorts) {
    const section = el('div', 'adopt-section');
    section.appendChild(renderSectionHeader('Looking for browsers…', refreshCdp, true));
    section.appendChild(el('div', 'adopt-empty', 'Looking for browsers…'));
    wrap.appendChild(section);
    return wrap;
  }

  // Only show ports a CDP browser is actually listening on. Unreachable ports
  // (the common case — nothing on 9223/9229) are omitted so the dropdown
  // collapses to just the Launch CTA when nothing is attached. Node.js
  // --inspect endpoints answer CDP too (port 9229 is its default) but aren't
  // attachable browsers, so they're excluded as well. See Delta 1 in
  // stories/flick-vscode-cdp-attach.md.
  const ports = (state.cdpPorts ?? []).filter((p) => p.reachable && p.engine !== 'node');
  for (const port of ports) {
    wrap.appendChild(renderCdpPortSection(port));
  }
  return wrap;
}

function renderCdpPortSection(port: CdpDiscoveryPort): HTMLElement {
  const section = el('div', 'adopt-section');
  const label = sectionLabelForEngine(port.engine, port.port);
  section.appendChild(renderSectionHeader(label, refreshCdp, state.cdpLoading, port.error));

  // tabs === null → reachable but enumeration failed; the header already shows
  // port.error as subtitle. tabs === [] → reachable, no adoptable pages. In
  // both cases we still offer "+ New tab" (it goes through the runner, not
  // /json/list, so it can work even when enumeration didn't). Only render tab
  // rows when there are tabs to show.
  if (port.tabs && port.tabs.length > 0) {
    for (const tab of port.tabs) {
      section.appendChild(renderCdpTabRow(port, tab));
    }
    section.appendChild(el('div', 'adopt-divider'));
  }

  section.appendChild(renderNewTabRow(port));
  return section;
}

function renderCdpTabRow(port: CdpDiscoveryPort, tab: CdpDiscoveryTab): HTMLElement {
  const row = el('button', 'adopt-tab-row') as HTMLButtonElement;
  row.type = 'button';
  row.title = tab.url || tab.targetId;

  const title = el('div', 'adopt-tab-title');
  title.appendChild(el('span', 'adopt-tab-icon', '🌐'));
  title.appendChild(el('span', 'adopt-tab-name', cdpTabName(tab)));
  row.appendChild(title);

  // about:blank has no meaningful URL to show on the second line.
  if (tab.url && !isBlankTab(tab)) row.appendChild(el('div', 'adopt-tab-url', tab.url));

  row.addEventListener('click', (e) => {
    e.stopPropagation();
    post({
      type: 'adoptCdpTab',
      port: port.port,
      targetId: tab.targetId,
      title: tab.title || undefined,
      url: tab.url || undefined,
    });
    closeAdoptDropdown();
  });
  return row;
}

/** A blank/new tab — nothing meaningful to label or link. A freshly launched
 *  browser starts on one of these. */
function isBlankTab(tab: CdpDiscoveryTab): boolean {
  const url = (tab.url || '').trim();
  return url === '' || url === 'about:blank';
}

/** Human-readable name for a CDP tab row: a friendly "New Tab" for blank tabs,
 *  else the page title, the URL host, or finally the raw target id. */
function cdpTabName(tab: CdpDiscoveryTab): string {
  if (isBlankTab(tab) && !tab.title) return 'New Tab';
  return tab.title || hostFromUrl(tab.url) || tab.targetId;
}

function renderNewTabRow(port: CdpDiscoveryPort): HTMLElement {
  const row = el('button', 'adopt-tab-row adopt-new-tab') as HTMLButtonElement;
  row.type = 'button';
  row.title = `Open a new tab in the browser on port ${port.port}`;
  const engineLabel = engineDisplayName(port.engine);
  row.appendChild(el('span', 'adopt-tab-icon', '＋'));
  row.appendChild(el('span', 'adopt-tab-name', `New tab in this ${engineLabel}`));
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    post({ type: 'newTabInCdp', port: port.port });
    closeAdoptDropdown();
  });
  return row;
}

function renderLaunchCta(): HTMLElement {
  const row = el('div', 'adopt-launch-cta');
  const installed = state.cdpInstalled;
  // Until discovery has come back at least once, hide the CTA — we don't
  // know which buttons to render.
  if (!installed) return row;

  const { chrome, edge } = installed;

  if (!chrome && !edge) {
    const btn = el('button', 'adopt-launch-btn disabled', '🚀 No Chromium browser found.') as HTMLButtonElement;
    btn.type = 'button';
    btn.disabled = true;
    btn.title = 'Install Chrome or Edge to use Launch.';
    row.appendChild(btn);
    return row;
  }

  if (chrome && !edge) {
    row.appendChild(renderLaunchButton('chrome', '🚀 Launch Chrome with CDP…'));
    return row;
  }
  if (edge && !chrome) {
    row.appendChild(renderLaunchButton('edge', '🚀 Launch Edge with CDP…'));
    return row;
  }

  // Both installed — split button. Order: lastLaunched first, else Chrome first.
  row.appendChild(el('span', 'adopt-launch-label', '🚀 Launch with CDP:'));
  const order: Array<'chrome' | 'edge'> =
    installed.lastLaunched === 'edge' ? ['edge', 'chrome'] : ['chrome', 'edge'];
  for (const engine of order) {
    row.appendChild(
      renderLaunchButton(engine, engine === 'chrome' ? 'Chrome' : 'Edge', /*split=*/ true),
    );
  }
  return row;
}

function engineDiscovered(
  engine: 'chrome' | 'edge',
  ports: CdpDiscoveryPort[],
  _installed: CdpInstalledBrowsers,
): boolean {
  // A launched engine is "discovered" once any responding port reports a
  // matching engine string. The launcher always uses port 9222 today, but
  // we don't pin the check to that — if the user has another Chrome already
  // running on 9223, that's still proof the launch happened.
  return ports.some((p) => p.tabs !== null && p.engine === engine);
}

function renderLaunchButton(
  engine: 'chrome' | 'edge',
  label: string,
  split = false,
): HTMLButtonElement {
  const btn = el(
    'button',
    'adopt-launch-btn' + (split ? ' split' : ''),
  ) as HTMLButtonElement;
  btn.type = 'button';
  const pending = state.cdpLaunching.has(engine);
  btn.textContent = pending ? 'Launching…' : label;
  btn.disabled = pending;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.cdpLaunching.has(engine)) return;
    state.cdpLaunching.add(engine);
    renderAdoptPanel();
    post({ type: 'launchBrowserCdp', engine, port: 9222 });
  });
  return btn;
}

function renderSectionHeader(
  label: string,
  onRefresh: () => void,
  loading: boolean,
  subtitle?: string,
): HTMLElement {
  const header = el('div', 'adopt-section-header');
  const titleWrap = el('div', 'adopt-section-title-wrap');
  titleWrap.appendChild(el('span', 'adopt-title', label));
  if (subtitle) titleWrap.appendChild(el('span', 'adopt-section-subtitle', subtitle));
  header.appendChild(titleWrap);

  const refresh = el('button', 'adopt-refresh', '⟳') as HTMLButtonElement;
  refresh.type = 'button';
  refresh.title = 'Refresh';
  refresh.disabled = loading;
  refresh.addEventListener('click', (e) => {
    e.stopPropagation();
    onRefresh();
  });
  header.appendChild(refresh);
  return header;
}

function refreshCdp(): void {
  state.cdpLoading = true;
  renderAdoptPanel();
  post({ type: 'discoverCdp' });
}

function sectionLabelForEngine(engine: CdpEngine, port: number): string {
  switch (engine) {
    case 'chrome':
      return `Chrome tabs (port ${port})`;
    case 'edge':
      return `Edge tabs (port ${port})`;
    case 'chromium':
      return `Chromium tabs (port ${port})`;
    default:
      return `Browser tabs (port ${port})`;
  }
}

function engineDisplayName(engine: CdpEngine): string {
  switch (engine) {
    case 'chrome':
      return 'Chrome';
    case 'edge':
      return 'Edge';
    case 'chromium':
      return 'Chromium';
    default:
      return 'browser';
  }
}

function hostFromUrl(url: string): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function renderAdoptRow(item: ServerSessionItem): HTMLElement {
  const alreadyAdopted = state.sessions.some((s) => s.id === item.sessionId);
  const row = el('div', 'adopt-item' + (alreadyAdopted ? ' adopted' : ''));
  row.setAttribute('role', 'option');
  row.setAttribute('tabindex', '0');
  row.title = item.sessionId;

  const title = el(
    'div',
    'adopt-item-title',
    item.pageTitle || item.currentUrl || `Session ${item.sessionId.slice(0, 8)}`,
  );
  row.appendChild(title);

  const meta = el('div', 'adopt-item-meta');
  meta.appendChild(el('span', `adopt-status adopt-status-${cssSafe(item.status)}`, item.status));
  if (item.currentUrl) meta.appendChild(el('span', 'adopt-url', item.currentUrl));
  meta.appendChild(el('span', 'adopt-steps', `${item.totalStepsExecuted} steps`));
  if (alreadyAdopted) meta.appendChild(el('span', 'adopt-tag', 'already open'));
  row.appendChild(meta);

  row.addEventListener('click', () => {
    post({ type: 'adoptServerSession', item });
    closeAdoptDropdown();
  });
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      post({ type: 'adoptServerSession', item });
      closeAdoptDropdown();
    }
  });
  return row;
}

function cssSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function beginRename(session: SessionMeta, nameEl: HTMLElement): void {
  const editor = document.createElement('input');
  editor.className = 'tab-rename';
  editor.value = session.name;
  nameEl.replaceWith(editor);
  editor.focus();
  editor.select();
  const commit = (save: boolean): void => {
    const value = editor.value;
    editor.replaceWith(nameEl);
    if (save && value.trim() && value.trim() !== session.name) {
      post({ type: 'renameSession', sessionId: session.id, name: value.trim() });
    }
  };
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      commit(false);
    }
  });
  editor.addEventListener('blur', () => commit(true));
}

// --- connection status ------------------------------------------------------

function renderConnection(): void {
  statusDot.className = 'status-dot ' + state.connection;
  statusDot.title =
    state.connection === 'connected'
      ? 'Connected to API server'
      : state.connection === 'disconnected'
        ? 'Cannot connect to API server'
        : 'Checking connection…';
}

// --- composer (input + stale banner) ---------------------------------------

function updateComposer(): void {
  const session = activeSession();
  const busy = !!session && state.busy.has(session.id);
  // The textarea stays usable during a run so the user can queue the next
  // step while the current one executes. Only the Go button is gated on
  // busy (submit() also no-ops on Enter while busy as a backstop).
  inputEl.disabled = !session;
  sendBtn.disabled = !session || busy;
  sendBtn.classList.toggle('busy', busy);
  sendBtn.textContent = busy ? '◌' : '➤';
  // Only restore the draft when the value actually drifted (tab switches);
  // assigning to .value resets the caret to the end, which would yank the
  // cursor away from a user mid-typing if we did it unconditionally.
  if (session && inputEl.value !== state.draft) inputEl.value = state.draft;
  renderStaleBanner();
}

function renderStaleBanner(): void {
  const session = activeSession();
  staleBanner.hidden = !session || !session.stale;
}

// --- chat -------------------------------------------------------------------

function renderChat(): void {
  chatEl.innerHTML = '';
  const session = activeSession();
  if (!session) {
    chatEl.appendChild(
      el('div', 'empty-state', 'No sessions yet. Click + to create one.'),
    );
    return;
  }
  const history = state.histories.get(session.id);
  if (history === undefined) {
    post({ type: 'requestHistory', sessionId: session.id });
    chatEl.appendChild(el('div', 'empty-state', 'Loading…'));
    return;
  }
  if (history.length === 0) {
    chatEl.appendChild(
      el('div', 'empty-state', 'Type natural-language steps below and press Enter.'),
    );
    return;
  }
  // Track the previous result batch's outputs while walking the history so the
  // delta filter (Captures / Tool Outputs only show what's new or changed vs.
  // the prior batch) has something to diff against.
  let prevOutputs: Record<string, string> | undefined;
  for (const entry of history) {
    chatEl.appendChild(renderEntry(entry, prevOutputs));
    // Only advance the delta baseline past *successful* batches. A network
    // error synthesizes a batch with `outputs: {}` (controller.ts) rather than
    // the server's cumulative map; letting it become the baseline would make
    // the next good batch re-report every already-seen capture as "new".
    if (entry.kind === 'result' && entry.batch.status !== 'error') {
      prevOutputs = entry.batch.outputs;
    }
  }
}

function renderEntry(
  entry: HistoryEntry,
  prevOutputs: Record<string, string> | undefined,
): HTMLElement {
  if (entry.kind === 'user') {
    const card = el('div', 'card user-card');
    const pre = document.createElement('pre');
    pre.className = 'user-text';
    pre.textContent = entry.text;
    card.appendChild(pre);
    return card;
  }
  if (entry.kind === 'pending') {
    const card = el('div', 'card pending-card');
    card.appendChild(el('span', 'spinner'));
    card.appendChild(el('span', 'pending-label', 'Running steps…'));
    return card;
  }
  return renderResultCard(entry.id, entry.batch, prevOutputs);
}

function renderResultCard(
  entryId: string,
  batch: BatchResult,
  prevOutputs: Record<string, string> | undefined,
): HTMLElement {
  const card = el('div', 'card result-card');

  batch.results.forEach((result, index) => {
    card.appendChild(renderStepRow(entryId, index, result, batch.error));
  });

  if (batch.error && batch.results.length === 0) {
    card.appendChild(el('div', 'batch-error', batch.error.message));
  }

  // Source-tagged sections, with the delta filter applied. Falls back to a
  // single un-labelled block when the server didn't send `outputSources`.
  const sections = buildOutputSections(batch.outputs, batch.outputSources, prevOutputs);
  for (const section of sections) {
    card.appendChild(renderOutputSection(`${entryId}:${section.kind}`, section));
  }
  return card;
}

/** Render one output section. The Parameters section is collapsed by default
 *  behind a `▸ Parameters (N)` summary that toggles open on click; the others
 *  render their rows inline. */
function renderOutputSection(
  key: string,
  section: ReturnType<typeof buildOutputSections>[number],
): HTMLElement {
  const outs = el('div', `batch-outputs batch-outputs-${section.kind}`);

  const rows = el('div', 'output-rows');
  for (const [k, v] of section.entries) {
    const row = el('div', 'output-row');
    // Values arrive already secret-masked from the server (name-based masking
    // is done server-side); rendering them verbatim preserves that behavior.
    row.appendChild(el('span', 'output-key', k));
    row.appendChild(el('span', 'output-value', v));
    rows.appendChild(row);
  }

  if (section.collapsed) {
    const expanded = state.expanded.has(key);
    const summary = el('div', 'outputs-summary');
    summary.appendChild(el('span', 'chevron', expanded ? '▾' : '▸'));
    summary.appendChild(
      el('span', 'outputs-label', `${section.label} (${section.entries.length})`),
    );
    summary.addEventListener('click', () => {
      if (state.expanded.has(key)) state.expanded.delete(key);
      else state.expanded.add(key);
      const scroll = chatEl.scrollTop;
      renderChat();
      chatEl.scrollTop = scroll;
    });
    outs.appendChild(summary);
    if (expanded) outs.appendChild(rows);
  } else {
    outs.appendChild(el('div', 'outputs-label', section.label));
    outs.appendChild(rows);
  }
  return outs;
}

function renderStepRow(
  entryId: string,
  index: number,
  result: StepResult,
  batchError: { step: number; message: string } | null,
): HTMLElement {
  const key = `${entryId}:${index}`;
  // Failed/error steps auto-expand ONCE on first render so the user
  // immediately sees what went wrong — but a subsequent user collapse must
  // stick (don't re-expand every renderChat). `skipped` is excluded by
  // `autoExpandsOnFirstRender`, not by `!== 'passed'`: see its doc comment.
  if (autoExpandsOnFirstRender(result.status) && !state.autoExpanded.has(key)) {
    state.expanded.add(key);
    state.autoExpanded.add(key);
  }
  const expanded = state.expanded.has(key);

  const row = el('div', 'step-row' + (expanded ? ' expanded' : ''));

  const header = el('div', 'step-header');
  header.appendChild(el('span', 'chevron', expanded ? '▾' : '▸'));
  header.appendChild(el('span', 'step-num', String(index + 1)));
  header.appendChild(el('span', 'step-text', result.step));
  // A skipped row's one fact, on the collapsed row: the row does not open
  // itself, so without this a ◌ would sit there explaining nothing.
  const reason = skipReason(result.status, result.reasoning);
  if (reason !== null) header.appendChild(el('span', 'step-skip-reason', reason));
  header.appendChild(statusBadge(result.status));
  header.addEventListener('click', () => {
    if (state.expanded.has(key)) state.expanded.delete(key);
    else state.expanded.add(key);
    // renderChat() rebuilds the whole list, which resets scrollTop; restore it
    // so toggling a row doesn't jump the user away from where they were.
    const scroll = chatEl.scrollTop;
    renderChat();
    chatEl.scrollTop = scroll;
  });
  row.appendChild(header);

  if (expanded) {
    const body = el('div', 'step-body');

    if (result.reasoning) {
      body.appendChild(field('Reasoning', result.reasoning));
    }

    if (result.actions.length > 0) {
      const actions = el('div', 'step-field');
      actions.appendChild(el('div', 'field-label', 'Actions'));
      for (const a of result.actions) {
        const { action: kind, ...rest } = a;
        const detail = Object.entries(rest)
          .map(([k, v]) => `${k}: ${formatValue(v)}`)
          .join('  ');
        actions.appendChild(
          el('div', 'action-row', detail ? `${kind} — ${detail}` : kind),
        );
      }
      body.appendChild(actions);
    }

    if (
      showsBatchError(result.status) &&
      batchError &&
      batchError.step === index &&
      batchError.message
    ) {
      body.appendChild(field('Error', batchError.message, 'field-error'));
    }

    const outputs = Object.entries(result.outputs);
    if (outputs.length > 0) {
      const outs = el('div', 'step-field');
      outs.appendChild(el('div', 'field-label', 'Outputs'));
      for (const [k, v] of outputs) {
        const orow = el('div', 'output-row');
        orow.appendChild(el('span', 'output-key', k));
        orow.appendChild(el('span', 'output-value', v));
        outs.appendChild(orow);
      }
      body.appendChild(outs);
    }

    if (result.screenshotUri) {
      const img = document.createElement('img');
      img.className = 'screenshot';
      img.src = result.screenshotUri;
      img.alt = `Screenshot for step ${index + 1}`;
      const uri = result.screenshotUri;
      img.addEventListener('click', () => openImageOverlay(uri));
      body.appendChild(img);
    }

    row.appendChild(body);
  }
  return row;
}

function field(label: string, value: string, extra = ''): HTMLElement {
  const wrap = el('div', `step-field ${extra}`.trim());
  wrap.appendChild(el('div', 'field-label', label));
  wrap.appendChild(el('div', 'field-value', value));
  return wrap;
}

function statusBadge(status: StepStatus): HTMLElement {
  // Matches TestBench: ✓ for pass, ✗ for fail, ⚠ for error, ◌ for a step a
  // return left unrun. Coloured via VS Code's --vscode-testing-icon* tokens
  // with our pass/fail/error CSS vars as fallback.
  const icon = statusGlyph(status);
  const label = statusLabel(status);
  const badge = el('span', `status-icon status-${status}`, icon);
  badge.setAttribute('title', label);
  badge.setAttribute('aria-label', label);
  return badge;
}

function scrollToBottom(): void {
  chatEl.scrollTop = chatEl.scrollHeight;
}

// --- settings panel ---------------------------------------------------------

function openSettings(): void {
  state.settingsOpen = true;
  renderSettings();
}
function closeSettings(): void {
  state.settingsOpen = false;
  settingsOverlay.hidden = true;
  settingsOverlay.innerHTML = '';
}

function renderSettings(): void {
  settingsOverlay.hidden = false;
  settingsOverlay.innerHTML = '';
  const panel = el('div', 'settings-panel');
  panel.appendChild(el('div', 'settings-title', 'Settings'));

  const fields: Array<{ key: keyof FlickSettings; label: string; placeholder: string }> = [
    { key: 'apiUrl', label: 'API URL', placeholder: 'http://127.0.0.1:3100' },
    { key: 'apiKey', label: 'API Key', placeholder: 'x-api-key value' },
    { key: 'defaultBaseUrl', label: 'Default Base URL', placeholder: '(optional)' },
    { key: 'defaultTimeout', label: 'Default Timeout', placeholder: 'e.g. 30s (optional)' },
  ];
  const inputs = new Map<keyof FlickSettings, HTMLInputElement>();
  for (const f of fields) {
    const wrap = el('label', 'settings-field');
    wrap.appendChild(el('span', 'settings-label', f.label));
    const input = document.createElement('input');
    input.type = f.key === 'apiKey' ? 'password' : 'text';
    input.value = state.settings[f.key];
    input.placeholder = f.placeholder;
    wrap.appendChild(input);
    inputs.set(f.key, input);
    panel.appendChild(wrap);
  }

  const buttons = el('div', 'settings-buttons');
  const cancel = el('button', 'btn', 'Cancel') as HTMLButtonElement;
  cancel.addEventListener('click', closeSettings);
  const save = el('button', 'btn btn-primary', 'Save') as HTMLButtonElement;
  save.addEventListener('click', () => {
    const next: FlickSettings = {
      apiUrl: inputs.get('apiUrl')!.value.trim(),
      apiKey: inputs.get('apiKey')!.value,
      defaultBaseUrl: inputs.get('defaultBaseUrl')!.value.trim(),
      defaultTimeout: inputs.get('defaultTimeout')!.value.trim(),
    };
    post({ type: 'saveSettings', settings: next });
    state.settings = next;
    closeSettings();
    showToast('info', 'Settings saved');
  });
  buttons.appendChild(cancel);
  buttons.appendChild(save);
  panel.appendChild(buttons);

  settingsOverlay.appendChild(panel);
  settingsOverlay.onclick = (e) => {
    if (e.target === settingsOverlay) closeSettings();
  };
}

// --- toasts -----------------------------------------------------------------

function showToast(level: 'info' | 'error', message: string): void {
  const toast = el('div', `toast toast-${level}`, message);
  toastsEl.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// --- helpers ----------------------------------------------------------------

function activeSession(): SessionMeta | undefined {
  return state.sessions.find((s) => s.id === state.activeSessionId);
}

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function el(tag: string, className = '', text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// --- boot -------------------------------------------------------------------

post({ type: 'ready' });
