// Browser-side half of Record Steps (stories/testbench-record-steps.md).
//
// Installed by src/recorder/step-recorder.ts in two ways at once, because a
// recording has to cover pages that already exist AND pages that do not yet:
//
//   - `context.addInitScript` — every document created from now on, in every
//     page and every frame of the session's browser context;
//   - `frame.evaluate` — every frame that is already open when Record is
//     pressed (an init script only ever runs for the NEXT document).
//
// Both can reach the same document (a frame that navigates while the evaluate
// is in flight), so the script is idempotent: the control object below is the
// "already installed" marker.
//
// It talks to the server through ONE binding (`context.exposeBinding`) whose
// name is substituted in. Everything it sends is a description of what the
// author did; nothing it sends is a secret field's value (decision 7).
//
// Placeholder substitution (src/recorder/page-script.ts):
//   __BINDING_NAME__      → JSON string literal, the exposed binding's name
//   __CONTROL_NAME__      → JSON string literal, the window property the server
//                           drives this script through (state push, flush)
//   __CONTROL_KEY__       → JSON string literal, the context's control key:
//                           every method of the control object wants it, and
//                           only the server has it (see "The token")
//   SECRET_FIELD_RULE (double-underscored) → ./secret-field.js, the one copy
//                           of `isSecretField` the snapshot also uses
//   RECORD_TOOLBAR (double-underscored) → ./record-toolbar.js, the recording
//                           controls in the page (stories/testbench-record-toolbar.md),
//                           spliced into this closure so they share its state
//
// ── The token ───────────────────────────────────────────────────────────────
// The binding is a function on `window`, so the page's own scripts can call it.
// Every toolbar message (a step, Stop, Pause…) therefore carries a token the
// server gave THIS document — not in the hello answer, which a page script
// could ask for itself, but by calling `claim` on the frozen control object
// below, which accepts one token per document and never hands it out. The
// script also keeps its own reference to the binding function from the
// moment it installs, before any page code runs.
//
// The control object is on `window` too, so each of its methods also wants
// the control key: a value written into this closure when the server built
// the script, and passed by the server as an evaluate argument. A page script
// that calls `claim('x')` first — before the server's claim lands — gets
// false, and the document's token stays the recorder's to give.
//
// ── Inert after Stop ────────────────────────────────────────────────────────
// Playwright cannot remove an init script or a binding, so after a recording
// ends this script stays installed in the context for the life of the session
// — including in the runs that follow. It is inert there: `state.recording` is
// false, every listener returns at its first line, and a new document asks the
// binding once ("hello") and is told no. Nothing is sent while not recording.

(() => {
  var CONTROL = __CONTROL_NAME__;
  var BINDING = __BINDING_NAME__;
  // A name, not a literal inside the methods below: a method's source text
  // (`Function.prototype.toString`) is readable by the page.
  var CONTROL_KEY = __CONTROL_KEY__;
  if (Object.prototype.hasOwnProperty.call(window, CONTROL)) return;

  // eslint-disable-next-line
  __SECRET_FIELD_RULE__

  // recording — a recording is running; pick — Add check is armed; paused —
  // the author paused it (nothing is recorded); bar — it has the toolbar (and
  // its shortcuts, check-ins and "Typing hidden" reports).
  var state = { recording: false, pick: false, paused: false, bar: false };
  // The binding as it was when this script installed — before any page code
  // could replace `window[BINDING]` to listen in.
  var bindingFn = typeof window[BINDING] === 'function' ? window[BINDING] : null;
  // This document's token (see "The token" above); null until claimed.
  var token = null;
  // How many states the server has sent this document (`applyState`).
  var serverSeq = 0;
  // A mark names the crop the server takes at the moment of a pointer-down or
  // the first keystroke into a field; the action that follows carries it. The
  // document id keeps two documents' counters apart.
  var docId = Math.random().toString(36).slice(2, 10);
  var markSeq = 0;
  // Fields being typed into and not yet reported: element → session.
  var typing = new Map();
  // A field's value when it took focus (or when its last typing was reported):
  // what "did anything change?" is measured against. Read at focus rather than
  // at the first `input` event, because a paste, an autofill or Playwright's
  // `fill` raises `input` with no keystroke before it — by then the value
  // has already changed.
  var baseline = new WeakMap();
  // What the last pointer-down landed on, so the click that follows is
  // described as it looked BEFORE the click changed the page.
  var pointer = null;
  // True between a picked pointer-down and the click that completes it: the
  // rest of that gesture is swallowed too, so the page never sees it.
  var swallowing = false;
  // Enter in a form field makes the browser click the form's submit button
  // (implicit submission). That click is the Enter, already reported as a key.
  var enter = { at: 0, form: null };
  // A click on a <label> makes the browser click its control as well — in the
  // same task, before any timer runs. That second click is the label's, which
  // was reported; this says which control it goes to, and only until then.
  var labelForward = null;

  function send(message) {
    var fn = bindingFn;
    if (typeof fn !== 'function') return Promise.resolve(null);
    try {
      return Promise.resolve(fn(message)).catch(function () { return null; });
    } catch (err) {
      return Promise.resolve(null);
    }
  }

  /** A toolbar message: carries this document's token, and is not sent
   *  without one (the server would refuse it anyway). */
  function sendCmd(message) {
    if (token === null) return Promise.resolve(null);
    message.token = token;
    return send(message);
  }

  /** Whatever a gesture left half-done — the server has already collected
   *  the typing through `flush` before it says stop, or pause. */
  function dropHalfDone() {
    typing.clear();
    pointer = null;
    swallowing = false;
    press = null;
    html5Drag = null;
    labelForward = null;
    if (pendingEnter) {
      clearTimeout(pendingEnter.timer);
      pendingEnter = null;
    }
  }

  /** What the server says the state is — its push, the hello answer, and the
   *  state a refused command comes back with. Bumps `serverSeq`, which is how
   *  a command the page applied ahead of the server knows whether to take its
   *  own change back (record-toolbar.js, `sendOptimistic`). */
  function applyState(next) {
    if (!next || typeof next !== 'object') return;
    serverSeq++;
    var wasRecording = state.recording;
    var wasPaused = state.paused;
    var wasBar = state.bar;
    state.recording = next.recording === true;
    state.paused = state.recording && next.paused === true;
    state.pick = state.recording && !state.paused && next.pick === true;
    state.bar = state.recording && next.bar === true;
    if (!state.recording) {
      // Stopping drops whatever was half-typed: the server has already asked
      // for it through `flush` before it says stop.
      dropHalfDone();
    } else if (!wasRecording) {
      typing.clear();
    } else if (state.paused && !wasPaused) {
      // Paused: nothing from here on is recorded.
      dropHalfDone();
    }
    if (state.recording && !state.paused && wasPaused) {
      // Resumed: what the focused field holds now is where its typing starts —
      // anything typed into it while paused is not the author's step.
      var focused = focusedElement();
      if (focused && isTextEntry(focused)) baseline.set(focused, currentValue(focused));
    }
    pickApply();
    if (IS_TOP) toolbarApply(next.toolbar);
    checkInSchedule();
    // Focus that was already in a field when the recording reached this
    // document (an autofocused password box, or one the author was in when
    // Record was pressed) never fired a focus event the recording heard.
    if (state.recording && state.bar && (!wasRecording || !wasBar)) setTimeout(focusReportAfterConnect, 0);
  }

  // ── Text ───────────────────────────────────────────────────────────────

  // The page does NOT clip to what the model is shown: the server masks every
  // known secret first and clips after. Clipped here, a secret that crossed
  // the cut arrived as a prefix no mask could match. So the page's cut is
  // only a bound on the message, well above any limit the server applies.
  var PAGE_CLIP_FLOOR = 1000;
  // The same for a field's value: the server keeps 2000 characters of a typed
  // value, cut AFTER masking, so the page sends more than that.
  var PAGE_VALUE_MAX = 4000;

  function isSpace(code) {
    return code === 32 || (code >= 9 && code <= 13) || code === 160 || code === 0xfeff ||
      code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 ||
      code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000;
  }

  // Text for the server, as the page has it: NOT whitespace-folded. The
  // server masks the secrets it knows and folds after (review 2, finding 9):
  // folded here, a secret holding a double space or a line break arrived as
  // a spelling no mask could match. Only the ends are trimmed. The cut is
  // made where the FOLDED text would reach the limit — so the bound means
  // what it did, and stays above every cut the server makes after folding —
  // and the secrets typed on this page are masked out first, as the server
  // would mask its own (see "Secrets typed on this page").
  function clip(value, max) {
    var s = maskTyped(String(value == null ? '' : value)).trim();
    var limit = Math.max(max, PAGE_CLIP_FLOOR);
    var folded = 0;
    var inSpace = false;
    for (var i = 0; i < s.length; i++) {
      if (isSpace(s.charCodeAt(i))) {
        if (!inSpace) folded++;
        inSpace = true;
      } else {
        folded++;
        inSpace = false;
      }
      if (folded > limit) return s.slice(0, i) + '…';
    }
    return s;
  }

  function visibleText(el, max) {
    if (!el) return '';
    var t = typeof el.innerText === 'string' ? el.innerText : el.textContent;
    return clip(t, max);
  }

  // A label's text without the control inside it: a wrapping label around a
  // <select> would otherwise read as its own caption plus every option.
  function textExcluding(node, skip, depth) {
    if (!node || node === skip || depth > 12) return '';
    if (node.nodeType === 3) return node.data;
    if (node.nodeType !== 1) return '';
    var tag = node.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'select' || tag === 'textarea') return '';
    if (tag === 'input') return '';
    var out = '';
    for (var c = node.firstChild; c; c = c.nextSibling) out += ' ' + textExcluding(c, skip, depth + 1);
    return out;
  }

  // ── Roles ──────────────────────────────────────────────────────────────

  var NON_TEXT_INPUTS = {
    checkbox: 1, radio: 1, file: 1, submit: 1, reset: 1, button: 1,
    image: 1, hidden: 1, range: 1, color: 1,
  };

  function inputType(el) {
    return String(el.getAttribute('type') || 'text').toLowerCase();
  }

  function isTextEntry(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') return !NON_TEXT_INPUTS[inputType(el)];
    return el.isContentEditable === true;
  }

  function implicitRole(el) {
    var tag = el.tagName.toLowerCase();
    switch (tag) {
      case 'a': case 'area': return el.hasAttribute('href') ? 'link' : '';
      case 'button': case 'summary': return 'button';
      case 'input': {
        var t = inputType(el);
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
        if (t === 'range') return 'slider';
        if (t === 'number') return 'spinbutton';
        if (t === 'file' || t === 'hidden' || t === 'color') return '';
        if (el.hasAttribute('list')) return 'combobox';
        return t === 'search' ? 'searchbox' : 'textbox';
      }
      case 'textarea': return 'textbox';
      case 'select': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'option': return 'option';
      case 'img': return el.getAttribute('alt') === '' ? '' : 'img';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'header': return 'banner';
      case 'footer': return 'contentinfo';
      case 'aside': return 'complementary';
      case 'form': return 'form';
      case 'dialog': return 'dialog';
      case 'table': return 'table';
      case 'tr': return 'row';
      case 'td': return 'cell';
      case 'th': return 'columnheader';
      case 'ul': case 'ol': return 'list';
      case 'li': return 'listitem';
      case 'section': return 'region';
      case 'fieldset': case 'details': return 'group';
      case 'progress': return 'progressbar';
    }
    if (el.isContentEditable) return 'textbox';
    return '';
  }

  function roleOf(el) {
    var explicit = String(el.getAttribute('role') || '').trim().split(/\s+/)[0];
    return explicit || implicitRole(el);
  }

  // ── Accessible name ────────────────────────────────────────────────────
  //
  // Not the full accname algorithm — the common cases decision 5 names, in its
  // order: aria-labelledby, aria-label, label[for] / a wrapping <label>, alt,
  // button and link text, title, placeholder. What it misses, the crop
  // covers: that is why a screenshot goes with each action (decision 6).

  var NAME_FROM_CONTENT = {
    button: 1, link: 1, checkbox: 1, radio: 1, switch: 1, tab: 1, menuitem: 1,
    menuitemcheckbox: 1, menuitemradio: 1, option: 1, heading: 1, cell: 1,
    columnheader: 1, rowheader: 1, gridcell: 1, treeitem: 1, tooltip: 1,
  };

  function textOfIds(ids) {
    var parts = String(ids).split(/\s+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      var ref = document.getElementById(parts[i]);
      if (ref) out.push(visibleText(ref, 150) || clip(ref.textContent, 150));
    }
    return clip(out.join(' '), 150);
  }

  function labelsOf(el) {
    var out = [];
    try {
      if (el.labels) {
        for (var i = 0; i < el.labels.length; i++) out.push(textExcluding(el.labels[i], el, 0));
      }
    } catch (err) { /* not a labelable element */ }
    return clip(out.join(' '), 150);
  }

  // An icon-only control is named by what is inside it: an <img alt>, an
  // <svg><title>, or a child that carries its own aria-label.
  function innerGraphicName(el) {
    var img = el.querySelector('img[alt]:not([alt=""])');
    if (img) return clip(img.getAttribute('alt'), 150);
    var title = el.querySelector('svg title');
    if (title) return clip(title.textContent, 150);
    var labelled = el.querySelector('[aria-label]');
    if (labelled) return clip(labelled.getAttribute('aria-label'), 150);
    return '';
  }

  function accessibleName(el) {
    var tag = el.tagName.toLowerCase();
    var by = el.getAttribute('aria-labelledby');
    if (by) {
      var fromIds = textOfIds(by);
      if (fromIds) return fromIds;
    }
    var aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return clip(aria, 150);
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'meter' ||
        tag === 'progress' || tag === 'output') {
      var t = tag === 'input' ? inputType(el) : '';
      if (t === 'image') {
        var alt = el.getAttribute('alt');
        if (alt) return clip(alt, 150);
      }
      if (t === 'button' || t === 'submit' || t === 'reset') {
        var v = el.getAttribute('value');
        if (v) return clip(v, 150);
        if (t === 'submit') return 'Submit';
        if (t === 'reset') return 'Reset';
      }
      var labels = labelsOf(el);
      if (labels) return labels;
    }
    if (tag === 'img' || tag === 'area') {
      var imgAlt = el.getAttribute('alt');
      if (imgAlt) return clip(imgAlt, 150);
    }
    if (tag === 'fieldset') {
      var legend = el.querySelector('legend');
      if (legend) return visibleText(legend, 150);
    }
    if (tag === 'table') {
      var caption = el.querySelector('caption');
      if (caption) return visibleText(caption, 150);
    }
    var role = roleOf(el);
    if (NAME_FROM_CONTENT[role] || tag === 'label') {
      var text = visibleText(el, 150);
      if (text) return text;
      var graphic = innerGraphicName(el);
      if (graphic) return graphic;
    }
    var title = el.getAttribute('title');
    if (title && title.trim()) return clip(title, 150);
    if (isTextEntry(el)) {
      var placeholder = el.getAttribute('placeholder');
      if (placeholder) return clip(placeholder, 150);
    }
    return '';
  }

  // ── Where it sits ──────────────────────────────────────────────────────

  var HEADINGS = 'h1,h2,h3,h4,h5,h6,[role="heading"]';

  function nameOrHeading(container) {
    var name = accessibleName(container);
    if (name) return name;
    var heading = container.querySelector(HEADINGS);
    return heading ? visibleText(heading, 100) : '';
  }

  // The nearest heading ABOVE the element: walk out through its ancestors and
  // take the last heading that comes before it in document order. The first
  // ancestor that holds one decides, so a card's own title beats the page's.
  function nearestHeading(el) {
    var cur = el.parentElement;
    for (var depth = 0; cur && depth < 10; depth++, cur = cur.parentElement) {
      var found = null;
      var list = cur.querySelectorAll(HEADINGS);
      for (var i = 0; i < list.length && i < 200; i++) {
        var h = list[i];
        if (h === el || h.contains(el)) continue;
        // eslint-disable-next-line no-bitwise
        if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) found = h;
      }
      if (found) return visibleText(found, 100);
      if (cur === document.body) break;
    }
    return '';
  }

  var CELL = 'td,th,[role="cell"],[role="gridcell"],[role="rowheader"],[role="columnheader"]';

  function rowCells(row) {
    var out = [];
    for (var c = row.firstElementChild; c; c = c.nextElementSibling) {
      if (c.matches(CELL)) out.push(c);
    }
    return out;
  }

  function rowContext(el) {
    var row = el.closest('tr,[role="row"]');
    if (!row) return null;
    var cells = rowCells(row);
    var own = el.closest(CELL);
    var header = '';
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (c.tagName.toLowerCase() === 'th' || c.getAttribute('role') === 'rowheader') {
        if (c !== own) { header = visibleText(c, 60); break; }
      }
    }
    if (!header) {
      for (var j = 0; j < cells.length; j++) {
        if (cells[j] === own || cells[j].contains(el)) continue;
        var text = visibleText(cells[j], 60);
        if (text) { header = text; break; }
      }
    }
    var column = '';
    var index = own ? cells.indexOf(own) : -1;
    var table = row.closest('table,[role="table"],[role="grid"],[role="treegrid"]');
    if (table && index >= 0) {
      var headRow = table.querySelector('thead tr') || table.querySelector('[role="row"]');
      if (headRow && headRow !== row) {
        var heads = rowCells(headRow);
        if (heads[index]) column = visibleText(heads[index], 60);
      }
    }
    return { row: header, column: column };
  }

  var LANDMARKS =
    'nav,header,footer,aside,main,form[aria-label],form[aria-labelledby],' +
    'section[aria-label],section[aria-labelledby],[role="navigation"],[role="banner"],' +
    '[role="contentinfo"],[role="complementary"],[role="search"],[role="region"],[role="main"]';

  function contextOf(el) {
    var ctx = {};
    var dialog = el.closest('dialog,[role="dialog"],[role="alertdialog"]');
    if (dialog) ctx.dialog = nameOrHeading(dialog) || '(unnamed dialog)';
    var menu = el.parentElement &&
      el.parentElement.closest('[role="menu"],[role="menubar"],[role="tablist"],[role="listbox"],[role="tree"]');
    if (menu) {
      var menuName = accessibleName(menu);
      ctx.menu = roleOf(menu) + (menuName ? ' "' + menuName + '"' : '');
    }
    var fieldset = el.closest('fieldset');
    if (fieldset) {
      var legend = fieldset.querySelector('legend');
      if (legend) ctx.fieldset = visibleText(legend, 80);
    }
    var landmark = el.parentElement && el.parentElement.closest(LANDMARKS);
    if (landmark) {
      var lmName = accessibleName(landmark);
      ctx.landmark = roleOf(landmark) + (lmName ? ' "' + lmName + '"' : '');
    }
    var row = rowContext(el);
    if (row && (row.row || row.column)) {
      if (row.row) ctx.row = row.row;
      if (row.column) ctx.column = row.column;
    }
    var heading = nearestHeading(el);
    if (heading) ctx.heading = heading;
    return ctx;
  }

  // ── A selector the document confirms ───────────────────────────────────
  //
  // The same candidate order and the same verification as `strongSelector` /
  // `stableSelector` in find-in-dom.js — copied rather than shared, as that
  // file's own comment says of capture-dom.js: each script is injected on its
  // own. It is a hint for the model, never something the recorder clicks.

  function escAttr(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function idSelector(id) {
    if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) return '#' + id;
    return '[id="' + escAttr(id) + '"]';
  }

  function verifies(sel, el) {
    try {
      var found = document.querySelectorAll(sel);
      return found.length === 1 && found[0] === el;
    } catch (err) {
      return false;
    }
  }

  function strongSelector(el) {
    var tag = el.tagName.toLowerCase();
    var testId = el.getAttribute('data-testid');
    if (testId) {
      var testIdSel = '[data-testid="' + escAttr(testId) + '"]';
      if (verifies(testIdSel, el)) return testIdSel;
    }
    var id = el.getAttribute('id');
    if (id) {
      var idSel = idSelector(id);
      if (verifies(idSel, el)) return idSel;
    }
    var name = el.getAttribute('name');
    if (name) {
      var nameSel = tag + '[name="' + escAttr(name) + '"]';
      if (verifies(nameSel, el)) return nameSel;
    }
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      var ariaSel = tag + '[aria-label="' + escAttr(ariaLabel) + '"]';
      if (verifies(ariaSel, el)) return ariaSel;
    }
    if (tag === 'a') {
      var href = el.getAttribute('href');
      if (href) {
        var hrefSel = 'a[href="' + escAttr(href) + '"]';
        if (verifies(hrefSel, el)) return hrefSel;
      }
    }
    return null;
  }

  function stableSelector(el) {
    var direct = strongSelector(el);
    if (direct) return direct;
    var parts = [];
    var cur = el;
    while (cur && cur !== document.body && cur.parentElement) {
      var parent = cur.parentElement;
      var tag = cur.tagName.toLowerCase();
      var n = 1;
      var sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName.toLowerCase() === tag) n++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(tag + ':nth-of-type(' + n + ')');
      var parentSel = strongSelector(parent);
      if (parentSel) {
        parts.unshift(parentSel);
        return parts.join(' > ');
      }
      cur = parent;
    }
    parts.unshift('body');
    return parts.join(' > ');
  }

  // ── The description ────────────────────────────────────────────────────
  //
  // Never carries a field's VALUE. Text for an input or a textarea is left out
  // entirely — a textarea's text is its default value, and a contenteditable's
  // text is what was typed — so a secret can only reach the server through the
  // one path that asks `isSecretField` first (`typedValue`).

  function describe(el) {
    var tag = el.tagName.toLowerCase();
    var d = { tag: tag };
    var role = roleOf(el);
    if (role) d.role = role;
    var name = accessibleName(el);
    if (name) d.name = name;
    if (!isTextEntry(el) && tag !== 'select') {
      var text = visibleText(el, 120);
      if (text && text !== name) d.text = text;
    }
    if (tag === 'input') d.inputType = inputType(el);
    var placeholder = el.getAttribute('placeholder');
    if (placeholder) d.placeholder = clip(placeholder, 80);
    if (tag === 'a' && el.getAttribute('href')) d.href = clip(el.getAttribute('href'), 200);
    var idAttr = el.getAttribute('id');
    if (idAttr) d.id = clip(idAttr, 80);
    var nameAttr = el.getAttribute('name');
    if (nameAttr) d.nameAttr = clip(nameAttr, 80);
    var testId = el.getAttribute('data-testid');
    if (testId) d.testId = clip(testId, 80);
    var titleAttr = el.getAttribute('title');
    if (titleAttr && titleAttr !== name) d.title = clip(titleAttr, 80);
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') d.disabled = true;
    if (!name && !d.text) {
      // Icon-only: a class name is often the only word left ("icon-trash").
      var cls = typeof el.className === 'string' ? el.className : '';
      if (cls) d.classes = clip(cls, 80);
    }
    d.context = contextOf(el);
    d.selector = stableSelector(el);
    if (window !== window.top) d.inFrame = true;
    return d;
  }

  function boxOf(el) {
    try {
      var r = el.getBoundingClientRect();
      return {
        x: Math.round(r.left), y: Math.round(r.top),
        width: Math.round(r.width), height: Math.round(r.height),
      };
    } catch (err) {
      return null;
    }
  }

  // Ask the server to photograph the page NOW — before the click lands or the
  // keystroke changes the field — and name the picture so the action that
  // follows can claim it.
  function markNow(el) {
    // The pick outline and label sit on the very element a crop is about:
    // they come down before the picture is asked for, and are never in it.
    pickHide();
    var box = boxOf(el);
    if (!box || box.width === 0 && box.height === 0) return undefined;
    var mark = docId + ':' + (++markSeq);
    void send({
      type: 'mark', mark: mark, box: box,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    return mark;
  }

  // ── Targets ────────────────────────────────────────────────────────────

  var ACTIONABLE =
    'a[href],button,input,select,textarea,label,summary,option,' +
    '[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],' +
    '[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],' +
    '[role="option"],[role="treeitem"],[contenteditable=""],[contenteditable="true"],' +
    '[onclick],[tabindex]:not([tabindex="-1"])';

  function realTarget(event) {
    var path = typeof event.composedPath === 'function' ? event.composedPath() : null;
    var t = path && path.length ? path[0] : event.target;
    if (t && t.nodeType === 3) t = t.parentElement;
    return t && t.nodeType === 1 ? t : null;
  }

  function actionable(t) {
    if (!t) return null;
    var a = t.closest(ACTIONABLE);
    if (!a || a === document.body || a === document.documentElement) return t;
    return a;
  }

  function labelControl(el) {
    if (!el || el.tagName.toLowerCase() !== 'label') return null;
    try { return el.control || null; } catch (err) { return null; }
  }

  function isToggle(el) {
    if (!el || el.tagName.toLowerCase() !== 'input') return false;
    var t = inputType(el);
    return t === 'checkbox' || t === 'radio';
  }

  // ── Secrets, remembered for the life of the document ───────────────────
  //
  // `isSecretField` answers about the field as it is NOW, and a "show
  // password" eye makes a password box `type="text"` — after which the rule no
  // longer calls it secret and its value would be reported, and photographed,
  // in clear (review, finding 1). So a field seen as secret ONCE is secret for
  // as long as this document lives: remembered in a WeakSet, and caught at its
  // toggle by watching `type` attributes with their old value, because a
  // field toggled before the author ever touched it was never asked.
  //
  // The recorder is also stricter than the snapshot's rule in three ways, none
  // of which the snapshot applies (it has no memory, and no label rule):
  //
  //   - a text field whose LABEL names a password, a PIN or a one-time code
  //     is secret — the only name a minimal sign-in form gives its password
  //     box once the eye has flipped it;
  //   - a field styled `-webkit-text-security: disc | circle | square` is
  //     secret — it shows dots, as a password box does, and that is how some
  //     sites build their password box out of `type="text"`;
  //   - a field whose value HOLDS a secret typed on this page is secret (next
  //     section) — the one rule that follows a value rather than an element.
  var everSecret = new WeakSet();

  // The label rule. Whole WORDS, not the field rule's substrings: a label is
  // prose a person reads, and "Boarding pass number" is not a password box
  // (review 2, finding 7). And a label that also names another kind of field
  // — "Email for password reset", "Password hint", "Security question" — is
  // that other field. The attribute rule (`isSecretField`, shared with the
  // snapshot) is not changed by any of this.
  var LABEL_SECRET_RE = new RegExp(
    '(^|[^a-z0-9])(' +
      'passwords?|passwd|pwd|passcodes?|passphrases?|secrets?|tokens?|otp|' +
      'one[\\s-]?time[\\s-]?(pass)?(codes?|words?|pins?)|' +
      '(verification|security|authentication|access|auth)[\\s-]?codes?' +
    ')(?=$|[^a-z0-9])',
    'i'
  );
  var LABEL_OTHER_FIELD_RE =
    /(^|[^a-z0-9])(e-?mail|username|user[\s-]name|phone|mobile|hint|question|reminder)(?=$|[^a-z0-9])/i;

  function labelSaysSecret(el) {
    var tag = el.tagName.toLowerCase();
    if ((tag !== 'input' && tag !== 'textarea') || !isTextEntry(el)) return false;
    var label = labelsOf(el);
    if (label === '') return false;
    if (!LABEL_SECRET_RE.test(label) && !hasPinToken(label)) return false;
    return !LABEL_OTHER_FIELD_RE.test(label);
  }

  function hidesItsText(el) {
    try {
      var style = window.getComputedStyle(el);
      var v = String(style.getPropertyValue('-webkit-text-security') || style.webkitTextSecurity || '');
      return v === 'disc' || v === 'circle' || v === 'square';
    } catch (err) {
      return false;
    }
  }

  // A secret field that shows dots, not its value: photographed like any
  // other field (every crop paints it out anyway). One that shows its value in
  // clear gets no picture of its own.
  function showsDots(el) {
    return (el.tagName.toLowerCase() === 'input' && inputType(el) === 'password') || hidesItsText(el);
  }

  function isSecretNow(el) {
    if (!el || el.nodeType !== 1) return false;
    if (!everSecret.has(el)) {
      var entry = isTextEntry(el);
      if (!(isSecretField(el) || labelSaysSecret(el) ||
            (entry && (hidesItsText(el) || holdsTypedSecret(currentValue(el)))))) {
        return false;
      }
      everSecret.add(el);
    }
    rememberSecretValue(el);
    return true;
  }

  // ── Secrets typed on this page ─────────────────────────────────────────
  //
  // The WeakSet follows an ELEMENT. A "show password" toggle that REPLACES
  // the input — Vue's v-if/v-else, Angular's *ngIf, a React key change —
  // puts a brand-new `<input type="text">` holding the same value where the
  // old one was, and nothing about the new element says secret: its value was
  // typed into an action, sent to the model, written under `## Parameters`
  // and photographed (review 2, finding 1). So the script also remembers the
  // VALUES — what each secret field holds whenever it is asked about, at every
  // keystroke into one, and what each finished typing into one left behind —
  // and:
  //
  //   - a field whose value IS one, or contains one of TYPED_SECRET_MIN
  //     characters or more, is secret (typing, an Add check, the crops);
  //   - every element whose text shows one — a toggle that reveals the value
  //     into a <span> — is painted out of the crops (`fieldRects`);
  //   - every text this script sends has them masked out (`clip`), as the
  //     server masks the secrets it knows.
  //
  // They stay in this closure. Nothing here sends them: not the binding, not
  // `fieldRects` (a text that shows one is reported as a box to paint, never
  // as text), not a description. The server's known secrets never come in —
  // the page reports text and field values with their boxes, and the server
  // compares (`secretBoxes`, src/recorder/step-recorder.ts).
  //
  // TYPED_SECRET_MIN is RECORD_SECRET_MIN_LENGTH (src/utils/secrets.ts): a
  // value shorter than that inside other text is more often a coincidence
  // than the secret, and would have every field and label holding it painted.
  var TYPED_SECRET_MIN = 4;
  // One live entry per secret field (its value as last seen) — objects, so no
  // element is held once the page drops it — and every finished value.
  var typedSecretEntries = [];
  var typedSecretOf = new WeakMap();
  var typedSecretFinals = [];
  // Fields that have been `type="password"` in this document.
  var wasPasswordBox = new WeakSet();

  // Is what this field holds worth remembering as a secret? The shared rule
  // over-matches on purpose — its bare `key` calls a `keywords` search box
  // and `aria-label="Search by keyword"` secret — and there that costs one
  // withheld value. Remembered, the search term would be masked out of every
  // description and painted out of every crop (the results page is full of
  // it). So a field secret ONLY by that word gives up its value only when the
  // value looks like a credential: eight characters or more, no spaces. Every
  // other reason — a password box now or once, dots, the label, a password-,
  // secret-, token-, credential- or PIN-like name — keeps it whatever it is.
  function strongSecretField(el) {
    if (wasPasswordBox.has(el) || inputType(el) === 'password' || showsDots(el) || labelSaysSecret(el)) return true;
    var autocomplete = String(el.getAttribute('autocomplete') || '').toLowerCase();
    if (autocomplete.indexOf('current-password') !== -1 || autocomplete.indexOf('new-password') !== -1) return true;
    var attrs = SECRET_NAME_ATTRS.concat(PASSWORD_ONLY_ATTRS);
    for (var i = 0; i < attrs.length; i++) {
      var named = el.getAttribute(attrs[i]);
      if (named && (PASSWORD_FIELD_RE.test(named) || hasPinToken(named))) return true;
    }
    return false;
  }

  function worthRemembering(el, value) {
    if (value === '') return false;
    if (strongSecretField(el) || holdsTypedSecret(value)) return true;
    return value.length >= 8 && !/\s/.test(value);
  }

  function rememberSecretValue(el, value) {
    if (!el || el.nodeType !== 1) return;
    if (value === undefined && !isTextEntry(el)) return;
    var v = value !== undefined ? String(value) : currentValue(el);
    var keep = worthRemembering(el, v);
    var entry = typedSecretOf.get(el);
    if (!entry) {
      if (!keep) return;
      entry = { value: v };
      typedSecretOf.set(el, entry);
      if (typedSecretEntries.length < 500) typedSecretEntries.push(entry);
      return;
    }
    entry.value = keep ? v : '';
  }

  function rememberFinalSecret(el, value) {
    if (!worthRemembering(el, value)) return;
    if (typedSecretFinals.indexOf(value) === -1 && typedSecretFinals.length < 200) {
      typedSecretFinals.push(value);
    }
  }

  function typedSecretValues(min) {
    var out = [];
    for (var i = 0; i < typedSecretEntries.length; i++) {
      var v = typedSecretEntries[i].value;
      if (v && v.length >= min && out.indexOf(v) === -1) out.push(v);
    }
    for (var j = 0; j < typedSecretFinals.length; j++) {
      var f = typedSecretFinals[j];
      if (f.length >= min && out.indexOf(f) === -1) out.push(f);
    }
    return out;
  }

  function holdsTypedSecret(value) {
    if (!value) return false;
    var all = typedSecretValues(1);
    for (var i = 0; i < all.length; i++) {
      if (value === all[i]) return true;
      if (all[i].length >= TYPED_SECRET_MIN && value.indexOf(all[i]) !== -1) return true;
    }
    return false;
  }

  function maskTyped(text) {
    if (text === '') return text;
    var all = typedSecretValues(TYPED_SECRET_MIN);
    if (all.length === 0) return text;
    all.sort(function (a, b) { return b.length - a.length; });
    var out = text;
    for (var i = 0; i < all.length; i++) out = out.split(all[i]).join('***');
    return out;
  }

  function rememberSecretsIn(root) {
    try {
      var list = root.querySelectorAll('input');
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].getAttribute('type') || '').toLowerCase() === 'password') {
          everSecret.add(list[i]);
          wasPasswordBox.add(list[i]);
          rememberSecretValue(list[i]);
        }
      }
    } catch (err) { /* nothing to scan yet */ }
  }

  var typeWatch = typeof MutationObserver === 'function'
    ? new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.attributeName === 'type' && String(r.oldValue || '').toLowerCase() === 'password') {
          everSecret.add(r.target);
          wasPasswordBox.add(r.target);
          rememberSecretValue(r.target);
        }
      }
    })
    : null;

  function watchTypes(root) {
    rememberSecretsIn(root);
    if (!typeWatch) return;
    try {
      typeWatch.observe(root, { subtree: true, attributes: true, attributeFilter: ['type'], attributeOldValue: true });
    } catch (err) { /* a root that cannot be observed */ }
  }

  // Open shadow roots: `change` and `submit` do not cross a shadow boundary,
  // so a window listener never hears them from inside one, and the `type`
  // watch above does not see into one. Each open root the author touches gets
  // both. A CLOSED root cannot be observed from outside at all — events leave
  // it retargeted to its host — so what happens inside one is not recorded
  // (spec §4, "Not captured").
  var watchedRoots = new WeakSet();
  // The same roots, in order, for `fieldRects` — a WeakSet cannot be walked.
  var watchedRootList = [];

  function watchShadowRootOf(el) {
    var root = el && typeof el.getRootNode === 'function' ? el.getRootNode() : null;
    if (!root || root === document || watchedRoots.has(root)) return;
    if (typeof ShadowRoot === 'undefined' || !(root instanceof ShadowRoot)) return;
    watchedRoots.add(root);
    if (watchedRootList.length < 200) watchedRootList.push(root);
    root.addEventListener('change', onChange, true);
    root.addEventListener('submit', onSubmit, true);
    watchTypes(root);
  }

  // ── What a crop must not show ──────────────────────────────────────────
  //
  // For the crop being taken (`fieldRects`), everything that has to be
  // painted out or checked, in this frame's viewport coordinates:
  //
  //   secret    — boxes to paint: every secret field (remembered, by label, by
  //               style, or holding a typed secret), and every element whose
  //               text shows a secret typed on this page;
  //   fields    — every other field with a value, WITH the value, so the
  //               server can paint out one that holds a secret it knows;
  //   texts     — when the server asks (it has known secrets to look for):
  //               every run of text on screen, with its box, for the same
  //               comparison. A text that shows a typed secret is in `secret`
  //               instead, and never here;
  //   truncated — the page is too big to report whole. The server then does
  //               not keep the crop: a picture whose secrets could not all be
  //               located is not sent.
  //
  // A secret field's value is not included, ever. The document, and every
  // open shadow root the author has touched.
  var FIELDS = 'input, textarea, [contenteditable=""], [contenteditable="true"]';
  var MAX_FIELDS = 2000;
  var MAX_TEXT_RUNS = 5000;
  var MAX_TEXT_CHARS = 400000;
  var NOT_SHOWN = { script: 1, style: 1, noscript: 1, template: 1, textarea: 1, title: 1 };

  function onScreen(box) {
    return !!box && (box.width > 0 || box.height > 0) &&
      box.x + box.width >= 0 && box.y + box.height >= 0 &&
      box.x <= window.innerWidth && box.y <= window.innerHeight;
  }

  // The deepest elements whose text holds `value`: an element is one when
  // the text of its own (its text nodes, and the children that do not hold it
  // themselves) still does — so a value split across inline elements
  // (`<b>hun</b>ter2`) is found in their parent, and a value shown in two
  // places is found in both.
  function textHolders(root, value, out, budget) {
    var stack = [root];
    while (stack.length > 0) {
      if (--budget.left < 0) return false;
      var node = stack.pop();
      var own = '';
      var deeper = false;
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          own += c.data;
        } else if (c.nodeType === 1) {
          if (NOT_SHOWN[c.tagName.toLowerCase()]) continue;
          var t = c.textContent || '';
          if (t.indexOf(value) !== -1) {
            stack.push(c);
            deeper = true;
            own += '\u0000';
          } else {
            own += t;
          }
        }
      }
      if (!deeper || own.indexOf(value) !== -1) {
        var holder = node.nodeType === 1 ? node : node.host;
        if (holder) out.push(holder);
      }
    }
    return true;
  }

  // Every run of text on screen, for the server to compare with the secrets
  // it knows. False when there is more than the message may carry.
  function visibleTexts(root, out, count) {
    var walker;
    try {
      walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    } catch (err) {
      return true;
    }
    var range = document.createRange();
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      var data = n.data;
      if (!/\S/.test(data)) continue;
      var parent = n.parentElement;
      if (!parent || NOT_SHOWN[parent.tagName.toLowerCase()]) continue;
      range.selectNodeContents(n);
      var r = range.getBoundingClientRect();
      var box = {
        x: Math.round(r.left), y: Math.round(r.top),
        width: Math.round(r.width), height: Math.round(r.height),
      };
      if (!onScreen(box)) continue;
      // Shows a secret typed here: painted already, and never sent.
      if (maskTyped(data) !== data) continue;
      count.runs++;
      count.chars += data.length;
      if (count.runs > MAX_TEXT_RUNS || count.chars > MAX_TEXT_CHARS) return false;
      out.push({ box: box, text: data });
    }
    return true;
  }

  function scanRoot(root) {
    return root === document ? document.body || document.documentElement : root;
  }

  function fieldRects(ask) {
    var wantTexts = !!(ask && ask.text);
    var secret = [];
    var fields = [];
    var texts = [];
    var truncated = false;
    var roots = [document].concat(watchedRootList);
    var seen = 0;
    for (var r = 0; r < roots.length && !truncated; r++) {
      var list;
      try { list = roots[r].querySelectorAll(FIELDS); } catch (err) { continue; }
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (!isTextEntry(el)) continue;
        if (++seen > MAX_FIELDS) {
          truncated = true;
          break;
        }
        var box = boxOf(el);
        if (!box || (box.width === 0 && box.height === 0)) continue;
        if (isSecretNow(el)) {
          secret.push(box);
        } else {
          var v = currentValue(el);
          if (v !== '') fields.push({ box: box, value: v.length > PAGE_VALUE_MAX ? v.slice(0, PAGE_VALUE_MAX) : v });
        }
      }
    }
    // Text that shows a secret typed on this page.
    var typed = typedSecretValues(TYPED_SECRET_MIN);
    var budget = { left: 20000 };
    for (var t = 0; t < typed.length && !truncated; t++) {
      for (var s = 0; s < roots.length; s++) {
        var root = scanRoot(roots[s]);
        if (!root || (root.textContent || '').indexOf(typed[t]) === -1) continue;
        var holders = [];
        if (!textHolders(root, typed[t], holders, budget)) {
          truncated = true;
          break;
        }
        for (var h = 0; h < holders.length; h++) {
          var hb = boxOf(holders[h]);
          if (onScreen(hb)) secret.push(hb);
        }
      }
    }
    if (wantTexts && !truncated) {
      var count = { runs: 0, chars: 0 };
      for (var q = 0; q < roots.length; q++) {
        var textRoot = scanRoot(roots[q]);
        if (textRoot && !visibleTexts(textRoot, texts, count)) {
          truncated = true;
          break;
        }
      }
    }
    var out = { secret: secret, fields: fields };
    if (wantTexts && !truncated) out.texts = texts;
    // The recorder's own toolbar is painted out like a secret — the model is
    // never shown it, and a run (which has no toolbar) never looks for it.
    // A toolbar that is there and cannot say where costs the crop.
    var bar = toolbarBoxes();
    if (bar.boxes.length > 0) out.toolbar = bar.boxes;
    if (truncated || bar.unknown) out.truncated = true;
    return out;
  }

  // ── Typing ─────────────────────────────────────────────────────────────

  function currentValue(el) {
    if (el.isContentEditable && el.tagName.toLowerCase() !== 'input' &&
        el.tagName.toLowerCase() !== 'textarea') {
      return typeof el.innerText === 'string' ? el.innerText : el.textContent || '';
    }
    return el.value == null ? '' : String(el.value);
  }

  function startTyping(el, before) {
    if (typing.has(el)) return;
    var secret = isSecretNow(el);
    typing.set(el, {
      // No picture of a secret field the screen shows in clear — a name-
      // detected token box rendered `type="text"`. A password box shows dots,
      // as on screen (decision 6), and is photographed like any other field;
      // so is one styled to show dots (`showsDots`).
      mark: secret && !showsDots(el) ? undefined : markNow(el),
      desc: describe(el),
      start: baseline.has(el) ? baseline.get(el) : before,
      // Asked at the start AND at the end, so a show/hide toggle in between
      // cannot turn a secret field into a reportable one.
      secret: secret,
    });
  }

  // The action for one field's typing, or null when nothing changed. The
  // secret question is asked here, at the last moment, one more time: this is
  // the only function in the script that reads a typed value. `value` is the
  // field's value to report when it is not the one it holds now (an Enter
  // that sent and cleared a message: what was typed is what it held before).
  function typedAction(el, session, value) {
    if (value === undefined) value = currentValue(el);
    if (value === session.start) return null;
    var secret = session.secret || isSecretNow(el) || holdsTypedSecret(value);
    if (secret) {
      // Remembered here, never sent: the value a toggle may carry into a
      // new element, or a page may show as text.
      rememberSecretValue(el, value);
      rememberFinalSecret(el, value);
    }
    var action = { kind: 'type', target: session.desc, secret: secret };
    if (session.mark) action.mark = session.mark;
    if (!secret) action.value = value.length > PAGE_VALUE_MAX ? value.slice(0, PAGE_VALUE_MAX) : value;
    return action;
  }

  function flushField(el) {
    var session = typing.get(el);
    if (!session) return;
    typing.delete(el);
    baseline.set(el, currentValue(el));
    var action = typedAction(el, session);
    if (action) void send({ type: 'action', action: action });
  }

  function flushAllExcept(keep) {
    var els = [];
    typing.forEach(function (_s, el) { if (el !== keep && !(keep && el.contains(keep))) els.push(el); });
    for (var i = 0; i < els.length; i++) flushField(els[i]);
  }

  // ── Enter in a contenteditable, decided by what it did ─────────────────
  //
  // In a document editor Enter is a new line — typing. In a chat composer it
  // SENDS the message and empties the box, and there it is an action with the
  // typing before it: judged as typing, the message went nowhere (the field
  // ended as it began) and the Enter with it (review 2, finding 3). The key
  // itself cannot tell them apart, so its effect does: once the keypress has
  // settled (the next task, or the next thing the author does, whichever is
  // first — a page that clears the box in a microtask or a re-render has done
  // so by then),
  //
  //   - the content GAINED a line or a block, and was not emptied: typing;
  //   - it was emptied, the element is gone, or nothing changed: the typing
  //     so far is reported with the text it held BEFORE the Enter, and the
  //     Enter is a key action after it.
  //
  // A textarea keeps its rule: Enter there is a newline, and part of the
  // typing.
  var ENTER_SETTLE_MS = 100;
  var pendingEnter = null;

  function editorShape(el) {
    var text = currentValue(el);
    var blocks = 0;
    try {
      blocks = el.querySelectorAll('br,div,p,li,pre,blockquote,h1,h2,h3,h4,h5,h6').length;
    } catch (err) { /* a detached element */ }
    return { text: text, lines: text.split('\n').length, blocks: blocks };
  }

  function sendAction(action) {
    void send({ type: 'action', action: action });
  }

  function settleEnter(sink) {
    var p = pendingEnter;
    if (!p) return;
    pendingEnter = null;
    clearTimeout(p.timer);
    if (!state.recording) return;
    var out = sink || sendAction;
    var gone = !p.el.isConnected;
    var after = gone ? { text: '', lines: 0, blocks: 0 } : editorShape(p.el);
    var emptied = p.before.text.trim() !== '' && after.text.trim() === '';
    var grew = after.blocks > p.before.blocks || after.lines > p.before.lines;
    if (!gone && !emptied && grew) {
      // A new line: typing, like any other keystroke into the field.
      if (!typing.has(p.el)) startTyping(p.el, p.before.text);
      return;
    }
    var session = typing.get(p.el);
    if (session) {
      typing.delete(p.el);
      baseline.set(p.el, after.text);
      var typed = typedAction(p.el, session, p.before.text);
      if (typed) out(typed);
    }
    out(p.action);
  }

  // ── Pick mode (Add check, decision 10) ─────────────────────────────────

  function swallow(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
  }

  var CONTAINERS =
    'section,article,aside,fieldset,dialog,form,[role="region"],[role="group"],' +
    '[role="dialog"],[role="alertdialog"],[role="article"],[role="status"],[role="alert"]';

  function pickNow(target) {
    var el = actionable(target) || target;
    var pick = { target: describe(el) };
    // No picture of a picked secret field: it may be showing its value.
    var mark = isSecretNow(el) ? undefined : markNow(el);
    if (mark) pick.mark = mark;
    var tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable) {
      if (isToggle(el)) {
        pick.checked = el.checked === true;
      } else if (tag === 'select') {
        var chosen = [];
        for (var i = 0; i < el.options.length; i++) {
          if (el.options[i].selected) chosen.push(clip(el.options[i].text, 100));
        }
        pick.selected = chosen;
      } else if (isSecretNow(el)) {
        pick.secret = true;
      } else {
        pick.value = clip(currentValue(el), 300);
      }
    } else {
      pick.text = visibleText(el, 300);
    }
    var ariaChecked = el.getAttribute('aria-checked');
    if (ariaChecked !== null) pick.checked = ariaChecked === 'true';
    // The block around it, so "the Payment method panel says …" has a panel.
    var box = el.parentElement && el.parentElement.closest(CONTAINERS);
    if (box && box !== document.body) {
      pick.container = {
        role: roleOf(box) || box.tagName.toLowerCase(),
        name: nameOrHeading(box),
        text: visibleText(box, 300),
      };
    }
    return pick;
  }

  // eslint-disable-next-line
  __RECORD_TOOLBAR__

  // ── Listeners ──────────────────────────────────────────────────────────
  //
  // Every one of them first asks `isOurs`: an event from the recorder's own
  // toolbar is never an action, never typing, never a focus change. (The
  // gate — the toolbar's first listener — has already stopped such events;
  // the question is asked again so no listener depends on that.)
  //
  // On `window`, in the CAPTURE phase: the first stop of every event's path, so
  // a pick is swallowed before the page's own handlers — even ones registered
  // on window capture, when this script ran first (an init script always does).
  //
  // Pointer, click and key listeners take TRUSTED events only: what the author
  // did, not what a page script dispatched (a styled upload button calling
  // `input.click()`, a framework re-firing a click). The author's own gesture
  // is recorded where it landed.
  //
  // What is an ACTION (decision 4, SPEC-record-steps.md §4): a click, a drag,
  // Enter or Tab, and — seen by the server, not here — Back, Forward, Refresh
  // and an address typed into the bar. A click on a checkbox, a radio, a label
  // for one, a <select> or a file input is a click like any other; what it did
  // (ticked, chose, picked files) follows as an EVENT that rides with it.

  /** A pointer pressed and not yet released — a click in the making, or a drag. */
  var press = null;
  /** An HTML drag-and-drop in progress (dragstart seen, no drop yet). */
  var html5Drag = null;
  /** When a drag last completed: the click the browser fires after a pointer
   *  drag is part of the drag, not a click of its own. */
  var draggedAt = 0;
  /** CSS pixels the pointer must travel before a press is a drag. */
  var DRAG_THRESHOLD_PX = 8;

  function onPointerDown(event) {
    if (!state.recording || state.paused || !event.isTrusted || isOurs(event)) return;
    if (event.button !== undefined && event.button !== 0) return;
    var target = realTarget(event);
    if (!target) return;
    // A new gesture: whatever a pick left to swallow belonged to the last one
    // (a pick released outside the window never gets its click).
    swallowing = false;
    watchShadowRootOf(target);
    // An Enter still being judged happened first.
    settleEnter();
    if (state.pick) {
      swallow(event);
      swallowing = true;
      state.pick = false;
      // The outline and label come down in the same instant, before the crop
      // is asked for (markNow does it again).
      pickApply();
      // Typing still open is finished, and happened before the check.
      flushAllExcept(null);
      var pick = pickNow(target);
      void send({ type: 'pick', pick: pick });
      return;
    }
    var el = actionable(target);
    if (isTextEntry(el)) isSecretNow(el);
    // Typing elsewhere is finished the moment the author points at something
    // else — and it must be reported BEFORE the click it precedes.
    flushAllExcept(el);
    // A text field gets its picture at the first keystroke instead: a click
    // into one is focus, and the typing that follows is the action.
    var mark = isTextEntry(el) ? undefined : markNow(el);
    pointer = { el: el, desc: describe(el), mark: mark, at: Date.now() };
    press = { el: el, desc: pointer.desc, mark: mark, x: event.clientX, y: event.clientY, moved: false };
  }

  function onPointerMove(event) {
    if (!press || press.moved || isOurs(event)) return;
    var dx = event.clientX - press.x;
    var dy = event.clientY - press.y;
    if (dx * dx + dy * dy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) press.moved = true;
  }

  // What a drop landed on: the element under the pointer, or its actionable
  // ancestor when it has one (a card's title → the card).
  function dropTargetAt(x, y, fallback) {
    var hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
    // Released over the toolbar: not dropped on anything of the page's.
    if (isOurHost(hit)) hit = null;
    var el = hit || fallback;
    if (isOurHost(el)) return null;
    if (!el || el.nodeType !== 1) return null;
    return actionable(el) || el;
  }

  // Dragging across text selects it; that is not moving anything.
  function selectedText() {
    try {
      var sel = window.getSelection && window.getSelection();
      return sel && !sel.isCollapsed ? String(sel).trim() : '';
    } catch (err) {
      return '';
    }
  }

  function looksDraggable(el) {
    if (el.getAttribute('draggable') === 'true') return true;
    try {
      var cursor = window.getComputedStyle(el).cursor;
      return cursor === 'move' || cursor === 'grab' || cursor === 'grabbing';
    } catch (err) {
      return false;
    }
  }

  function sendDrag(source, dropEl) {
    var action = { kind: 'drag', target: source.desc, dropTarget: describe(dropEl) };
    if (source.mark) action.mark = source.mark;
    var dropMark = markNow(dropEl);
    if (dropMark) action.dropMark = dropMark;
    draggedAt = Date.now();
    pointer = null;
    void send({ type: 'action', action: action });
  }

  function onPointerUp(event) {
    if (swallowing) {
      swallow(event);
      return;
    }
    var p = press;
    press = null;
    if (!state.recording || state.paused || !event.isTrusted || !p || !p.moved || html5Drag || isOurs(event)) return;
    var dropEl = dropTargetAt(event.clientX, event.clientY, realTarget(event));
    // Released on (or inside) what was pressed: not a drag — a click, or
    // nothing — and the click listener has it.
    if (!dropEl || dropEl === p.el || p.el.contains(dropEl) || dropEl.contains(p.el)) return;
    // A press-move-release that left text selected was selecting text — unless
    // the element says it is meant to be moved (draggable, or a grab/move
    // cursor). Real sortables stop the selection themselves (user-select:
    // none), so this only ever decides the ambiguous case.
    if (selectedText() !== '' && !looksDraggable(p.el)) return;
    // Pressed in a text field and moved: that selects the field's own text
    // (which window.getSelection() does not report), not a drag.
    if (isTextEntry(p.el) && !looksDraggable(p.el)) return;
    sendDrag(p, dropEl);
  }

  function onDragStart(event) {
    if (!state.recording || state.paused || !event.isTrusted || isOurs(event)) return;
    var from = press || { el: actionable(realTarget(event)) || realTarget(event) };
    if (!from.el) return;
    if (!from.desc) from.desc = describe(from.el);
    if (from.mark === undefined) from.mark = markNow(from.el);
    html5Drag = from;
    press = null;
  }

  function onDrop(event) {
    var source = html5Drag;
    html5Drag = null;
    if (!state.recording || state.paused || !source || isOurs(event)) return;
    var dropEl = actionable(realTarget(event)) || realTarget(event);
    if (!dropEl || dropEl === source.el || source.el.contains(dropEl)) return;
    sendDrag(source, dropEl);
  }

  function onDragEnd() {
    // A drag that ended without a drop (cancelled, or dropped outside any
    // target) moved nothing.
    html5Drag = null;
  }

  function swallowRest(event) {
    if (swallowing) swallow(event);
  }

  function onClick(event) {
    if (swallowing) {
      swallow(event);
      swallowing = false;
      return;
    }
    if (!state.recording || state.paused || !event.isTrusted || isOurs(event)) return;
    var target = realTarget(event);
    if (!target) return;
    var el = actionable(target);
    // A label's click on its control (a checkbox, a hidden file input, a
    // button): the author clicked the LABEL, which was reported; this is the
    // browser passing it on, in the same task. Only then: the label is
    // forgotten on the next task, so a later click on that control — Tab to
    // it and Enter, with no pointer-down between — is the author's own
    // (review 2, finding 6: it used to be swallowed for as long as the
    // label's pointer-down was the last one).
    if (labelForward && labelForward.control === el) {
      labelForward = null;
      return;
    }
    var control = labelControl(el);
    if (control) {
      var forward = { control: control };
      labelForward = forward;
      setTimeout(function () {
        if (labelForward === forward) labelForward = null;
        // The change a label's click causes has fired by now, and read the
        // pointer for `viaLabel`; nothing else may.
        if (pointer && pointer.el === el) pointer = null;
      }, 0);
    }
    // The click a browser fires after a pointer drag is part of the drag.
    if (Date.now() - draggedAt < 300) return;
    // Enter in a form field makes the browser click the form's submit button;
    // that click IS the Enter, already reported as a key.
    if (event.detail === 0 && Date.now() - enter.at < 250 && enter.form && el.form === enter.form) {
      enter.at = 0;
      return;
    }
    var fromPointer = pointer && (pointer.el === el || pointer.el.contains(el) || el.contains(pointer.el));
    var desc = fromPointer ? pointer.desc : describe(el);
    var mark = fromPointer ? pointer.mark : (isTextEntry(el) ? undefined : markNow(el));
    // The pointer stays known until the change that may follow (a label click
    // reports `viaLabel` on its tick).
    if (!fromPointer) pointer = null;
    var action = { kind: 'click', target: desc };
    if (mark) action.mark = mark;
    if (event.detail === 0) action.keyboard = true;
    // Pressed in a text field is focus, wherever the release landed: a drag
    // that selected the field's text ends with a click on the common ancestor.
    if (isTextEntry(el) || (fromPointer && isTextEntry(pointer.el))) action.focusOnly = true;
    void send({ type: 'action', action: action });
    // A custom checkbox or switch: what the click did is only known once the
    // page's own handler has run, so it follows on the next task, as the
    // `change` of a native one would.
    var role = roleOf(el);
    if (role === 'checkbox' || role === 'switch' || role === 'radio' ||
        role === 'menuitemcheckbox' || role === 'menuitemradio') {
      setTimeout(function () {
        var checked = el.getAttribute('aria-checked');
        if (checked !== 'true' && checked !== 'false') return;
        if (checked === 'false' && (role === 'radio' || role === 'menuitemradio')) return;
        void send({
          type: 'action',
          action: { kind: checked === 'true' ? 'tick' : 'untick', target: describe(el) },
        });
      }, 0);
    }
  }

  function onChange(event) {
    if (!state.recording || state.paused || isOurs(event)) return;
    var el = realTarget(event);
    if (!el) return;
    var tag = el.tagName.toLowerCase();
    settleEnter();
    // A choice made without pointing — the keyboard, or a script such as
    // Playwright's selectOption — moves no focus, so typing still open in
    // another field has had no focus-out to report it. It happened first.
    if (!isTextEntry(el)) flushAllExcept(el);
    var viaLabel = pointer && pointer.el !== el && labelControl(pointer.el) === el ? pointer : null;
    if (isToggle(el)) {
      var radio = inputType(el) === 'radio';
      if (radio && !el.checked) return;
      var action = { kind: el.checked ? 'tick' : 'untick', target: describe(el) };
      if (viaLabel) action.viaLabel = viaLabel.desc;
      pointer = null;
      void send({ type: 'action', action: action });
      return;
    }
    if (tag === 'select') {
      var chosen = [];
      for (var i = 0; i < el.options.length; i++) {
        if (el.options[i].selected) chosen.push(clip(el.options[i].text, 150));
      }
      pointer = null;
      void send({ type: 'action', action: { kind: 'select', target: describe(el), options: chosen } });
      return;
    }
    if (tag === 'input' && inputType(el) === 'file') {
      var names = [];
      if (el.files) {
        for (var f = 0; f < el.files.length; f++) names.push(clip(el.files[f].name, 200));
      }
      void send({ type: 'action', action: { kind: 'upload', target: describe(el), files: names } });
      return;
    }
    if (isTextEntry(el)) flushField(el);
  }

  function onInput(event) {
    if (!state.recording || state.paused || isOurs(event)) return;
    var el = realTarget(event);
    if (!el || !isTextEntry(el)) return;
    watchShadowRootOf(el);
    startTyping(el, el.defaultValue !== undefined ? String(el.defaultValue) : '');
    // A secret field's value as it stands after every keystroke: what a
    // toggle that replaces the element carries over, even mid-typing.
    var session = typing.get(el);
    if (session && session.secret) rememberSecretValue(el);
  }

  function onFocusIn(event) {
    if (isOurs(event)) return;
    var el = realTarget(event);
    if (!el) return;
    watchShadowRootOf(el);
    if (isTextEntry(el)) {
      isSecretNow(el);
      if (!typing.has(el)) baseline.set(el, currentValue(el));
    }
    reportFocus(el, true);
  }

  function focusedElement() {
    var el = document.activeElement;
    // The active element IS the toolbar's host while a step is typed.
    if (isOurHost(el)) return null;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el && el !== document.body ? el : null;
  }

  function onKeyDown(event) {
    if (!state.recording || state.paused || !event.isTrusted || isOurs(event)) return;
    if (event.isComposing) return;
    // The last Enter's effect is known by the next key.
    settleEnter();
    var el = realTarget(event) || focusedElement();
    var key = event.key;
    if (el && isTextEntry(el) && !typing.has(el) &&
        (key.length === 1 || key === 'Backspace' || key === 'Delete')) {
      // The first keystroke into a field: the picture is taken before it lands.
      startTyping(el, currentValue(el));
    }
    // Enter and Tab are actions; no other key is recorded (Escape included).
    if (key !== 'Enter' && key !== 'Tab') return;
    var tag = el ? el.tagName.toLowerCase() : '';
    var role = el ? roleOf(el) : '';
    // Enter on a button or link is a click, and the click event reports it.
    if (key === 'Enter' && (tag === 'button' || tag === 'a' || role === 'button' || role === 'link')) return;
    // Enter in a textarea is a newline: part of the typing, not an action.
    if (key === 'Enter' && tag === 'textarea') return;
    var action = { kind: 'key', key: key };
    if (event.shiftKey) action.shift = true;
    if (el) action.target = describe(el);
    // Enter in a contenteditable is decided by what it does (above): a new
    // line, or a message sent.
    if (key === 'Enter' && el && el.isContentEditable) {
      var editor = typeof el.closest === 'function'
        ? el.closest('[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]') || el
        : el;
      var judged = { el: editor, before: editorShape(editor), action: action, timer: 0 };
      judged.timer = setTimeout(function () {
        if (pendingEnter === judged) settleEnter();
      }, ENTER_SETTLE_MS);
      pendingEnter = judged;
      return;
    }
    if (el) flushField(el);
    if (key === 'Enter') enter = { at: Date.now(), form: el && el.form ? el.form : null };
    void send({ type: 'action', action: action });
  }

  function onFocusOut(event) {
    if (!state.recording || isOurs(event)) return;
    reportFocus(null, false);
    if (state.paused) return;
    settleEnter();
    var el = realTarget(event);
    if (el && typing.has(el)) flushField(el);
  }

  function onSubmit() {
    if (!state.recording || state.paused) return;
    settleEnter();
    flushAllExcept(null);
  }

  // History hints for a browser the server cannot ask over CDP (Firefox,
  // WebKit): a same-document traversal, and a page restored from the
  // back/forward cache. On Chromium the server reads the tab's own navigation
  // history instead and ignores these.
  function onPopState() {
    if (!state.recording || state.paused || window !== window.top) return;
    void send({ type: 'history', event: 'popstate' });
  }

  function onPageShow(event) {
    if (!state.recording || state.paused || window !== window.top || !event.persisted) return;
    void send({ type: 'history', event: 'bfcache' });
  }

  var opts = { capture: true };
  // From the start of the document: a password box toggled to text before the
  // author ever touches it is still remembered as secret.
  watchTypes(document);
  // FIRST: the toolbar's gate (record-toolbar.js). Registered before every
  // other listener here — and this script runs before the page's — so it
  // hears every event first and can stop the toolbar's own.
  installGate();
  window.addEventListener('pointermove', onPickHover, opts);
  window.addEventListener('scroll', onPickScroll, { capture: true, passive: true });
  window.addEventListener('mouseout', onPickLeave, opts);
  window.addEventListener('pointerdown', onPointerDown, opts);
  window.addEventListener('pointermove', onPointerMove, opts);
  window.addEventListener('pointerup', onPointerUp, opts);
  window.addEventListener('mousedown', swallowRest, opts);
  window.addEventListener('mouseup', swallowRest, opts);
  window.addEventListener('click', onClick, opts);
  window.addEventListener('dragstart', onDragStart, opts);
  window.addEventListener('drop', onDrop, opts);
  window.addEventListener('dragend', onDragEnd, opts);
  window.addEventListener('change', onChange, opts);
  window.addEventListener('input', onInput, opts);
  window.addEventListener('keydown', onKeyDown, opts);
  window.addEventListener('focusin', onFocusIn, opts);
  window.addEventListener('focusout', onFocusOut, opts);
  window.addEventListener('submit', onSubmit, opts);
  window.addEventListener('popstate', onPopState, opts);
  window.addEventListener('pageshow', onPageShow, opts);

  // ── The server's handle ────────────────────────────────────────────────
  //
  // Non-enumerable, and the only thing on `window` besides the binding. Every
  // method takes the control key last (see "The token") and does nothing
  // without it — the page's scripts can reach the object, not the key.
  //   setState({recording, pick, paused, bar, toolbar?}) — Stop, Add check,
  //             Cancel check, Pause, and everything the toolbar shows (the
  //             `toolbar` block goes to top frames only);
  //   claim(token) — this document's token; accepted once, never handed out;
  //   toolbar(command) — a shortcut pressed in a frame, carried out in this
  //             tab's top document: 'open-step' or 'focus-bar';
  //   flush() — the typing not yet reported, RETURNED rather than sent, so the
  //             server has every action in hand before it says stop;
  //   fieldRects({text}) — what the crop being taken must paint out: the
  //             secret fields, and text showing a secret typed here; and the
  //             other fields' values — with {text: true}, every run of text on
  //             screen too — for the server to compare with the secrets it
  //             knows (never a secret field's value, never a typed secret).
  Object.defineProperty(window, CONTROL, {
    value: Object.freeze({
      setState: function (next, key) {
        if (key !== CONTROL_KEY) return false;
        applyState(next);
        return true;
      },
      claim: function (t, key) {
        if (key !== CONTROL_KEY || token !== null || typeof t !== 'string' || t === '') return false;
        token = t;
        // A document that already showed the bar before its token arrived (a
        // page busy at load): say now where focus is.
        setTimeout(focusReportAfterConnect, 0);
        return true;
      },
      toolbar: function (command, key) {
        if (key !== CONTROL_KEY || !IS_TOP || !tb || !state.recording) return false;
        if (command === 'open-step') tbOpenBox();
        else if (command === 'focus-bar') tbFocusBar();
        else return false;
        return true;
      },
      fieldRects: function (ask, key) {
        if (key !== CONTROL_KEY) return null;
        return fieldRects(ask);
      },
      flush: function (key) {
        if (key !== CONTROL_KEY) return [];
        var out = [];
        // An Enter still being judged is decided now, before the typing it
        // may report with its pre-Enter text.
        settleEnter(function (action) { out.push(action); });
        typing.forEach(function (session, el) {
          var action = typedAction(el, session);
          baseline.set(el, currentValue(el));
          if (action) out.push(action);
        });
        typing.clear();
        return out;
      },
    }),
    enumerable: false,
    configurable: false,
    writable: false,
  });

  // How this document came to be, for the top frame: 'navigate', 'reload' or
  // 'back_forward' — and how long ago, so the server can tell a document that
  // loaded during the recording from one that was already there. Used only
  // where the server has no CDP history to ask.
  function navigationHint() {
    if (window !== window.top) return {};
    try {
      var entry = performance.getEntriesByType('navigation')[0];
      return entry ? { navType: String(entry.type), docAgeMs: Math.round(performance.now()) } : {};
    } catch (err) {
      return {};
    }
  }

  // A new document asks once whether a recording is running. Until the answer
  // arrives the script behaves as stopped — which is the safe direction.
  function hello() {
    if (typeof window[BINDING] !== 'function') return false;
    if (!bindingFn) bindingFn = window[BINDING];
    var message = navigationHint();
    message.type = 'hello';
    void send(message).then(applyState);
    return true;
  }
  if (!hello()) {
    document.addEventListener('DOMContentLoaded', hello, { once: true });
  }
})()
