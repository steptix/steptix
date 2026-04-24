// Browser-side script used by findInDom.
//
// Loaded as a string by dom-cleaner.ts and passed to page.evaluate.
//
// Placeholder substitution:
//   __SEARCH_TEXT__      → JSON-stringified search string         (JS string literal)
//   __CONTAINER_EXPR__   → JS expression producing the root element (Element | null)
//   __CONTAINER_LABEL__  → JSON-stringified container selector (for error messages)
//   __DISPLAY_CAP__      → integer literal
//   __HARD_MAX__         → integer literal

(() => {
  var searchText = __SEARCH_TEXT__.toLowerCase();
  var containerLabel = __CONTAINER_LABEL__;
  var SKIP = new Set(['script', 'style', 'noscript', 'svg', 'meta', 'link', 'base', 'title']);
  var DISPLAY_CAP = __DISPLAY_CAP__;
  var HARD_MAX = __HARD_MAX__;
  var matches = [];
  var totalMatches = 0;
  var hitHardMax = false;

  // Escape a value for use inside a CSS attribute selector: [attr="<value>"].
  // Per CSS syntax, backslash and the matching quote character must be escaped.
  function escAttr(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  // Escape an id for use in a #id selector. CSS id selectors tolerate most chars
  // but choke on quotes, spaces, and CSS syntax chars — fall back to [id="..."]
  // when the id contains anything outside a safe whitelist.
  function idSelector(id) {
    if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) return '#' + id;
    return '[id="' + escAttr(id) + '"]';
  }

  // Strong selector or null. "Strong" = uniquely addressable from document root
  // without ancestor context (data-testid / id / name / aria-label / anchor href).
  function strongSelector(el) {
    var testId = el.getAttribute('data-testid');
    if (testId) return '[data-testid="' + escAttr(testId) + '"]';
    var id = el.getAttribute('id');
    if (id) return idSelector(id);
    var tag = el.tagName.toLowerCase();
    var name = el.getAttribute('name');
    if (name) return tag + '[name="' + escAttr(name) + '"]';
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return tag + '[aria-label="' + escAttr(ariaLabel) + '"]';
    if (tag === 'a') {
      var href = el.getAttribute('href');
      if (href) return 'a[href="' + escAttr(href) + '"]';
    }
    return null;
  }

  // Build a stable CSS selector for el. If el itself has a strong selector, returns it.
  // Otherwise walks up collecting nth-of-type(N) segments until reaching an addressable
  // ancestor, producing e.g. "#orders > tr:nth-of-type(42) > td:nth-of-type(3)".
  function stableSelector(el) {
    var direct = strongSelector(el);
    if (direct) return direct;
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

  function getKeyAttrs(el) {
    var attrs = [];
    var keys = ['id', 'data-testid', 'role', 'name', 'type', 'href'];
    for (var k = 0; k < keys.length; k++) {
      var v = el.getAttribute(keys[k]);
      if (v) attrs.push(keys[k] + '="' + v + '"');
    }
    return attrs.join(' ');
  }

  function getAncestorChain(el) {
    var parts = [];
    var cur = el.parentElement;
    var depth = 0;
    while (cur && cur !== document.body && depth < 4) {
      var tag = cur.tagName.toLowerCase();
      var id = cur.getAttribute('id');
      var testId = cur.getAttribute('data-testid');
      var label = tag;
      if (testId) label += '[data-testid="' + testId + '"]';
      else if (id) label += '#' + id;
      parts.unshift(label);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  function walk(el) {
    if (totalMatches >= HARD_MAX) { hitHardMax = true; return; }
    var tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) return;
    var text = (el.textContent || '').trim();
    // textContent is hierarchical — if the subtree doesn't contain the query,
    // no descendant does either, so bail early.
    if (!text.toLowerCase().includes(searchText)) return;

    var hasChildMatch = false;
    var kids = el.children;
    for (var c = 0; c < kids.length; c++) {
      if ((kids[c].textContent || '').trim().toLowerCase().includes(searchText)) {
        hasChildMatch = true;
        break;
      }
    }

    if (!hasChildMatch) {
      totalMatches++;
      if (matches.length < DISPLAY_CAP) {
        matches.push({
          selector: stableSelector(el),
          tag: tag,
          text: text.substring(0, 200),
          attributes: getKeyAttrs(el),
          context: getAncestorChain(el),
        });
      }
      // Leaf match — no descendant contains the text, nothing deeper to find here.
      return;
    }

    for (var d = 0; d < kids.length; d++) {
      if (totalMatches >= HARD_MAX) { hitHardMax = true; return; }
      walk(kids[d]);
    }
  }

  try {
    var root = __CONTAINER_EXPR__;
    if (!root) {
      return {
        matches: [],
        totalMatches: 0,
        hitHardMax: false,
        containerError: 'No element matches container selector: ' + containerLabel,
      };
    }
    walk(root);
    return { matches: matches, totalMatches: totalMatches, hitHardMax: hitHardMax };
  } catch (err) {
    return {
      matches: [{ selector: '', tag: 'error', text: String(err), attributes: '', context: '' }],
      totalMatches: 1,
      hitHardMax: false,
    };
  }
})()
