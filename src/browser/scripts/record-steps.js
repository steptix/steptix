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
//   SECRET_FIELD_RULE (double-underscored) → ./secret-field.js, the one copy
//                           of `isSecretField` the snapshot also uses
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
  if (Object.prototype.hasOwnProperty.call(window, CONTROL)) return;

  // eslint-disable-next-line
  __SECRET_FIELD_RULE__

  var state = { recording: false, pick: false };
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

  function send(message) {
    var fn = window[BINDING];
    if (typeof fn !== 'function') return Promise.resolve(null);
    try {
      return Promise.resolve(fn(message)).catch(function () { return null; });
    } catch (err) {
      return Promise.resolve(null);
    }
  }

  function applyState(next) {
    if (!next || typeof next !== 'object') return;
    var wasRecording = state.recording;
    state.recording = next.recording === true;
    state.pick = state.recording && next.pick === true;
    if (!state.recording) {
      // Stopping drops whatever was half-typed: the server has already asked
      // for it through `flush` before it says stop.
      typing.clear();
      pointer = null;
      swallowing = false;
    } else if (!wasRecording) {
      typing.clear();
    }
  }

  // ── Text ───────────────────────────────────────────────────────────────

  function clip(value, max) {
    var s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
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
    var secret = isSecretField(el);
    typing.set(el, {
      // No picture of a secret field the screen shows in clear — a name-
      // detected token box rendered `type="text"`. A password box shows dots,
      // as on screen (decision 6), and is photographed like any other field.
      mark: secret && !(el.tagName.toLowerCase() === 'input' && inputType(el) === 'password')
        ? undefined
        : markNow(el),
      desc: describe(el),
      start: baseline.has(el) ? baseline.get(el) : before,
      // Asked at the start AND at the end, so a show/hide toggle in between
      // cannot turn a secret field into a reportable one.
      secret: secret,
    });
  }

  // The action for one field's typing, or null when nothing changed. The
  // secret question is asked here, at the last moment, one more time: this is
  // the only function in the script that reads a typed value.
  function typedAction(el, session) {
    var value = currentValue(el);
    if (value === session.start) return null;
    var secret = session.secret || isSecretField(el);
    var action = { kind: 'type', target: session.desc, secret: secret };
    if (session.mark) action.mark = session.mark;
    if (!secret) action.value = value.length > 2000 ? value.slice(0, 2000) : value;
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
    var mark = markNow(el);
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
      } else if (isSecretField(el)) {
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

  // ── Listeners ──────────────────────────────────────────────────────────
  //
  // On `window`, in the CAPTURE phase: the first stop of every event's path, so
  // a pick is swallowed before the page's own handlers — even ones registered
  // on window capture, when this script ran first (an init script always does).

  function onPointerDown(event) {
    if (!state.recording) return;
    if (event.button !== undefined && event.button !== 0) return;
    var target = realTarget(event);
    if (!target) return;
    if (state.pick) {
      swallow(event);
      swallowing = true;
      state.pick = false;
      var pick = pickNow(target);
      void send({ type: 'pick', pick: pick });
      return;
    }
    var el = actionable(target);
    // Typing elsewhere is finished the moment the author points at something
    // else — and it must be reported BEFORE the click it precedes.
    flushAllExcept(el);
    // A text field gets its picture at the first keystroke instead: a click
    // into one is focus, and the typing that follows is the action.
    var mark = isTextEntry(el) ? undefined : markNow(el);
    pointer = { el: el, desc: describe(el), mark: mark, at: Date.now() };
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
    if (!state.recording) return;
    var target = realTarget(event);
    if (!target) return;
    var el = actionable(target);
    var tag = el.tagName.toLowerCase();
    // Reported by `change`, which knows the outcome: a checkbox, a radio or a
    // label for one (ticked or not), a <select> and its options (which one),
    // a file input (which files).
    if (isToggle(el) || isToggle(labelControl(el))) return;
    if (tag === 'select' || tag === 'option' || el.closest('select')) return;
    if (tag === 'input' && inputType(el) === 'file') return;
    if (event.detail === 0 && Date.now() - enter.at < 250 && enter.form && el.form === enter.form) {
      enter.at = 0;
      return;
    }
    var fromPointer = pointer && (pointer.el === el || pointer.el.contains(el) || el.contains(pointer.el));
    var desc = fromPointer ? pointer.desc : describe(el);
    var mark = fromPointer ? pointer.mark : (isTextEntry(el) ? undefined : markNow(el));
    pointer = null;
    var action = { kind: 'click', target: desc };
    if (mark) action.mark = mark;
    if (event.detail === 0) action.keyboard = true;
    if (isTextEntry(el)) action.focusOnly = true;
    // A custom checkbox or switch: its state is only known once the page's
    // own handler has run, so read it on the next task.
    var role = roleOf(el);
    if (role === 'checkbox' || role === 'switch' || role === 'radio' ||
        role === 'menuitemcheckbox' || role === 'menuitemradio') {
      setTimeout(function () {
        var checked = el.getAttribute('aria-checked');
        if (checked === 'true') action.kind = 'tick';
        else if (checked === 'false') action.kind = role === 'radio' ? 'click' : 'untick';
        void send({ type: 'action', action: action });
      }, 0);
      return;
    }
    void send({ type: 'action', action: action });
  }

  function onChange(event) {
    if (!state.recording) return;
    var el = realTarget(event);
    if (!el) return;
    var tag = el.tagName.toLowerCase();
    // A choice made without pointing — the keyboard, or a script such as
    // Playwright's selectOption — moves no focus, so typing still open in
    // another field has had no focus-out to report it. It happened first.
    if (!isTextEntry(el)) flushAllExcept(el);
    var viaLabel = pointer && pointer.el !== el && labelControl(pointer.el) === el ? pointer : null;
    var fromPointer = pointer && (pointer.el === el || viaLabel) ? pointer : null;
    if (isToggle(el)) {
      var radio = inputType(el) === 'radio';
      if (radio && !el.checked) return;
      var action = { kind: el.checked ? 'tick' : 'untick', target: describe(el) };
      if (fromPointer && fromPointer.mark) action.mark = fromPointer.mark;
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
      var select = { kind: 'select', target: describe(el), options: chosen };
      if (fromPointer && fromPointer.mark) select.mark = fromPointer.mark;
      pointer = null;
      void send({ type: 'action', action: select });
      return;
    }
    if (tag === 'input' && inputType(el) === 'file') {
      var names = [];
      if (el.files) {
        for (var f = 0; f < el.files.length; f++) names.push(clip(el.files[f].name, 200));
      }
      var upload = { kind: 'upload', target: describe(el), files: names };
      var m = markNow(el);
      if (m) upload.mark = m;
      void send({ type: 'action', action: upload });
      return;
    }
    if (isTextEntry(el)) flushField(el);
  }

  function onInput(event) {
    if (!state.recording) return;
    var el = realTarget(event);
    if (!el || !isTextEntry(el)) return;
    startTyping(el, el.defaultValue !== undefined ? String(el.defaultValue) : '');
  }

  function onFocusIn(event) {
    var el = realTarget(event);
    if (el && isTextEntry(el) && !typing.has(el)) baseline.set(el, currentValue(el));
  }

  function focusedElement() {
    var el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el && el !== document.body ? el : null;
  }

  // Did the page react? Escape only counts when it closed or changed something.
  function watchForChange(then) {
    var changed = false;
    var observer = new MutationObserver(function () { changed = true; });
    try {
      observer.observe(document.documentElement, {
        subtree: true, childList: true, attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-expanded', 'aria-hidden'],
      });
    } catch (err) { /* no document yet */ }
    var before = focusedElement();
    setTimeout(function () {
      observer.disconnect();
      then(changed || focusedElement() !== before);
    }, 300);
  }

  function onKeyDown(event) {
    if (!state.recording) return;
    if (event.isComposing) return;
    var el = realTarget(event) || focusedElement();
    var key = event.key;
    if (el && isTextEntry(el) && !typing.has(el) &&
        (key.length === 1 || key === 'Backspace' || key === 'Delete')) {
      // The first keystroke into a field: the picture is taken before it lands.
      startTyping(el, currentValue(el));
    }
    if (key !== 'Enter' && key !== 'Escape' && key !== 'Tab') return;
    var tag = el ? el.tagName.toLowerCase() : '';
    var role = el ? roleOf(el) : '';
    // Enter on a button or link is a click, and the click event reports it.
    if (key === 'Enter' && (tag === 'button' || tag === 'a' || role === 'button' || role === 'link')) return;
    // Enter in a textarea is a newline: part of the typing, not an action.
    if (key === 'Enter' && tag === 'textarea') return;
    if (el) flushField(el);
    if (key === 'Enter') enter = { at: Date.now(), form: el && el.form ? el.form : null };
    var action = { kind: 'key', key: key };
    if (event.shiftKey) action.shift = true;
    if (el) action.target = describe(el);
    if (key === 'Escape') {
      watchForChange(function (did) {
        if (did && state.recording) void send({ type: 'action', action: action });
      });
      return;
    }
    void send({ type: 'action', action: action });
  }

  function onFocusOut(event) {
    if (!state.recording) return;
    var el = realTarget(event);
    if (el && typing.has(el)) flushField(el);
  }

  function onSubmit() {
    if (!state.recording) return;
    flushAllExcept(null);
  }

  var opts = { capture: true };
  window.addEventListener('pointerdown', onPointerDown, opts);
  window.addEventListener('mousedown', swallowRest, opts);
  window.addEventListener('pointerup', swallowRest, opts);
  window.addEventListener('mouseup', swallowRest, opts);
  window.addEventListener('click', onClick, opts);
  window.addEventListener('change', onChange, opts);
  window.addEventListener('input', onInput, opts);
  window.addEventListener('keydown', onKeyDown, opts);
  window.addEventListener('focusin', onFocusIn, opts);
  window.addEventListener('focusout', onFocusOut, opts);
  window.addEventListener('submit', onSubmit, opts);

  // ── The server's handle ────────────────────────────────────────────────
  //
  // Non-enumerable, and the only thing on `window` besides the binding.
  //   setState({recording, pick}) — Stop, Add check, Cancel check;
  //   flush() — the typing not yet reported, RETURNED rather than sent, so the
  //             server has every action in hand before it says stop.
  Object.defineProperty(window, CONTROL, {
    value: Object.freeze({
      setState: function (next) { applyState(next); return true; },
      flush: function () {
        var out = [];
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

  // A new document asks once whether a recording is running. Until the answer
  // arrives the script behaves as stopped — which is the safe direction.
  function hello() {
    if (typeof window[BINDING] !== 'function') return false;
    void send({ type: 'hello' }).then(applyState);
    return true;
  }
  if (!hello()) {
    document.addEventListener('DOMContentLoaded', hello, { once: true });
  }
})()
