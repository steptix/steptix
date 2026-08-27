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

  function getAttributes(el) {
    var out = '';
    var attrs = el.attributes;
    if (!USE_ATTR_ALLOWLIST) {
      for (var i = 0; i < attrs.length; i++) {
        var a = attrs[i];
        if (DROP_UNSTABLE_IDS && a.name === 'id' && isUnstableId(a.value)) continue;
        out += ' ' + a.name + '="' + escapeAttr(a.value) + '"';
      }
      return out;
    }
    // Allowlist mode: keep curated names + all aria-*. Drops framework noise
    // like data-react-*, data-emotion, data-v-*, long Tailwind class strings,
    // verbose inline style, etc.
    for (var j = 0; j < attrs.length; j++) {
      var b = attrs[j];
      if (DROP_UNSTABLE_IDS && b.name === 'id' && isUnstableId(b.value)) continue;
      if (ALLOWED_ATTRS.has(b.name) || b.name.indexOf('aria-') === 0) {
        out += ' ' + b.name + '="' + escapeAttr(b.value) + '"';
      }
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
        return phIndent + '<' + tag + '> <!-- hidden: ' + hideWhy + ' -->\n';
      }
      return phIndent + '<' + tag + '><!-- hidden: ' + hideWhy + ' --></' + tag + '>\n';
    }

    var indent = '  '.repeat(depth);

    if (tag === 'svg' && COMPACT_SVG) {
      var svgAttrs = getAttributes(el);
      var labelParts = '';
      var svgKids = el.children;
      // Keep <title>/<desc> children — they carry accessible names for icons.
      // Walk only direct children; nested SVG geometry under a <title> is already filtered.
      for (var si = 0; si < svgKids.length; si++) {
        var k = svgKids[si];
        var kt = k.tagName.toLowerCase();
        if (kt === 'title' || kt === 'desc') {
          var txt = (k.textContent || '').replace(/\s+/g, ' ').trim();
          var kAttrs = getAttributes(k);
          labelParts += indent + '  <' + kt + kAttrs + '>' + txt + '</' + kt + '>\n';
        }
      }
      return indent + '<svg' + svgAttrs + '>\n'
           + labelParts
           + indent + '  <!-- svg contents omitted -->\n'
           + indent + '</svg>\n';
    }

    if (tag === 'iframe') {
      var attrs = getAttributes(el);
      var frameSelector = buildSelector(el);
      var idx = iframeIdx++;
      return indent + '<iframe' + attrs + '> <!-- ' + frameSelector + ' -->\n'
           + indent + '  [iframe:' + idx + ']\n'
           + indent + '</iframe>\n';
    }

    var attrs = getAttributes(el);

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
