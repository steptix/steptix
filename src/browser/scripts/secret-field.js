// ── "Is this a secret field?" — the ONE copy ─────────────────────────────
//
// A FRAGMENT, not a script: plain `var` and `function` declarations with no
// wrapper, spliced into three page scripts before they are evaluated —
//
//   capture-dom.js     the whole-page snapshot, where the placeholder
//                      __SECRET_FIELD_RULE__ stands
//   dom-cleaner.ts     the `expand` walk (expandDomSubtree), interpolated into
//                      its template literal
//   record-steps.js    the step recorder (stories/testbench-record-steps.md,
//                      decision 7), same placeholder as capture-dom.js
//
// It used to be copied into the first two by hand, each copy with a comment
// saying "keep the others in step". A third copy for the recorder would have
// been the one that drifted — and the recorder is the copy where a miss sends
// a typed password over a binding instead of printing `***` in a snapshot. So
// the rule lives here, and `loadSecretFieldRule()` (dom-cleaner.ts) is how every
// consumer gets it. tests/secret-field-parity.test.ts asks all three the same
// questions.
//
// Nothing in here may reference a name the consumers do not all define, and no
// `__TOKEN__` placeholder may appear in it: it is substituted INTO templates
// that are themselves substituted afterwards.
//
// `type` alone cannot answer the question. The "show password" eye on most
// sign-in forms flips the field to `type="text"`, and a guard that reads the
// CURRENT type then hands the typed password straight to the snapshot — one
// click after it correctly withheld it. So the question is asked of the things
// a toggle cannot move: how the field describes itself to a password manager
// (`autocomplete`) and what it is NAMED.
//
// A WeakSet of every element ever seen as `type=password` would be the exact
// answer, but each capture is its own `evaluate()` call with its own scope —
// there is nowhere to keep one across captures. The recorder is the exception:
// its script lives as long as the document, so it keeps that WeakSet ON TOP of
// this rule (record-steps.js, "Secrets, remembered for the life of the
// document") — this rule decides what is secret, the memory only ever adds.
//
// The name rule mirrors `isSecretName` in src/utils/secrets.ts (defined in
// src/parser/parameters.ts): /password|secret|token|key/i. This fragment is
// stringified into the page and cannot import it, so it is copied — keep the
// two in step. It over-matches on purpose, exactly as the framework's does: a
// field named `keywords` loses its live value from the snapshot, which costs
// the model one attribute and cannot leak anything.
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
// own parameters (src/parser/types.ts) and not this fragment, which is
// evaluated in the page with no config input. An author whose app names a
// filter `keyword` cannot un-withhold it here.
function isSecretField(el) {
  if (String(el.getAttribute('type') || '').toLowerCase() === 'password') return true;
  // Explicit, ahead of the name sweep below: this is what a field named
  // only by a sibling <label> still tells a password manager.
  var autocomplete = String(el.getAttribute('autocomplete') || '').toLowerCase();
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
