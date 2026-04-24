// Browser-side script used by captureDomSnapshot (and recursively by frame captures).
//
// Loaded as a string by dom-cleaner.ts and passed to page.evaluate / frame.evaluate.
// We pass the script as a string (rather than a function reference) so esbuild/TS
// helper functions like __name never leak into the browser context.
//
// Placeholder substitution:
//   __COLLAPSE__           → `true` / `false`        (boolean literal)
//   __COLLAPSE_MIN_RUN__   → integer literal
//   __COLLAPSE_HEAD__      → integer literal
//   __COLLAPSE_TAIL__      → integer literal
//   __COMPACT_SVG__        → `true` / `false`        (boolean literal)
//
// When `collapse` is true, contiguous runs of same-tag sibling elements of length
// >= COLLAPSE_MIN_RUN are emitted as COLLAPSE_HEAD leading items + an omission
// marker naming the count and an nth-of-type selector pattern + COLLAPSE_TAIL
// trailing items. See stories/collapse-repetitive-dom.md.
//
// When `compactSvg` is true, <svg> elements keep their opening tag + attributes,
// preserve only <title>/<desc> children (the accessible-name carriers), and emit
// a short "<!-- svg contents omitted -->" marker in place of geometry.

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

  // CSS-escape a value for use inside [attr="<value>"] selectors.
  // Backslash and the matching quote must be escaped per CSS syntax.
  function escAttrCss(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function idSelector(id) {
    if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) return '#' + id;
    return '[id="' + escAttrCss(id) + '"]';
  }

  function buildSelector(el) {
    var testId = el.getAttribute('data-testid');
    if (testId) return '[data-testid="' + escAttrCss(testId) + '"]';
    var id = el.getAttribute('id');
    if (id) return idSelector(id);
    var tag = el.tagName.toLowerCase();
    var name = el.getAttribute('name');
    if (name) return tag + '[name="' + escAttrCss(name) + '"]';
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return tag + '[aria-label="' + escAttrCss(ariaLabel) + '"]';
    var src = el.getAttribute('src');
    if (src && tag === 'iframe') return tag + '[src="' + escAttrCss(src) + '"]';
    return tag;
  }

  // HTML-escape an attribute value for emission inside the rendered snapshot
  // (distinct from CSS escaping — here we're writing HTML-like text, not CSS).
  function escapeAttr(v) {
    return String(v == null ? '' : v).replace(/"/g, '&quot;');
  }

  function getAttributes(el) {
    var out = '';
    var attrs = el.attributes;
    for (var i = 0; i < attrs.length; i++) {
      var a = attrs[i];
      out += ' ' + a.name + '="' + escapeAttr(a.value) + '"';
    }
    return out;
  }

  var iframeIdx = 0;

  function processElement(el, depth) {
    var tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return '';

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
    var parentSel = COLLAPSE ? buildSelector(parent) : '';

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
