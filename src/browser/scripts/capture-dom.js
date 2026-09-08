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
  // `type` alone cannot answer it. The "show password" eye on most sign-in
  // forms flips the field to `type="text"`, and a guard that reads the
  // CURRENT type then hands the typed password straight to the snapshot —
  // one click after it correctly withheld it. So the question is asked of
  // the things a toggle cannot move: how the field describes itself to a
  // password manager (`autocomplete`) and what it is NAMED.
  //
  // A WeakSet of every element ever seen as `type=password` would be the
  // exact answer, but each capture is its own `evaluate()` call with its own
  // scope — there is nowhere to keep one across captures.
  //
  // The name rule mirrors `isSecretName` in src/utils/secrets.ts (defined in
  // src/parser/parameters.ts): /password|secret|token|key/i. This script is
  // stringified into the page and cannot import it, so it is copied — keep
  // the two in step. It over-matches on purpose, exactly as the framework's
  // does: a field named `keywords` loses its live value from the snapshot,
  // which costs the model one attribute and cannot leak anything.
  var SECRET_NAME_RE = /password|secret|token|key/i;

  // ...and a second test, deliberately WIDER, that applies to FIELD names
  // only. The two questions are not the same question:
  //
  //   a PARAMETER name decides whether a value the run OWNS is masked in the
  //   run's own output — the author chose the name, can see the masking, and
  //   has `## Config: unmask:` when it over-matches;
  //
  //   a FIELD name decides whether a value the run does NOT own is DISCLOSED
  //   to the model and to a report — the page chose the name, `unmask` does
  //   not reach it, and there is no second chance once it is written.
  //
  // So the field question is answered more harshly. `pwd` is one of the two
  // commonest names for a password input and matches nothing in
  // `isSecretName`, so a show/hide toggle on `<input name="pwd">` handed the
  // typed password to the snapshot (review 4, finding 1).
  //
  // It is `SECRET_NAME_RE` plus the password family, minus the bare `key`
  // that makes the name rule over-match — so on the identity attributes,
  // where both are tested, `secret` and `token` here change nothing. They
  // are load-bearing for `placeholder` (below), which is tested against THIS
  // regex alone: `placeholder="API secret key"` is a token box, and
  // `placeholder="Search by keyword"` is not.
  //
  // `pass` is fenced by lookarounds, not `\b`, because the bare substring is
  // in ordinary field names that hold nothing secret: `passenger1_name`,
  // `passportNumber`, `bypass_cache`, `compass_heading`, `aria-label="Passenger
  // 1 full name"` — a travel booking cannot verify a passenger name it can only
  // read as `***` (review 5, finding 2). A `\b` fence was tried first and
  // leaked: JavaScript's `\b` counts `_` and digits as word characters, so
  // `\bpass\b` never fired on `passwd`, `user_pass`, `pass1`, `new_pass` or
  // `txtPass` (review 6, finding 1). The lookarounds exclude only the four
  // measured false positives and leave every other `pass…` masked.
  var PASSWORD_FIELD_RE =
    /pwd|(?<!by|com)pass(?!enger|port)|credential|secret|token/i;

  // `pin` gets neither treatment. `\bpin\b` had the `_`/digit blind spot
  // (`pin_code`, `user_pin`, `pin1` leaked — review 7, finding 1), and a bare
  // `pin` sits inside `shipping`, `spinner`, `typing`, `pinned` and
  // `opinion`, so lookarounds would need a list nobody could finish. So it is
  // matched on TOKENS: camelCase is split, everything that is not a letter is
  // a separator, and a whole token of `pin` / `mpin` / `pincode` decides.
  // `pinCode`, `atmPin`, `securityPin`, `card_pin`, `login-pin`, `pin1` and
  // `PINCODE` all mask; `shipping_address` and `spinner` do not. The boundary
  // of the rule is a run-together lowercase compound — `newpin`, `userpin`,
  // `confirmpin` — which has no token edge to find and is left uncovered on
  // purpose: covering it needs the prefix list this comment says nobody can
  // finish, and `name` attributes take that shape least of all.
  function hasPinToken(text) {
    var tokens = String(text)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z]+/);
    for (var t = 0; t < tokens.length; t++) {
      if (tokens[t] === 'pin' || tokens[t] === 'mpin' || tokens[t] === 'pincode') return true;
    }
    return false;
  }

  // Where a field's IDENTITY lives — what it is called, for a human or for a
  // password manager.
  var SECRET_NAME_ATTRS = ['name', 'id', 'aria-label', 'autocomplete'];

  // Prose written for a person, so only the harsh test applies to it. A
  // placeholder is not an identifier — "Search by keyword" is where the word
  // `keyword` actually lives on real pages, and reading it with the name rule
  // cost ordinary search boxes their live value. But it is very often the
  // ONLY thing naming a password box on a minimal sign-in form: `<input
  // type="password" placeholder="Password">` with no name, no id and no
  // aria-label leaked its typed value the moment a show/hide toggle made it
  // `type="text"`, and an API-key box rendered `type="text"` on purpose leaks
  // with no toggle at all (review 5, finding 1).
  var PASSWORD_ONLY_ATTRS = ['placeholder'];

  // Neither rule has an escape hatch: `## Config: unmask:` reaches the run's
  // own parameters (src/parser/types.ts) and not this script, which is
  // evaluated in the page with no config input. An author whose app names a
  // filter `keyword` cannot un-withhold it here.
  function isSecretField(el) {
    if ((el.getAttribute('type') || '').toLowerCase() === 'password') return true;
    // Explicit, ahead of the name sweep below: this is what a field named
    // only by a sibling <label> still tells a password manager.
    var autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (autocomplete.indexOf('current-password') !== -1) return true;
    if (autocomplete.indexOf('new-password') !== -1) return true;
    for (var i = 0; i < SECRET_NAME_ATTRS.length; i++) {
      var named = el.getAttribute(SECRET_NAME_ATTRS[i]);
      if (!named) continue;
      if (SECRET_NAME_RE.test(named) || PASSWORD_FIELD_RE.test(named) || hasPinToken(named)) return true;
    }
    for (var j = 0; j < PASSWORD_ONLY_ATTRS.length; j++) {
      var prose = el.getAttribute(PASSWORD_ONLY_ATTRS[j]);
      if (!prose) continue;
      if (PASSWORD_FIELD_RE.test(prose) || hasPinToken(prose)) return true;
    }
    return false;
  }

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
    return out;
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

    var childOutput = processChildNodes(el, depth + 1);
    return indent + '<' + tag + attrs + '>\n'
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
              if (parentSel === null) parentSel = buildSelector(parent);
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
    var result = processElement(body, 0);
    return result || '<body>(no content)</body>';
  } catch (err) {
    return '<error>Failed to capture DOM: ' + String(err) + '</error>';
  }
})()
