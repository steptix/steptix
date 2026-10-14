// Browser-side controller for the interaction highlight
// (docs/specs/SPEC-interaction-highlight.md §3.3, §8).
//
// Loaded as text by src/browser/highlight.ts, turned into a function there and
// handed to `locator.evaluateAll(fn, args)`, so it runs in the element's own
// frame — an iframe's target is ringed in the iframe's document with nothing
// per frame on the Node side. Plain ES5-style JS rather than TypeScript for
// the reason capture-dom.js gives: esbuild/TS helpers such as __name must
// never reach the page. The file is ONE function expression and nothing may
// follow it, because highlight.ts evaluates `return (<this file>)`.
//
// `args`: { tag, key, kind: 'act' | 'read', durationMs, colors: { act, read },
// max?, withHref? }. `tag` and `key` are HIGHLIGHT_TAG and
// HIGHLIGHT_REGISTRY_KEY from highlight.ts, passed in so the two sides cannot
// drift. Answers how many rings it drew; with `withHref`, which the sink
// always passes, `{ drawn, href }`, naming the document that drew. The action
// that marked never waits for the answer; a model capture and `endRings` do,
// while the draw is in flight (highlight.ts `trackDraw`, spec §4.3 rules 5
// and 14).
//
// The construction is the recorder toolbar's (record-toolbar.js `resetHost`,
// `pickBuild`), for the same reasons:
//
//   - one `<steptix-highlight>` host per document, under <html>, created on
//     the first ring and removed when the last one ends, so pages already
//     open, CDP tabs and frames need no init script;
//   - a CLOSED shadow root, styled by one adopted constructable sheet and by
//     per-property `style.setProperty`, built with createElement only: no
//     <style>, no style attribute, no innerHTML, so a strict
//     Content-Security-Policy and Trusted Types have nothing to refuse;
//   - shown as a manual popover, in the browser's top layer, above a modal
//     dialog or a z-index-max header, with `pointer-events: none` so every
//     click, `elementFromPoint` and Playwright's hit-target check still land
//     on the page;
//   - a bare host: no id, class, role, aria-live, `open` or text, which are
//     what DIAGNOSE_SCRIPT (src/browser/page-state.ts) and the notice
//     recorder (src/browser/notices.ts) look for. capture-dom.js skips a
//     direct child of <html> with the tag that carries the registry handle,
//     and nothing else of that name (§4.1).
//
// A ring's own timing lives here, as Web Animations: `animation.finished`
// ends a ring, and no Node timer starts, holds or ends one. (Node's timers
// are its own waits: how long a capture waits for a frame, and when it asks
// a frame again whether a host is left.) Each ring is two elements, so that its visibility
// cannot outlive its lifetime whatever the page's main thread is doing: the
// outer `.ring` animates only opacity and transform (the draw-in, the hold
// and the fade to 0), which the engines run on the compositor; the inner
// `.glow` carries the border and the box-shadow pulse, which is painted on
// the main thread. A page that blocks its main thread (`window.print()`, a
// long task) freezes the glow, while the envelope still fades to nothing on
// schedule. One animation moving all three would run on the main thread as a
// whole (docs/specs/SPEC-interaction-highlight.md §16.9). Reduced motion is decided with `matchMedia`, not with
// a @media rule in the sheet, because WebKit ignored that rule in an adopted
// sheet while `matchMedia` followed `emulateMedia` in all three engines (§5.4).
//
// The registry handle `host[Symbol.for(<key>)]` is how tests reach rings a
// closed root keeps from `document.getAnimations()`. Steptix's own hide,
// restore and end (highlight.ts `onRegistry`) do NOT call it: they work on
// the document directly, synchronously, so a page cannot stall a capture by
// planting a host whose methods never return.
//
// What the page can do, honestly: this runs in the page's MAIN world, the
// same JavaScript world as the page's own scripts. A page can find the host
// and the handle, hide or end Steptix's rings, forge a host of its own, and
// observe which element is being ringed — through a patched
// `getBoundingClientRect` or `animate` as easily as through anything here.
// `controllerFor` does refuse to hand the targets to a host whose `mark` is
// not this script's own code, which closes the cheapest way in, not every way.
(function steptixHighlight(elements, args) {
  var KEY = Symbol.for(String(args.key));
  // How many captures are hiding the rings in this document right now. A
  // COUNT, not a flag, and on the document rather than the host: two
  // overlapping hides (a session read during a batch's own model capture)
  // would otherwise let the first restore show the rings to the second
  // capture, and a host rebuilt while a capture holds them hidden must start
  // hidden. highlight.ts's `onRegistry` keeps the same count when there is no
  // host to ask.
  var HIDDEN = Symbol.for(String(args.key) + '.hidden');
  // When this document last ran an animation frame with rings live, on this
  // document's own Date.now(). highlight.ts's `registryCall` reads it on the
  // same document's clock, also when it runs in the parent's realm, which may
  // keep another time. Its hide waits for a paint only in a document that is
  // being drawn: one Chrome has stopped rendering (an out-of-view cross-site
  // frame) runs no animation frames, and a capture draws it blank anyway.
  var TICK = Symbol.for(String(args.key) + '.tick');
  // How the count is kept: one entry per capture holding the rings hidden,
  // keyed by a token, each with the time it lapses. An entry that is never
  // removed — its restore lost to a frame that stopped answering, or to a
  // navigation that took the capture's restore to another document while
  // this one sat in the back/forward cache — lapses on its own instead of
  // hiding this document's rings for good. highlight.ts writes the same
  // entries.
  /** How long one capture's hide holds before it lapses (see HIDDEN); kept
   *  equal to HIDE_LAPSE_MS in highlight.ts. */
  var HIDE_LAPSE_MS = 60000;
  /** Live rings per document; the oldest finishes early past this (§5.2). */
  var MAX_RINGS = 32;
  /** The ring stands this far outside the element's box, in CSS pixels. */
  var OUTSET = 3;

  var RING_CSS = [
    // The envelope: placed, promoted to its own layer, and animated in
    // opacity and transform only, so the compositor runs it.
    '.ring{position:fixed;box-sizing:border-box;pointer-events:none;margin:0;padding:0;',
    'background:transparent;border:0;transform-origin:50% 50%;will-change:opacity,transform}',
    '.glow{position:absolute;left:0;top:0;right:0;bottom:0;box-sizing:border-box;pointer-events:none;',
    'margin:0;padding:0;background:transparent;border:2px solid var(--stx-c,#3b82f6);border-radius:6px;',
    // Three layers so one contrasts with any background: the colour, a white
    // halo outside it, a dark hairline outside that, then the glow (§8).
    'box-shadow:0 0 0 2px rgba(255,255,255,0.85),0 0 0 3px rgba(0,0,0,0.35),0 0 12px 3px var(--stx-glow,transparent)}',
  ].join('');

  var doc = elements && elements.length > 0 && elements[0] ? elements[0].ownerDocument : null;
  var drawn = 0;
  if (doc && doc.documentElement) {
    var ctl = controllerFor(doc, String(args.tag));
    if (ctl) drawn = ctl.mark(elements, args);
  }
  // With `withHref`, also say which document drew: highlight.ts records the
  // frame, and gives it a grace past the ring's lifetime when `[use computer]`
  // ends the rings (docs/specs/SPEC-interaction-highlight.md §16.8, §16.9).
  if (!args.withHref) return drawn;
  var href = '';
  try { href = doc && doc.location ? String(doc.location.href) : ''; } catch (err) { href = ''; }
  return { drawn: drawn, href: href };

  function important(el, prop, value) {
    try { el.style.setProperty(prop, value, 'important'); } catch (err) { /* an old engine */ }
  }

  /** The recorder's `resetHost` with `pointer-events: none`, and a 0×0 box
   *  at the viewport's corner like its pick outline: the rings are fixed,
   *  and `overflow: visible` lets them draw outside it. No transform, filter
   *  or contain, any of which would make the host the rings' containing
   *  block instead of the viewport. */
  function resetHost(el) {
    important(el, 'all', 'initial');
    important(el, 'position', 'fixed');
    important(el, 'display', 'block');
    important(el, 'inset', 'auto');
    important(el, 'left', '0');
    important(el, 'top', '0');
    important(el, 'width', '0');
    important(el, 'height', '0');
    important(el, 'margin', '0');
    important(el, 'padding', '0');
    important(el, 'border', '0');
    important(el, 'background', 'transparent');
    important(el, 'overflow', 'visible');
    important(el, 'z-index', '2147483647');
    important(el, 'visibility', 'visible');
    important(el, 'opacity', '1');
    important(el, 'pointer-events', 'none');
    important(el, 'transform', 'none');
    important(el, 'filter', 'none');
    important(el, 'contain', 'none');
    important(el, 'max-height', 'none');
    important(el, 'min-width', '0');
  }

  /** Whether `fn` is this script's own code: its source is a piece of this
   *  function's source. A page's own `<steptix-highlight>`, or one forging
   *  the handle, fails it, and is never handed the elements being ringed. */
  function isOwnCode(fn) {
    try {
      var text = Function.prototype.toString.call(fn);
      return text.length > 200 && Function.prototype.toString.call(steptixHighlight).indexOf(text) !== -1;
    } catch (err) {
      return false;
    }
  }

  /** The document's controller: the one on its host, else a new one. Only a
   *  direct child of <html> with the tag AND a handle whose `mark` is this
   *  script's own counts as ours; a page element that merely has the name is
   *  passed over, not shadowing ours. */
  function controllerFor(d, tag) {
    var kids = d.documentElement.children;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (String(el.tagName).toLowerCase() !== tag) continue;
      var handle = el[KEY];
      if (handle && typeof handle.mark === 'function' && isOwnCode(handle.mark)) return handle;
    }
    return build(d, tag);
  }

  function build(d, tag) {
    var win = d.defaultView || window;
    var host = d.createElement(tag);
    resetHost(host);
    host.setAttribute('aria-hidden', 'true');
    var root;
    try {
      root = host.attachShadow({ mode: 'closed' });
    } catch (err) {
      return null;
    }
    try {
      var sheet = new win.CSSStyleSheet();
      sheet.replaceSync(RING_CSS);
      root.adoptedStyleSheets = [sheet];
    } catch (err) { /* no constructable sheets: the per-ring properties still place it */ }
    try { host.setAttribute('popover', 'manual'); } catch (err) { /* no popover: z-index only */ }

    var state = { rings: [], byEl: new WeakMap(), raf: 0 };

    /** The live hide entries on the document (see HIDDEN). */
    function hideEntries() {
      var html = d.documentElement;
      var entries = html ? html[HIDDEN] : null;
      if (!entries || typeof entries !== 'object') {
        entries = {};
        if (html) html[HIDDEN] = entries;
      }
      return entries;
    }

    function isHidden() {
      var entries = hideEntries();
      var now = Date.now();
      for (var token in entries) {
        if (Object.prototype.hasOwnProperty.call(entries, token) && entries[token] > now) return true;
      }
      return false;
    }

    /** Show or hide the host to match the document's entries. */
    function applyHidden() {
      important(host, 'visibility', isHidden() ? 'hidden' : 'visible');
    }
    applyHidden();
    var handleTokens = 0;

    function othersOnTop() {
      var selectors = [':modal', ':popover-open'];
      for (var s = 0; s < selectors.length; s++) {
        var list;
        try { list = d.querySelectorAll(selectors[s]); } catch (err) { continue; }
        for (var i = 0; i < list.length; i++) if (list[i] !== host) return true;
      }
      return false;
    }

    /** Into the top layer, or back to its top when the page has opened a
     *  dialog or popover since (§3.3 item 4): re-raised on a mark, not
     *  continuously, so a ring already live under a new modal stays there. */
    function mount() {
      var html = d.documentElement;
      if (!html) return;
      if (host.parentNode !== html) {
        try { html.appendChild(host); } catch (err) { return; }
      }
      if (typeof host.showPopover !== 'function') return;
      try {
        var open = host.matches(':popover-open');
        if (open && !othersOnTop()) return;
        if (open) host.hidePopover();
        host.showPopover();
      } catch (err) { /* the z-index stands in */ }
    }

    function teardown() {
      if (state.raf) {
        try { win.cancelAnimationFrame(state.raf); } catch (err) { /* ignore */ }
        state.raf = 0;
      }
      try { if (host.matches(':popover-open')) host.hidePopover(); } catch (err) { /* ignore */ }
      if (host.parentNode) host.parentNode.removeChild(host);
    }

    function retire(rec) {
      if (rec.done) return;
      rec.done = true;
      var i = state.rings.indexOf(rec);
      if (i !== -1) state.rings.splice(i, 1);
      if (state.byEl.get(rec.el) === rec) state.byEl.delete(rec.el);
      var anim = rec.anim;
      var glow = rec.glowAnim;
      rec.anim = null;
      rec.glowAnim = null;
      if (anim) {
        try { anim.cancel(); } catch (err) { /* ignore */ }
      }
      if (glow) {
        try { glow.cancel(); } catch (err) { /* ignore */ }
      }
      if (rec.node.parentNode) rec.node.parentNode.removeChild(rec.node);
      if (state.rings.length === 0) teardown();
    }

    /** Follow the element: hidden while its box is off screen or gone to
     *  nothing, else outset around it. */
    function place(rec) {
      var b = rec.el.getBoundingClientRect();
      var w = win.innerWidth;
      var h = win.innerHeight;
      if (b.width === 0 || b.height === 0 || b.right < 0 || b.bottom < 0 || b.left > w || b.top > h) {
        rec.node.style.setProperty('display', 'none');
        return;
      }
      rec.node.style.removeProperty('display');
      rec.box = {
        left: b.left - OUTSET,
        top: b.top - OUTSET,
        width: b.width + 2 * OUTSET,
        height: b.height + 2 * OUTSET,
      };
      rec.node.style.setProperty('left', rec.box.left + 'px');
      rec.node.style.setProperty('top', rec.box.top + 'px');
      rec.node.style.setProperty('width', rec.box.width + 'px');
      rec.node.style.setProperty('height', rec.box.height + 'px');
    }

    /** One loop for every live ring. A ring whose element left the document
     *  goes on the next frame; the loop stops with the last ring. */
    function tick() {
      state.raf = 0;
      try { d.documentElement[TICK] = Date.now(); } catch (err) { /* no document element */ }
      // An entry can lapse with no call to say so; the next frame notices.
      applyHidden();
      var live = state.rings.slice();
      for (var i = 0; i < live.length; i++) {
        var rec = live[i];
        if (rec.done) continue;
        if (!rec.el.isConnected) {
          retire(rec);
          continue;
        }
        try { place(rec); } catch (err) { retire(rec); }
      }
      if (state.rings.length > 0) state.raf = win.requestAnimationFrame(tick);
    }

    function startLoop() {
      if (state.raf || state.rings.length === 0) return;
      try { state.raf = win.requestAnimationFrame(tick); } catch (err) { state.raf = 0; }
    }

    function rgba(hex, alpha) {
      var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex));
      if (!m) return 'transparent';
      var h = m[1].length === 3
        ? m[1].charAt(0) + m[1].charAt(0) + m[1].charAt(1) + m[1].charAt(1) + m[1].charAt(2) + m[1].charAt(2)
        : m[1];
      return 'rgba(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ','
        + parseInt(h.slice(4, 6), 16) + ',' + alpha + ')';
    }

    /** §8's "trace and glow" envelope (scale in, hold, fade), or under
     *  reduced motion a ring that appears at full strength, holds, and fades:
     *  no scale. Opacity and transform only (see the top of this file). */
    function envelopeFor(reduced) {
      if (reduced) return [{ opacity: 1 }, { opacity: 1, offset: 0.95 }, { opacity: 0 }];
      return [
        { offset: 0, opacity: 0, transform: 'scale(1.12)', easing: 'cubic-bezier(.2,.8,.2,1)' },
        { offset: 0.06, opacity: 1, transform: 'scale(1)' },
        { offset: 0.8, opacity: 1, transform: 'scale(1)' },
        { offset: 1, opacity: 0, transform: 'scale(1)' },
      ];
    }

    /** §8's glow pulse, on the inner element; none under reduced motion,
     *  where the sheet's steady glow stands. The colour is written into the
     *  frames as rgba() rather than color-mix(), which an older CDP-attached
     *  Chrome would drop with the whole shadow. */
    function glowFor(color) {
      var halo = '0 0 0 2px rgba(255,255,255,0.85), 0 0 0 3px rgba(0,0,0,0.35), ';
      var glow = halo + '0 0 12px 3px ' + rgba(color, 0.55);
      var pulse = halo + '0 0 20px 8px ' + rgba(color, 0.6);
      return [
        { offset: 0, boxShadow: glow },
        { offset: 0.06, boxShadow: glow },
        { offset: 0.15, boxShadow: pulse },
        { offset: 0.25, boxShadow: glow },
        { offset: 1, boxShadow: glow },
      ];
    }

    function animate(rec, color, durationMs, reduced) {
      var olds = [rec.anim, rec.glowAnim];
      rec.anim = null;
      rec.glowAnim = null;
      for (var o = 0; o < olds.length; o++) {
        if (!olds[o]) continue;
        try { olds[o].cancel(); } catch (err) { /* ignore */ }
      }
      var timing = { duration: durationMs, easing: 'linear', fill: 'forwards' };
      var anim = rec.node.animate(envelopeFor(reduced), timing);
      rec.anim = anim;
      if (!reduced) {
        // The glow may fail on its own: the envelope, which decides the
        // ring's life, still runs.
        try { rec.glowAnim = rec.glow.animate(glowFor(color), timing); } catch (err) { rec.glowAnim = null; }
      }
      anim.finished.then(
        function () { if (rec.anim === anim) retire(rec); },
        function () { /* cancelled by a restart or a retire */ }
      );
    }

    function mark(els, opts) {
      var kind = opts.kind === 'read' ? 'read' : 'act';
      var colors = opts.colors || {};
      var color = String(colors[kind] || (kind === 'read' ? '#a855f7' : '#3b82f6'));
      var durationMs = Number(opts.durationMs) > 0 ? Number(opts.durationMs) : 3000;
      var max = Number(opts.max) > 0 ? Number(opts.max) : els.length;
      var reduced = false;
      try { reduced = !!win.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (err) { reduced = false; }

      var drawn = 0;
      // `max` counts rings DRAWN, not elements looked at: a read of every
      // match whose first twenty are hidden still rings the visible ones.
      for (var i = 0; i < els.length && drawn < max; i++) {
        var el = els[i];
        if (!el || el.ownerDocument !== d || typeof el.getBoundingClientRect !== 'function') continue;
        // No box, no ring: a hidden file input, a display:none toggle (§3.3 item 10).
        var b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        var rec = state.byEl.get(el);
        if (rec && !rec.done) {
          // One ring per element: marking it again restarts its ring, in the
          // new kind's colour, as the newest.
          state.rings.splice(state.rings.indexOf(rec), 1);
          state.rings.push(rec);
        } else {
          rec = {
            el: el, node: d.createElement('div'), glow: d.createElement('div'),
            anim: null, glowAnim: null, kind: kind, box: null, done: false,
          };
          rec.node.setAttribute('class', 'ring');
          rec.glow.setAttribute('class', 'glow');
          rec.node.appendChild(rec.glow);
          state.byEl.set(el, rec);
          state.rings.push(rec);
          root.appendChild(rec.node);
        }
        rec.kind = kind;
        rec.node.setAttribute('data-kind', kind);
        rec.node.style.setProperty('--stx-c', color);
        rec.node.style.setProperty('--stx-glow', rgba(color, 0.55));
        try {
          place(rec);
          animate(rec, color, durationMs, reduced);
        } catch (err) {
          // Element.prototype.animate patched away, or similar: no ring, and
          // never an error for the step.
          retire(rec);
          continue;
        }
        drawn++;
      }
      while (state.rings.length > MAX_RINGS) retire(state.rings[0]);
      if (drawn > 0 && state.rings.length > 0) {
        mount();
        startLoop();
      }
      return drawn;
    }

    function propertiesOf(anim) {
      var seen = {};
      try {
        var frames = anim.effect.getKeyframes();
        for (var i = 0; i < frames.length; i++) {
          for (var k in frames[i]) {
            if (k !== 'offset' && k !== 'computedOffset' && k !== 'easing' && k !== 'composite') seen[k] = true;
          }
        }
      } catch (err) { /* ignore */ }
      return Object.keys(seen).sort();
    }

    function union(a, b) {
      var seen = {};
      for (var i = 0; i < a.length; i++) seen[a[i]] = true;
      for (var j = 0; j < b.length; j++) seen[b[j]] = true;
      return Object.keys(seen).sort();
    }

    /** The class of the element an animation moves: 'ring' or 'glow'. */
    function classOf(anim) {
      try { return String(anim.effect.target.getAttribute('class')); } catch (err) { return ''; }
    }

    var handle = {
      mark: mark,
      /** The live rings, oldest first: kind, the box the ring is drawn at
       *  (the element's box outset), whether it is on screen, its computed
       *  border width (what proves the sheet applied under a strict CSP), and
       *  which properties its animation moves. */
      rings: function () {
        return state.rings.map(function (rec) {
          var border = '';
          try { border = win.getComputedStyle(rec.glow).borderTopWidth; } catch (err) { border = ''; }
          return {
            kind: rec.kind,
            box: rec.box,
            onScreen: rec.node.style.getPropertyValue('display') !== 'none',
            hidden: isHidden(),
            borderWidth: border,
            animates: union(rec.anim ? propertiesOf(rec.anim) : [], rec.glowAnim ? propertiesOf(rec.glowAnim) : []),
            // Which element moves what: the envelope on the outer element,
            // the glow on the inner one (see the top of this file).
            envelope: rec.anim ? { target: classOf(rec.anim), animates: propertiesOf(rec.anim) } : null,
            glow: rec.glowAnim ? { target: classOf(rec.glowAnim), animates: propertiesOf(rec.glowAnim) } : null,
          };
        });
      },
      /** Out of sight for a capture a model reads; the animations run on, so
       *  `restore` brings each back where its three seconds have got to. */
      hide: function (token) {
        var entries = hideEntries();
        entries[token === undefined ? 'handle:' + (++handleTokens) : String(token)] = Date.now() + HIDE_LAPSE_MS;
        applyHidden();
      },
      /** Undo one `hide` — by its token, or the latest one made here. The
       *  rings show again only when every capture that hid them has restored. */
      restore: function (token) {
        var entries = hideEntries();
        if (token !== undefined) delete entries[String(token)];
        else if (handleTokens > 0) delete entries['handle:' + (handleTokens--)];
        applyHidden();
      },
      /** Finish every animation; resolves once their rings, and the host, are
       *  gone. How a test ends rings without waiting on the clock (§5.4). */
      finishAll: function () {
        var anims = [];
        var live = state.rings.slice();
        for (var i = 0; i < live.length; i++) {
          var g = live[i].glowAnim;
          if (g) {
            try { g.finish(); } catch (err) { /* the envelope decides */ }
          }
          var a = live[i].anim;
          if (!a) continue;
          anims.push(a.finished.then(function () {}, function () {}));
          try { a.finish(); } catch (err) { retire(live[i]); }
        }
        return Promise.all(anims).then(function () {
          // Anything left (an animation that could not finish) goes now.
          var rest = state.rings.slice();
          for (var j = 0; j < rest.length; j++) retire(rest[j]);
        });
      },
    };
    host[KEY] = handle;
    return handle;
  }
})
