// Browser-side script used by captureDomSnapshot (and recursively by frame captures).
//
// Loaded as a string by dom-cleaner.ts and passed to page.evaluate / frame.evaluate.
// We pass the script as a string (rather than a function reference) so esbuild/TS
// helper functions like __name never leak into the browser context.
//
// Placeholder substitution:
//   __COLLAPSE__              → `true` / `false`        (boolean literal)
//   __COLLAPSE_MIN_RUN__      → integer literal
//   __COLLAPSE_HEAD__         → integer literal
//   __COLLAPSE_TAIL__         → integer literal
//   __COMPACT_SVG__           → `true` / `false`        (boolean literal)
//   __HIDE_HIDDEN_INPUTS__    → `true` / `false`        (boolean literal)
//   __HIDE_DISPLAY_NONE__     → `true` / `false`        (boolean literal)
//   __HIDE_ARIA_HIDDEN__      → `true` / `false`        (boolean literal)
//   __USE_ATTR_ALLOWLIST__    → `true` / `false`        (boolean literal)
//   __ALLOWED_ATTRS_JSON__    → JSON-stringified string[]
//   __DROP_UNSTABLE_IDS__     → `true` / `false`        (boolean literal)
//   __UNSTABLE_ID_PATTERNS_JSON__ → JSON-stringified string[] of regex sources
//   SECRET_FIELD_RULE (double-underscored, like the others; not spelled out
//   here because the splice would land in this comment too)
//                             → the text of ./secret-field.js, spliced in once
//                               at module load (see `loadSecretFieldRule`)
//
// When `collapse` is true, contiguous runs of same-tag sibling elements of length
// >= COLLAPSE_MIN_RUN are emitted as COLLAPSE_HEAD leading items + an omission
// marker naming the count and an nth-of-type selector pattern + COLLAPSE_TAIL
// trailing items. See stories/collapse-repetitive-dom.md.
//
// When `compactSvg` is true, <svg> elements keep their opening tag + attributes,
// preserve only <title>/<desc> children (the accessible-name carriers), and emit
// a short "<!-- svg contents omitted -->" marker in place of geometry.
//
// When `hideHiddenInputs` is true, `<input type="hidden">` elements are dropped.
// When `hideDisplayNoneElements` is true, elements whose computed `display` is
// `none` are dropped together with their subtrees (requires getComputedStyle).
// When `hideAriaHiddenElements` is true, elements with `aria-hidden="true"`
// are dropped together with their subtrees.
//
// When `useDomAttributeAllowlist` is true, only attributes in ALLOWED_ATTRS
// (substituted via __ALLOWED_ATTRS_JSON__) plus all aria-* are emitted.
// Otherwise every attribute is emitted (legacy / debugging mode).
//
// In both modes, `checked`, `selected` and `value` on a form control come
// from the element's live IDL properties, not from its attributes — a click
// or a keystroke changes the property and never the attribute. See the "Live
// form-control state" block above getAttributes.
//
// When `dropUnstableIds` is true, an `id` attribute matching any of the
// UNSTABLE_ID_REGEXES (React useId, Radix, Headless UI, MUI, etc.) is
// stripped from emission. The element itself is still emitted.

(() => {
  var SKIP_TAGS = new Set(['script', 'style']);
  var SELF_CLOSING_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);

  var COLLAPSE = __COLLAPSE__;
  var COLLAPSE_MIN_RUN = __COLLAPSE_MIN_RUN__;
  var COLLAPSE_HEAD = __COLLAPSE_HEAD__;
  var COLLAPSE_TAIL = __COLLAPSE_TAIL__;
  var COMPACT_SVG = __COMPACT_SVG__;
  var HIDE_HIDDEN_INPUTS = __HIDE_HIDDEN_INPUTS__;
  var HIDE_DISPLAY_NONE = __HIDE_DISPLAY_NONE__;
  var HIDE_ARIA_HIDDEN = __HIDE_ARIA_HIDDEN__;
  var USE_ATTR_ALLOWLIST = __USE_ATTR_ALLOWLIST__;
  var ALLOWED_ATTRS = new Set(__ALLOWED_ATTRS_JSON__);
  var DROP_UNSTABLE_IDS = __DROP_UNSTABLE_IDS__;
  var UNSTABLE_ID_REGEXES = __UNSTABLE_ID_PATTERNS_JSON__.map(function (s) { return new RegExp(s); });

  function isUnstableId(value) {
    if (!value) return false;
    for (var i = 0; i < UNSTABLE_ID_REGEXES.length; i++) {
      if (UNSTABLE_ID_REGEXES[i].test(value)) return true;
    }
    return false;
  }

  // Cheap-then-expensive filter: returns a short reason string when this element
  // (and its subtree) should be replaced with a placeholder, or '' if it should
  // be emitted normally. Order matters — getComputedStyle is the costliest check,
  // so attribute checks run first and short-circuit.
  function hideReason(el, tag) {
    if (HIDE_HIDDEN_INPUTS && tag === 'input') {
      var t = (el.getAttribute('type') || '').toLowerCase();
      if (t === 'hidden') return 'input[type=hidden]';
    }
    if (HIDE_ARIA_HIDDEN && el.getAttribute('aria-hidden') === 'true') return 'aria-hidden';
    if (HIDE_DISPLAY_NONE) {
      var cs = window.getComputedStyle(el);
      if (cs && cs.display === 'none') return 'display:none';
    }
    return '';
  }

  // CSS-escape a value for use inside [attr="<value>"] selectors.
  // Backslash and the matching quote must be escaped per CSS syntax.
  function escAttrCss(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function idSelector(id) {
    if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) return '#' + id;
    return '[id="' + escAttrCss(id) + '"]';
  }

  // Ask the document whether `sel` addresses exactly `el` and nothing else.
  // Hidden matches count — the elements this snapshot renders as attribute-less
  // placeholders are still in the DOM, and are exactly the duplicates that make
  // an "obviously unique" handle ambiguous. An invalid or exotic selector makes
  // querySelectorAll throw; a throw is simply "did not verify".
  function verifies(sel, el) {
    try {
      var found = document.querySelectorAll(sel);
      return found.length === 1 && found[0] === el;
    } catch (err) {
      return false;
    }
  }

  // A selector built from one of el's own attributes, verified to address el
  // and nothing else, or null when no candidate does. Same candidate order as
  // strongSelector in find-in-dom.js (plus iframe[src]); deliberately a second
  // copy rather than shared code — the two scripts are injected independently.
  function attributeSelector(el) {
    var tag = el.tagName.toLowerCase();
    var testId = el.getAttribute('data-testid');
    if (testId) {
      var testIdSel = '[data-testid="' + escAttrCss(testId) + '"]';
      if (verifies(testIdSel, el)) return testIdSel;
    }
    var id = el.getAttribute('id');
    if (id) {
      var idSel = idSelector(id);
      if (verifies(idSel, el)) return idSel;
    }
    var name = el.getAttribute('name');
    if (name) {
      var nameSel = tag + '[name="' + escAttrCss(name) + '"]';
      if (verifies(nameSel, el)) return nameSel;
    }
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      var ariaSel = tag + '[aria-label="' + escAttrCss(ariaLabel) + '"]';
      if (verifies(ariaSel, el)) return ariaSel;
    }
    if (tag === 'iframe') {
      var src = el.getAttribute('src');
      if (src) {
        var srcSel = tag + '[src="' + escAttrCss(src) + '"]';
        if (verifies(srcSel, el)) return srcSel;
      }
    }
    return null;
  }

  // Positional fallback, the shape stableSelector builds in find-in-dom.js:
  // walk up collecting nth-of-type(N) steps until an ancestor has a verified
  // attribute selector, e.g. "#list>li:nth-of-type(3)". Unique by construction,
  // since the anchor matches exactly one element (or is `body`) and a child
  // combinator chain from one element reaches one element.
  //
  // Joined WITHOUT spaces on purpose. This function's result reaches the AI as
  // an iframe's frame path, and resolveLocatorRoot (src/browser/actions.ts)
  // splits a frame selector on whitespace when it carries no " >> " chain — a
  // spaced chain would be torn into three broken frameLocator segments.
  function positionalSelector(el) {
    var parts = [];
    var cur = el;
    while (cur && cur !== document.body && cur.parentElement) {
      var parent = cur.parentElement;
      var tag = cur.tagName.toLowerCase();
      // nth-of-type is 1-indexed over same-tag siblings within the parent.
      // Compare tags lowercase for consistency across HTML (uppercase) and SVG (mixed).
      var n = 1;
      var sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName.toLowerCase() === tag) n++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(tag + ':nth-of-type(' + n + ')');
      var parentSel = attributeSelector(parent);
      if (parentSel) {
        parts.unshift(parentSel);
        return parts.join('>');
      }
      cur = parent;
    }
    parts.unshift('body');
    return parts.join('>');
  }

  // Build a selector the document confirms addresses el alone: an attribute
  // handle when one verifies, else a positional path. Never a bare tag — that
  // was the old last resort, and it made the omission marker's "target directly
  // with <parent> > li:nth-of-type(N)" hint an instruction that did not work.
  //
  // Two call sites, neither per-element: once per iframe, and once per parent
  // that actually emits an omission marker. Keep it that way — the verification
  // is a querySelectorAll, so calling this per element would be quadratic.
  function buildSelector(el) {
    var direct = attributeSelector(el);
    if (direct) return direct;
    return positionalSelector(el);
  }

  // HTML-escape an attribute value for emission inside the rendered snapshot
  // (distinct from CSS escaping — here we're writing HTML-like text, not CSS).
  function escapeAttr(v) {
    return String(v == null ? '' : v).replace(/"/g, '&quot;');
  }

  // ── Live form-control state ────────────────────────────────────────────
  //
  // `el.attributes` is the STATIC attribute map: what the HTML source said,
  // plus anything a script explicitly setAttribute'd. Interaction never goes
  // there. A click on a checkbox sets the `checked` IDL property, choosing an
  // option sets `option.selected`, typing sets `input.value` — and ordinary
  // page code (`box.checked = false`) never writes the attribute back.
  //
  // Read from attributes alone, then, every form control in the snapshot is
  // frozen at its page-load state for the life of the page. A page shipping
  // `<input type="checkbox" id="pay-cash" name="cash" checked>` still
  // snapshots as `checked` after a click unticks it, so a condition or
  // assertion judged from the snapshot reads the page-load answer forever.
  // (Found live: a judge reported "the Cash checkbox is currently checked"
  // about a box Playwright had just unticked — and the same click had
  // disabled the Pay now button, which only happens when it is UNticked.)
  //
  // So the three state-carrying names in the allowlist — `checked`,
  // `selected`, `value` — are asked of the element, not of its markup.
  // Everything else stays attribute-sourced, and wherever live state and
  // markup agree the emitted text is byte-identical to what it was before.

  /** Own-property test that survives attribute names like "constructor". */
  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  // Appended in this order when live state has no markup attribute to sit on.
  var LIVE_STATE_NAMES = ['checked', 'selected', 'value'];

  // Input types whose `.value` is not user-entered state, so the markup's
  // attribute (normally absent) stands unchanged:
  //   password — kept in this set for the record, but `liveState` routes it
  //              to `isSecretField` instead: a secret field's value is MASKED
  //              (`value="***"`) rather than dropped, and `isSecretField` is
  //              also what survives a show/hide toggle to `type="text"`.
  //   file     — `.value` is the browser fiction "C:\fakepath\name.ext".
  //   hidden   — dropped entirely under the default options anyway.
  //   submit / reset / button / image — a label, not state.
  // checkbox and radio never reach this set: their state is `checked`, and
  // their `.value` defaults to "on", which would put `value="on"` on every
  // checkbox in every snapshot.
  var STATIC_VALUE_INPUT_TYPES = new Set([
    'password', 'file', 'hidden', 'submit', 'reset', 'button', 'image',
  ]);

  // ── "Is this a secret field?" ──────────────────────────────────────────
  //
  // Defines SECRET_NAME_RE, PASSWORD_FIELD_RE, hasPinToken and isSecretField.
  // The rule lives in ONE place, ./secret-field.js, and dom-cleaner.ts splices
  // it in here at module load — the expand walk and the step recorder load the
  // same text, so the three cannot drift (tests/secret-field-parity.test.ts).
  __SECRET_FIELD_RULE__

  // A live value collapses to one line. Every other element in this snapshot
  // occupies exactly one line and callers split on '\n' to find one; a
  // textarea's live value is the one attribute value that routinely contains
  // newlines. Markup-sourced values are left exactly as they were.
  function oneLine(v) {
    return String(v).replace(/\s+/g, ' ');
  }

  // The live `value` to emit, or null for "say nothing". A blank control
  // whose markup carried no `value` has nothing to say — `value=""` on every
  // empty field is noise the snapshot never carried. An explicit `value=""`
  // in the markup still prints, exactly as before.
  function liveValue(el) {
    var v = el.value == null ? '' : String(el.value);
    if (v === '' && !el.hasAttribute('value')) return null;
    return oneLine(v);
  }

  // A secret field's value is never quoted — but its PRESENCE is worth
  // saying. Dropping the attribute reads exactly like an empty field, and a
  // condition, a `Verify` and the watch group's poller all decide from this
  // text: "the password box is filled" and "the password box is empty" are
  // different answers. `***` is the same mask the step prompt, the report and
  // the run log use for a secret value (src/utils/secrets.ts, MASK).
  //
  // Empty answers null, which DROPS any `value` the markup carried: for a
  // secret field the markup's value is no safer than the live one.
  function maskedValue(el) {
    var v = el.value == null ? '' : String(el.value);
    return v === '' ? null : '***';
  }

  // Attribute names this element owns live, mapped to the string to emit
  // ('' for the bare `checked` / `selected` form) or null for "off: emit
  // nothing, whatever the markup says". A null return means nothing here is
  // live, so every attribute comes from the markup as before.
  function liveState(el, tag) {
    if (tag === 'option') return { selected: el.selected ? '' : null };
    // A <select>'s value is one of the `<option>` values the snapshot already
    // prints in full, so withholding it would hide nothing that is not on the
    // next line anyway — no secret test here.
    if (tag === 'select') return { value: liveValue(el) };
    // A textarea's default value is its child text, which the snapshot
    // already prints. Only speak up once the live text has diverged from it.
    if (tag === 'textarea') {
      if (isSecretField(el)) return { value: maskedValue(el) };
      return { value: el.value !== el.defaultValue ? oneLine(el.value) : null };
    }
    if (tag !== 'input') return null;
    var type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return { checked: el.checked ? '' : null };
    // The label-and-fiction types first, and `password` deliberately excluded
    // from that hop: their `.value` is not user state at all (a button's
    // label, a file input's "C:\fakepath\…"), so there is nothing to withhold
    // and `***` would delete a label the model targets by.
    if (type !== 'password' && STATIC_VALUE_INPUT_TYPES.has(type)) return null;
    // `type="password"` catches the field while it still says so;
    // `isSecretField` catches the same field after a show/hide toggle has
    // made it a text input, and the secret-NAMED fields that were never
    // `type=password` to begin with. Either way the value is masked rather
    // than dropped — see `maskedValue`.
    if (isSecretField(el)) return { value: maskedValue(el) };
    return { value: liveValue(el) };
  }

  function getAttributes(el, tag) {
    var out = '';
    var attrs = el.attributes;
    var live = liveState(el, tag || el.tagName.toLowerCase());
    var overwritten = {};
    // Allowlist mode keeps curated names + all aria-*, dropping framework
    // noise like data-react-*, data-emotion, data-v-*, long Tailwind class
    // strings, verbose inline style, etc. Legacy mode emits everything.
    for (var i = 0; i < attrs.length; i++) {
      var a = attrs[i];
      if (DROP_UNSTABLE_IDS && a.name === 'id' && isUnstableId(a.value)) continue;
      if (USE_ATTR_ALLOWLIST && !ALLOWED_ATTRS.has(a.name) && a.name.indexOf('aria-') !== 0) continue;
      var value = a.value;
      if (live && hasOwn(live, a.name)) {
        overwritten[a.name] = true;
        // The state is off, so the markup's attribute is stale: drop it.
        if (live[a.name] === null) continue;
        value = live[a.name];
      }
      out += ' ' + a.name + '="' + escapeAttr(value) + '"';
    }
    // Live state with no attribute to sit on: a checkbox ticked by a click,
    // an option chosen from a list, text typed into an empty field.
    if (live) {
      for (var n = 0; n < LIVE_STATE_NAMES.length; n++) {
        var name = LIVE_STATE_NAMES[n];
        if (!hasOwn(live, name) || live[name] === null || overwritten[name]) continue;
        if (USE_ATTR_ALLOWLIST && !ALLOWED_ATTRS.has(name)) continue;
        out += ' ' + name + '="' + escapeAttr(live[name]) + '"';
      }
    }
    if (USE_ATTR_ALLOWLIST) out += identityClass(el, out);
    return out;
  }

  // An element with no text and nothing in the allowlist to name it is,
  // in an allowlisted snapshot, indistinguishable from its siblings: three
  // empty <div>s that are the red, green and blue circles of a drag page, or
  // the empty <span> that is a tree's expand toggle. Its class is then the
  // only identity it has (docs/specs/SPEC-web-survey-fixes.md §2.18), so keep
  // a few READABLE class names — never a hashed or generated one, which would
  // only invite a selector that breaks on the next build.
  var NAMING_ATTRS = ['id', 'data-testid', 'name', 'aria-label', 'title', 'alt', 'placeholder', 'href', 'for', 'value'];
  function identityClass(el, emitted) {
    var raw = el.getAttribute && el.getAttribute('class');
    if (!raw) return '';
    for (var i = 0; i < NAMING_ATTRS.length; i++) {
      if (emitted.indexOf(' ' + NAMING_ATTRS[i] + '="') !== -1) return '';
    }
    if ((el.textContent || '').trim() !== '') return '';
    var kept = [];
    var tokens = raw.split(/\s+/);
    for (var t = 0; t < tokens.length && kept.length < 4; t++) {
      var tok = tokens[t];
      if (!/^[A-Za-z][A-Za-z0-9_-]{1,40}$/.test(tok)) continue;
      if (/\d{3,}/.test(tok)) continue;
      if (/^(css|sc|jsx|emotion|svelte|chakra|mantine|tw)-/i.test(tok)) continue;
      // A styled-components / CSS-modules hash: a short prefix, then a run of
      // mixed-case letters and digits ("sc-bdVaJa", "Button_root__x8Kf2").
      if (/[a-z][A-Z]/.test(tok) && /\d/.test(tok)) continue;
      if (/__[A-Za-z0-9]{4,}$/.test(tok)) continue;
      kept.push(tok);
    }
    return kept.length > 0 ? ' class="' + escapeAttr(kept.join(' ')) + '"' : '';
  }

  // The one hidden element that IS a legitimate target.
  //
  // A styled uploader — the shape almost every real site uses — is a visible
  // button next to an <input type="file"> at display:none. Collapsing that
  // input to a bare <input> placeholder like every other hidden element left
  // the model unable to name it at all: it could see a button and nothing to
  // upload to. Keep just enough to target it and to tell one field from
  // another, and no more (stories/upload-action.md §7, decision 9).
  //
  // Deliberately narrow: only when the INPUT ITSELF is the hidden element. An
  // input inside a hidden ancestor is still collapsed with that ancestor —
  // the opener route covers that layout.
  var UPLOAD_PLACEHOLDER_ATTRS = ['id', 'name', 'type', 'accept', 'multiple'];

  function hiddenFileInputAttrs(el, tag) {
    if (tag !== 'input') return '';
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (type !== 'file') return '';
    var out = '';
    for (var i = 0; i < UPLOAD_PLACEHOLDER_ATTRS.length; i++) {
      var name = UPLOAD_PLACEHOLDER_ATTRS[i];
      if (!el.hasAttribute(name)) continue;
      if (DROP_UNSTABLE_IDS && name === 'id' && isUnstableId(el.getAttribute(name))) continue;
      out += ' ' + name + '="' + escapeAttr(el.getAttribute(name)) + '"';
    }
    return out;
  }

  var iframeIdx = 0;
  /** How many open shadow roots the walk is inside. */
  var shadowDepth = 0;

  function processElement(el, depth) {
    var tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return '';
    var hideWhy = hideReason(el, tag);
    if (hideWhy) {
      // Keep iframeIdx aligned with Playwright's locator('iframe').all() walk
      // in injectFrameContent — that walk visits iframes regardless of visibility,
      // so we still need to "consume" indices for hidden iframes / iframe-bearing
      // subtrees inside the hidden element, even though their content is replaced
      // with a placeholder.
      iframeIdx += countIframesIn(el);
      // Emit a tag-only placeholder so DOM structure (and nth-of-type / nth-child
      // positions) remains intact for selector generation. Attributes are dropped
      // — the element isn't a target, so id/class/aria etc. are pure noise.
      var phIndent = '  '.repeat(depth);
      if (SELF_CLOSING_TAGS.has(tag)) {
        // An <input> is self-closing, so this is the only branch a hidden file
        // input can take.
        return phIndent + '<' + tag + hiddenFileInputAttrs(el, tag)
          + '> <!-- hidden: ' + hideWhy + ' -->\n';
      }
      return phIndent + '<' + tag + '><!-- hidden: ' + hideWhy + ' --></' + tag + '>\n';
    }

    var indent = '  '.repeat(depth);

    if (tag === 'svg' && COMPACT_SVG) {
      var svgAttrs = getAttributes(el, tag);
      var labelParts = '';
      var svgKids = el.children;
      // Keep <title>/<desc> children — they carry accessible names for icons.
      // Walk only direct children; nested SVG geometry under a <title> is already filtered.
      for (var si = 0; si < svgKids.length; si++) {
        var k = svgKids[si];
        var kt = k.tagName.toLowerCase();
        if (kt === 'title' || kt === 'desc') {
          var txt = (k.textContent || '').replace(/\s+/g, ' ').trim();
          var kAttrs = getAttributes(k, kt);
          labelParts += indent + '  <' + kt + kAttrs + '>' + txt + '</' + kt + '>\n';
        }
      }
      return indent + '<svg' + svgAttrs + '>\n'
           + labelParts
           + indent + '  <!-- svg contents omitted -->\n'
           + indent + '</svg>\n';
    }

    if (tag === 'iframe' && shadowDepth > 0) {
      // Playwright's locator('iframe').all() lists shadow-root frames after
      // every light-DOM one, so an index here would point injectFrameContent
      // at the wrong frame. Shown, not expanded.
      return indent + '<iframe' + getAttributes(el, tag) + '> <!-- inside a shadow root: contents not captured -->\n';
    }

    if (tag === 'iframe') {
      var attrs = getAttributes(el, tag);
      var frameSelector = buildSelector(el);
      var idx = iframeIdx++;
      return indent + '<iframe' + attrs + '> <!-- ' + frameSelector + ' -->\n'
           + indent + '  [iframe:' + idx + ']\n'
           + indent + '</iframe>\n';
    }

    var attrs = getAttributes(el, tag);

    if (SELF_CLOSING_TAGS.has(tag)) {
      return indent + '<' + tag + attrs + '>\n';
    }

    // An open shadow root is what the page renders, and Playwright's CSS
    // selectors reach into it as written; without it a web component's fields
    // were simply absent (SPEC-web-survey-fixes.md §2.26). A closed root is
    // unreachable from page script, for Playwright too, so it stays invisible.
    var shadowOutput = '';
    if (el.shadowRoot) {
      shadowDepth++;
      try {
        shadowOutput = indent + '  <!-- shadow-root (open) -->\n'
          + processChildNodes(el.shadowRoot, depth + 1)
          + indent + '  <!-- /shadow-root -->\n';
      } finally {
        shadowDepth--;
      }
    }
    var childOutput = processChildNodes(el, depth + 1);
    return indent + '<' + tag + attrs + '>\n'
         + shadowOutput
         + childOutput
         + indent + '</' + tag + '>\n';
  }

  // Collect indices of a contiguous same-tag element run starting at children[startIdx].
  // Pure-whitespace text nodes are transparent (common sibling noise); any other
  // node type or a different tag terminates the run. Comparison is by lowercase
  // tagName so HTML (uppercase) and SVG/XML (mixed) are treated consistently.
  function collectSameTagRun(children, startIdx) {
    var startEl = children[startIdx];
    if (!startEl || startEl.nodeType !== 1) return [];
    var startTag = startEl.tagName.toLowerCase();
    var idxs = [startIdx];
    for (var i = startIdx + 1; i < children.length; i++) {
      var n = children[i];
      if (n.nodeType === 3) {
        var t = (n.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t) continue;
        break;
      }
      if (n.nodeType !== 1) break;
      if (n.tagName.toLowerCase() !== startTag) break;
      idxs.push(i);
    }
    return idxs;
  }

  // Count iframes inside a subtree without emitting anything. Used when a
  // subtree is omitted during collapse so iframeIdx stays in sync with the
  // injectFrameContent walk (which enumerates ALL iframes in DOM order via
  // Playwright's locator — skipping them here would misalign the indices).
  function countIframesIn(el) {
    var tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return 0;
    if (tag === 'iframe') return 1;
    var total = 0;
    var kids = el.children;
    for (var i = 0; i < kids.length; i++) {
      total += countIframesIn(kids[i]);
    }
    return total;
  }

  function processChildNodes(parent, depth) {
    var output = '';
    var indent = '  '.repeat(depth);
    var nodes = parent.childNodes;

    // nth-of-type is 1-indexed and per-tag, so an omission marker can safely
    // name "nth-of-type(N)" regardless of interleaved text nodes or sibling tags.
    //
    // Built lazily, on the first marker this parent actually emits. This
    // function runs for every element with children, while a collapsed run is
    // rare — computing it eagerly would put buildSelector's querySelectorAll
    // verification on the per-element path, which is the one thing it must not
    // be on. null = not built yet; a parent with several collapsed runs builds
    // it once.
    var parentSel = null;

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];

      if (node.nodeType === 1) {
        // ELEMENT_NODE
        if (COLLAPSE) {
          var elemIdxs = collectSameTagRun(nodes, i);
          if (elemIdxs.length >= COLLAPSE_MIN_RUN) {
            var runTag = node.tagName.toLowerCase();
            var headCount = Math.min(COLLAPSE_HEAD, elemIdxs.length);
            var tailCount = Math.min(COLLAPSE_TAIL, elemIdxs.length - headCount);
            var omittedCount = elemIdxs.length - headCount - tailCount;

            // Render head
            for (var h = 0; h < headCount; h++) {
              output += processElement(nodes[elemIdxs[h]], depth);
            }

            if (omittedCount > 0) {
              // Keep iframeIdx in sync with injectFrameContent's DOM-order walk:
              // count (but do not emit) iframes inside every omitted subtree.
              for (var k = 0; k < omittedCount; k++) {
                iframeIdx += countIframesIn(nodes[elemIdxs[headCount + k]]);
              }

              var firstOmitted = headCount + 1;
              var lastOmitted = headCount + omittedCount;
              // A shadow root is not an element; its host is what a selector names.
              if (parentSel === null) parentSel = buildSelector(parent.nodeType === 11 ? parent.host : parent);
              var parentPart = parentSel ? parentSel + ' > ' : '';
              output += indent + '<!-- ' + omittedCount + ' similar <' + runTag
                     + '> elements omitted (nth-of-type ' + firstOmitted + '..' + lastOmitted
                     + '). Use find "<text>" to locate one, or target directly with '
                     + parentPart + runTag + ':nth-of-type(N). -->\n';
            }

            // Render tail
            for (var t2 = elemIdxs.length - tailCount; t2 < elemIdxs.length; t2++) {
              output += processElement(nodes[elemIdxs[t2]], depth);
            }

            // Skip past the entire run
            i = elemIdxs[elemIdxs.length - 1];
            continue;
          }
        }
        output += processElement(node, depth);
      } else if (node.nodeType === 3) {
        // TEXT_NODE — collapse whitespace, drop if empty
        var text = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) {
          output += indent + text + '\n';
        }
      }
      // COMMENT_NODE (8) and others: drop
    }
    return output;
  }

  try {
    var body = document.body;
    if (!body) return '<body>(empty)</body>';
    // Scripts can add elements as children of <html> beside <body> — Google's
    // full-screen and anchored ads do, with their Close buttons — and the page
    // shows them like anything else. Walk every child of <html> but <head>, in
    // document order, so they reach the snapshot and the [iframe:N] numbering
    // keeps Playwright's locator('iframe') order (SPEC-web-survey-fixes.md
    // §2.48).
    var result = '';
    var top = document.documentElement ? document.documentElement.children : [body];
    for (var t = 0; t < top.length; t++) {
      var child = top[t];
      if (child.tagName === 'HEAD') continue;
      result += processElement(child, 0);
    }
    return result || '<body>(no content)</body>';
  } catch (err) {
    return '<error>Failed to capture DOM: ' + String(err) + '</error>';
  }
})()
