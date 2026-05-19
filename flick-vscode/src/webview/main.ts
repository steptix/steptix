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
  ConnectionStatus,
  FlickSettings,
  HistoryEntry,
  HostToWebview,
  ServerSessionItem,
  SessionMeta,
  StepResult,
  WebviewToHost,
} from '../shared/protocol';

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
  draft: '',
  settingsOpen: false,
  // Adopt-server-session dropdown.
  adoptOpen: false,
  adoptLoading: false,
  adoptError: null as string | null,
  adoptList: null as ServerSessionItem[] | null,
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
  // Keep the previous list visible while the new one loads — refreshing
  // shouldn't blank the panel.
  adoptBtn.setAttribute('aria-expanded', 'true');
  adoptBtn.classList.add('active');
  adoptPanel.hidden = false;
  renderAdoptPanel();
  post({ type: 'listServerSessions' });
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

  const header = el('div', 'adopt-header');
  header.appendChild(el('span', 'adopt-title', 'Server sessions'));
  const refresh = el('button', 'adopt-refresh', '⟳') as HTMLButtonElement;
  refresh.type = 'button';
  refresh.title = 'Refresh';
  refresh.disabled = state.adoptLoading;
  refresh.addEventListener('click', (e) => {
    e.stopPropagation();
    state.adoptLoading = true;
    state.adoptError = null;
    renderAdoptPanel();
    post({ type: 'listServerSessions' });
  });
  header.appendChild(refresh);
  adoptPanel.appendChild(header);

  if (state.adoptLoading && !state.adoptList) {
    adoptPanel.appendChild(el('div', 'adopt-empty', 'Loading…'));
    return;
  }
  if (state.adoptError) {
    adoptPanel.appendChild(el('div', 'adopt-error', state.adoptError));
    return;
  }
  const list = state.adoptList ?? [];
  if (list.length === 0) {
    adoptPanel.appendChild(
      el('div', 'adopt-empty', 'No active sessions on the server.'),
    );
    return;
  }
  for (const item of list) {
    adoptPanel.appendChild(renderAdoptRow(item));
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
  for (const entry of history) {
    chatEl.appendChild(renderEntry(entry));
  }
}

function renderEntry(entry: HistoryEntry): HTMLElement {
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
  return renderResultCard(entry.id, entry.batch);
}

function renderResultCard(entryId: string, batch: BatchResult): HTMLElement {
  const card = el('div', 'card result-card');

  batch.results.forEach((result, index) => {
    card.appendChild(renderStepRow(entryId, index, result, batch.error));
  });

  if (batch.error && batch.results.length === 0) {
    card.appendChild(el('div', 'batch-error', batch.error.message));
  }

  const newOutputs = Object.entries(batch.outputs);
  if (newOutputs.length > 0) {
    const outs = el('div', 'batch-outputs');
    outs.appendChild(el('div', 'outputs-label', 'Outputs'));
    for (const [key, value] of newOutputs) {
      const row = el('div', 'output-row');
      row.appendChild(el('span', 'output-key', key));
      row.appendChild(el('span', 'output-value', value));
      outs.appendChild(row);
    }
    card.appendChild(outs);
  }
  return card;
}

function renderStepRow(
  entryId: string,
  index: number,
  result: StepResult,
  batchError: { step: number; message: string } | null,
): HTMLElement {
  const key = `${entryId}:${index}`;
  // Failed/error steps auto-expand so the user immediately sees what went wrong.
  if (result.status !== 'passed' && !state.expanded.has(key)) {
    state.expanded.add(key);
  }
  const expanded = state.expanded.has(key);

  const row = el('div', 'step-row' + (expanded ? ' expanded' : ''));

  const header = el('div', 'step-header');
  header.appendChild(el('span', 'chevron', expanded ? '▾' : '▸'));
  header.appendChild(el('span', 'step-num', String(index + 1)));
  header.appendChild(el('span', 'step-text', result.step));
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
      result.status !== 'passed' &&
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

function statusBadge(status: 'passed' | 'failed' | 'error'): HTMLElement {
  // Matches TestBench: ✓ for pass, ✗ for fail, ⚠ for error. Coloured via
  // VS Code's --vscode-testing-icon* tokens with our pass/fail/error
  // CSS vars as fallback.
  const icon = status === 'passed' ? '✓' : status === 'failed' ? '✗' : '⚠';
  const label = status.charAt(0).toUpperCase() + status.slice(1);
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
