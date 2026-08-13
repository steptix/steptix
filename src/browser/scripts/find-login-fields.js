// Browser-side script used by findLoginFields (src/credentials/login-fields.ts).
//
// Loaded as a string by login-fields.ts and passed to page.evaluate, one frame
// at a time. Recognises the SHAPE of a login form rather than any particular
// site: no per-site selectors exist anywhere in this feature, and none should.
//
// Placeholder substitution:
//   __USERNAME_KEYWORDS__ → JSON array of lowercase keyword strings
//   __REJECT_KEYWORDS__   → JSON array of lowercase keyword strings
//   __OTP_KEYWORDS__      → JSON array of lowercase keyword strings
//   __SUBMIT_KEYWORDS__   → JSON array of lowercase keyword strings
//
// Returns a FrameScan (see login-fields.ts for the typed mirror). It reports
// what it SAW; it never decides whether to fill. That decision belongs to the
// broker, which also owns the domain rule.

(() => {
  var USERNAME_KEYWORDS = __USERNAME_KEYWORDS__;
  var REJECT_KEYWORDS = __REJECT_KEYWORDS__;
  var OTP_KEYWORDS = __OTP_KEYWORDS__;
  var SUBMIT_KEYWORDS = __SUBMIT_KEYWORDS__;

  function escAttr(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function idSelector(id) {
    if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) return '#' + id;
    return '[id="' + escAttr(id) + '"]';
  }

  // A selector that addresses this element without ancestor context. Same idea
  // as find-in-dom.js's strongSelector, minus the anchor-href arm (irrelevant
  // for form controls) and plus autocomplete, which on a login form is often
  // the only distinguishing attribute a field has.
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
    var autocomplete = el.getAttribute('autocomplete');
    if (autocomplete) return tag + '[autocomplete="' + escAttr(autocomplete) + '"]';
    return null;
  }

  // Walk up to a strong ancestor, collecting nth-of-type steps. Stops at a
  // shadow boundary and continues from the host: Playwright's CSS engine
  // pierces open shadow roots, so a descendant selector spanning the boundary
  // still resolves — but a `:nth-of-type` chain that walked THROUGH the
  // ShadowRoot node itself would not, because a ShadowRoot has no tagName.
  function stableSelector(el) {
    var direct = strongSelector(el);
    if (direct) return direct;
    var parts = [];
    var cur = el;
    var guard = 0;
    while (cur && guard++ < 50) {
      var parent = cur.parentElement;
      if (!parent) {
        var root = cur.getRootNode();
        if (root && root.host) {
          // Cross the boundary: the host's own selector prefixes the chain.
          var hostSel = strongSelector(root.host);
          if (hostSel) {
            parts.unshift(hostSel);
            return parts.join(' ');
          }
          cur = root.host;
          continue;
        }
        break;
      }
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
      if (parent === document.body || parent === document.documentElement) break;
      cur = parent;
    }
    parts.unshift('body');
    return parts.join(' > ');
  }

  // Every element in this frame, descending into OPEN shadow roots.
  //
  // Closed roots are unreachable by design and simply do not appear — a site
  // that closes its shadow root cannot be filled by us, and the broker reports
  // that honestly rather than pretending the page had no form.
  function collectAll(root, out, depth) {
    if (depth > 12) return;
    var els = root.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      out.push(el);
      if (el.shadowRoot) collectAll(el.shadowRoot, out, depth + 1);
    }
  }

  // Visible means a user could actually see and click it.
  //
  // This is the honeypot defence and it is load-bearing: bot traps are real
  // <input type="password"> elements that a naive `querySelector` finds first,
  // and filling one is a self-inflicted "you are a bot" verdict. Every clause
  // below corresponds to a way sites hide them.
  function isVisible(el) {
    if (el.hidden) return false;
    var style;
    try {
      style = getComputedStyle(el);
    } catch (e) {
      return false;
    }
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (parseFloat(style.opacity) === 0) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    // Positioned off-screen. Generous bounds: a field scrolled below the fold
    // is legitimately fillable, one parked at left:-9999px is not.
    if (rect.right < 0 || rect.bottom < 0) return false;
    if (rect.left > (window.innerWidth || 0) + 2000) return false;
    // An ancestor may be the thing doing the hiding.
    var p = el.parentElement;
    var guard = 0;
    while (p && guard++ < 30) {
      var ps;
      try {
        ps = getComputedStyle(p);
      } catch (e) {
        break;
      }
      if (!ps) break;
      if (ps.display === 'none' || ps.visibility === 'hidden') return false;
      if (parseFloat(ps.opacity) === 0) return false;
      if (p.getAttribute && p.getAttribute('aria-hidden') === 'true') return false;
      p = p.parentElement;
    }
    return true;
  }

  // The text a human would associate with this field: its own attributes plus
  // its <label>. Lowercased once, matched against keyword lists by callers.
  function fieldText(el) {
    var bits = [];
    var attrs = ['name', 'id', 'placeholder', 'aria-label', 'autocomplete', 'title', 'data-testid'];
    for (var i = 0; i < attrs.length; i++) {
      var v = el.getAttribute(attrs[i]);
      if (v) bits.push(v);
    }
    var id = el.getAttribute('id');
    if (id) {
      try {
        var labels = el.getRootNode().querySelectorAll('label[for="' + escAttr(id) + '"]');
        for (var j = 0; j < labels.length; j++) bits.push(labels[j].textContent || '');
      } catch (e) {
        // Malformed id in a selector — the other signals stand.
      }
    }
    if (el.labels) {
      for (var k = 0; k < el.labels.length; k++) bits.push(el.labels[k].textContent || '');
    }
    var wrapping = el.closest ? el.closest('label') : null;
    if (wrapping) bits.push(wrapping.textContent || '');
    return bits.join(' ').toLowerCase();
  }

  function hasAny(text, keywords) {
    for (var i = 0; i < keywords.length; i++) {
      if (text.indexOf(keywords[i]) !== -1) return true;
    }
    return false;
  }

  function describe(el, index) {
    return {
      selector: stableSelector(el),
      type: (el.getAttribute('type') || el.type || '').toLowerCase(),
      autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
      name: el.getAttribute('name') || '',
      id: el.getAttribute('id') || '',
      inShadow: !!(el.getRootNode() && el.getRootNode().host),
      index: index,
    };
  }

  try {
    var all = [];
    collectAll(document, all, 0);

    // Document order, with the index retained: "the username field is the one
    // BEFORE the password field" is a positional rule and needs it.
    var inputs = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag !== 'input') continue;
      var t = (el.getAttribute('type') || el.type || 'text').toLowerCase();
      if (t === 'hidden') continue;
      if (el.disabled || el.readOnly) continue;
      if (!isVisible(el)) continue;
      inputs.push({ el: el, type: t, index: inputs.length });
    }

    var passwords = [];
    var newPasswords = [];
    for (var p = 0; p < inputs.length; p++) {
      if (inputs[p].type !== 'password') continue;
      var ac = (inputs[p].el.getAttribute('autocomplete') || '').toLowerCase();
      // A sign-up or change-password form. Filling one of these with the
      // CURRENT password and submitting is the worst outcome this scanner can
      // cause, so `new-password` is excluded before anything else looks at it.
      if (ac.indexOf('new-password') !== -1) newPasswords.push(inputs[p]);
      else passwords.push(inputs[p]);
    }

    // Two live password boxes means "password" + "confirm password" — a
    // registration or change form wearing a login form's clothes. Decline
    // rather than guess which one is which.
    if (passwords.length > 1 || newPasswords.length > 0) {
      return {
        status: 'registration-form',
        password: null,
        username: null,
        otp: null,
        submit: null,
        visibleInputs: inputs.length,
        note:
          'This looks like a sign-up or change-password form (' +
          (passwords.length + newPasswords.length) +
          ' password fields' +
          (newPasswords.length ? ', one marked new-password' : '') +
          '), not a sign-in form.',
      };
    }

    var password = passwords.length === 1 ? passwords[0] : null;

    // Username: ranked, most trustworthy signal first. `autocomplete` is the
    // web platform's own answer to this question, so it outranks our guessing.
    var username = null;
    var usernameWhy = '';
    var candidates = [];
    for (var c = 0; c < inputs.length; c++) {
      var it = inputs[c];
      if (it.type === 'password') continue;
      if (it.type === 'checkbox' || it.type === 'radio' || it.type === 'submit' ||
          it.type === 'button' || it.type === 'file' || it.type === 'image') continue;
      candidates.push(it);
    }

    for (var a = 0; a < candidates.length && !username; a++) {
      var acu = (candidates[a].el.getAttribute('autocomplete') || '').toLowerCase();
      if (acu === 'username' || acu === 'email') {
        username = candidates[a];
        usernameWhy = 'autocomplete="' + acu + '"';
      }
    }
    if (!username) {
      for (var b = 0; b < candidates.length && !username; b++) {
        if (candidates[b].type === 'email') {
          username = candidates[b];
          usernameWhy = 'type="email"';
        }
      }
    }
    if (!username) {
      // Keyword scoring over the nearest text-ish field, preferring one that
      // sits BEFORE the password box in document order.
      var best = null;
      var bestScore = 0;
      for (var d = 0; d < candidates.length; d++) {
        var cand = candidates[d];
        if (cand.type !== 'text' && cand.type !== 'tel' && cand.type !== '') continue;
        var text = fieldText(cand.el);
        // A search box on a page that also has a login form is the classic
        // false positive; reject outright rather than let position win.
        if (hasAny(text, REJECT_KEYWORDS)) continue;
        var score = hasAny(text, USERNAME_KEYWORDS) ? 2 : 1;
        if (password && cand.index < password.index) score += 2;
        if (password && cand.index === password.index - 1) score += 1;
        if (score > bestScore) {
          bestScore = score;
          best = cand;
        }
      }
      if (best) {
        username = best;
        usernameWhy = bestScore >= 3 ? 'keyword and position' : 'position only';
      }
    }

    // One-time-code field. Its own status when it stands alone, because the
    // broker must not treat "type the TOTP" as "type the password".
    var otp = null;
    for (var o = 0; o < candidates.length && !otp; o++) {
      var aco = (candidates[o].el.getAttribute('autocomplete') || '').toLowerCase();
      var otext = fieldText(candidates[o].el);
      var maxLen = parseInt(candidates[o].el.getAttribute('maxlength') || '0', 10);
      if (aco.indexOf('one-time-code') !== -1) otp = candidates[o];
      else if (hasAny(otext, OTP_KEYWORDS)) otp = candidates[o];
      else if (maxLen > 0 && maxLen <= 8 && candidates[o].el.getAttribute('inputmode') === 'numeric') {
        otp = candidates[o];
      }
    }
    // A field cannot be both. When the only text input is the OTP box, it is
    // not also the username — otherwise a 2FA page reads as a username page
    // and the broker types an email address into the code box.
    if (otp && username && otp.el === username.el) {
      if (usernameWhy === 'position only' || usernameWhy === 'keyword and position') username = null;
      else otp = null;
    }

    // Submit control, scoped to the password (or username) field's own form
    // where there is one — a page with several forms otherwise hands back the
    // newsletter button.
    var anchor = password || username || otp;
    var submit = null;
    if (anchor) {
      var scope = anchor.el.closest ? anchor.el.closest('form') : null;
      var root = scope || document;
      var buttons = [];
      try {
        var found = root.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]');
        for (var q = 0; q < found.length; q++) buttons.push(found[q]);
      } catch (e) {
        // Nothing addressable; Enter will have to do.
      }
      for (var s = 0; s < buttons.length && !submit; s++) {
        if (!isVisible(buttons[s])) continue;
        var btype = (buttons[s].getAttribute('type') || '').toLowerCase();
        if (btype === 'submit') submit = buttons[s];
      }
      for (var s2 = 0; s2 < buttons.length && !submit; s2++) {
        if (!isVisible(buttons[s2])) continue;
        var label = ((buttons[s2].textContent || '') + ' ' +
          (buttons[s2].getAttribute('aria-label') || '') + ' ' +
          (buttons[s2].getAttribute('value') || '')).toLowerCase();
        if (hasAny(label, SUBMIT_KEYWORDS)) submit = buttons[s2];
      }
    }

    var status;
    if (password && username) status = 'login-form';
    else if (password && !username) status = 'password-only';
    else if (!password && otp) status = 'otp-only';
    else if (!password && username) status = 'username-only';
    else status = 'no-form';

    return {
      status: status,
      password: password ? describe(password.el, password.index) : null,
      username: username ? describe(username.el, username.index) : null,
      usernameWhy: usernameWhy,
      otp: otp ? describe(otp.el, otp.index) : null,
      submit: submit ? { selector: stableSelector(submit), text: (submit.textContent || '').trim().slice(0, 60) } : null,
      visibleInputs: inputs.length,
      note: '',
    };
  } catch (err) {
    return {
      status: 'scan-failed',
      password: null,
      username: null,
      otp: null,
      submit: null,
      visibleInputs: 0,
      note: String(err),
    };
  }
})()
