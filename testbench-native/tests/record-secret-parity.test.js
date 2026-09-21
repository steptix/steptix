/**
 * What counts as a secret is decided in three places, by three rules, and they
 * must decide it identically (docs/specs/SPEC-structured-table-reads.md §7.6).
 *
 * The three rules are one per kind of NAME, not per surface: the flat author
 * rule on a whole key (`isSecretName`, and the server's `redactAuthoredMap`
 * over a data row's cells and a step's `[store as:]` outputs), the narrow
 * record-column rule on a page-derived key (`isRecordSecretKey`), and the
 * two-segment composition of the two that the live variable map takes
 * (`isSecretParameterName`, and `redactMap`) — which has a third arm of its
 * own, the whole dotted name read as one credential key.
 *
 * The FLAT rule — an author-chosen name — is the server's `isSecretName`
 * (src/parser/parameters.ts): a substring, `password|secret|token|key`. The
 * two client mirrors carry the same literal, and this file compares all three
 * because a mirror that is merely *similar* is the bug it was meant to fix:
 * word boundaries here once let `mypassword`, `newpassword` and `apitoken`
 * render in the Variables view while every report starred them, and turned
 * `pwd` and `user_otp` into `********` in a view sitting beside a report that
 * prints them. `keyword` masking on both sides is the accepted price.
 * (A third client copy lived in env-data-completion-core.ts; it now calls
 * runner-core's `isSecretFlatName`, so there is one flat rule on the client.)
 *
 * The RECORD-COLUMN rule is the narrow one, and the rest of this file is
 * about it.
 *
 * The server's `isRecordSecretKey` (src/utils/secrets.ts) is the original: it
 * builds the mask set a report, a run log and a console line are redacted
 * against. The other two are mirrors, and they exist because neither side can
 * import that file — runner-core is a client package that must not pull in the
 * server tree, and the webview bundle imports nothing from runner-core at all
 * (CJS interop with Vite's named-export tracking). So `repl.ts` carries the
 * rule for the Variables TreeView and `variables-panel.js` carries it for the
 * panel.
 *
 * The drift is silent in the worst direction. `frame:scope` carries RAW values
 * by design — the wire was left alone when redaction shipped, and the client
 * is what hides them; what the wire DOES now carry is the two things the rules
 * cannot work out from a name alone, `bindings` and `unmask` (`SCOPE_CORPUS`
 * below) — so a mirror that forgets a word shows a password the
 * report redacts, in a view sitting next to the report. A mirror that gains
 * one masks a column the report prints, and `********` is a row nobody can
 * read. Neither failure announces itself; this test does.
 *
 * Same shape as `placeholder-grammar-parity.test.js`: read the original's
 * source text, because that is the only thing available across the boundary,
 * and fail loudly with the line it could not read if someone reformats it.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  RECORD_SECRET_PATTERNS,
  SECRET_NAME_PATTERN,
  isRecordSecretKey,
  isSecretFlatName,
  isSecretVarName,
  maskIfSecret,
  maskIfSecretAuthored,
  maskRecordSecrets,
  // From runner-core's SOURCE, not from `ai-ui-automation-runner-core`. That
  // specifier resolves to runner-core/dist, which `npm test` never builds — so
  // every behavioural corpus below was answering about a compiled copy of
  // whatever the rule used to be. Measured: deleting
  // `|| wholeNameIsRecordSecret(varName)` from `isSecretVarName` in
  // runner-core/src/repl.ts and running this file left it 12/12 green.
  // Node (>= 22.18) strips the types on import, and repl.ts uses no TS-only
  // runtime syntax, so the source loads as-is.
} from '../../runner-core/src/repl.ts';
import {
  RECORD_SECRET_PATTERNS as PANEL_PATTERNS,
  SECRET_NAME_PATTERN as PANEL_SECRET_NAME,
  isRecordSecretKeyInline,
  isSecretFlatNameInline,
  isSecretVarNameInline,
  maskIfSecretAuthoredInline,
  maskIfSecretInline,
  maskRecordSecretsInline,
} from '../src/webview/lib/variables-panel.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_SOURCE_FILE = resolve(here, '..', '..', 'src', 'utils', 'secrets.ts');
const PARAMETERS_SOURCE_FILE = resolve(here, '..', '..', 'src', 'parser', 'parameters.ts');
const CORE_SOURCE_FILE = resolve(here, '..', '..', 'runner-core', 'src', 'repl.ts');
const PANEL_SOURCE_FILE = resolve(here, '..', 'src', 'webview', 'lib', 'variables-panel.js');

const serverSource = readFileSync(SERVER_SOURCE_FILE, 'utf8');
const parametersSource = readFileSync(PARAMETERS_SOURCE_FILE, 'utf8');
const coreSource = readFileSync(CORE_SOURCE_FILE, 'utf8');
const panelSource = readFileSync(PANEL_SOURCE_FILE, 'utf8');

/** The literal of a `const <name> = /…/<flags>;` line, as `{source, flags}`.
 *  Every file spells these on one line; anything else is a reformat this
 *  reader is entitled to fail on.
 *
 *  Flags are read, not assumed: `SECRET_NAME` carries `/i` and would not
 *  match a reader that stopped at the closing slash, and dropping that `i` is
 *  a real drift (`MACHINE_KEY` stops masking). */
function regexLiteralSource(source, name, file) {
  const hit = new RegExp(`const ${name} = /(.*)/([a-z]*);`).exec(source);
  assert.ok(
    hit,
    `could not read \`const ${name} = /…/;\` out of ${file} — if that line was ` +
      'reformatted, update this reader; if the pattern was renamed or removed, ' +
      'every mirror listed at the top of this file needs the same change',
  );
  return { source: hit[1], flags: hit[2] };
}

/** The literal `isSecretName` tests with, as {source, flags}. It is spelled
 *  inline in a `return`, not as a named const, so it gets its own reader. */
function secretNameLiteral() {
  const hit = /function isSecretName\([^)]*\)[^{]*\{\s*return \/(.*)\/([a-z]*)\.test\(/.exec(
    parametersSource,
  );
  assert.ok(
    hit,
    'could not read the regex literal out of `isSecretName` in src/parser/parameters.ts — ' +
      'if that function was reformatted, update this reader; if the rule moved or changed, ' +
      'both client mirrors (runner-core/src/repl.ts `SECRET_NAME`, ' +
      'testbench-native/src/webview/lib/variables-panel.js `SECRET_NAME`) need the same change',
  );
  return { source: hit[1], flags: hit[2] };
}

test('the flat, author-chosen name rule is the server\'s, character for character', () => {
  const literal = secretNameLiteral();

  // Sanity: the reader found the pattern, not an empty match off a comment.
  assert.ok(literal.source.includes('password'), literal.source);
  assert.equal(literal.flags, 'i', 'case-insensitive, or MACHINE_KEY would not match');

  // runner-core's literal is read out of its SOURCE TEXT as well as compared
  // through the imported object. Both now come from the same file — the import
  // at the top is `../../runner-core/src/repl.ts`, not the package specifier
  // that resolves to an unbuilt `dist/` — so this is the belt to that braces:
  // it names the file and the const in its failure message, and it fails
  // loudly rather than silently if either is renamed or reformatted away.
  const core = regexLiteralSource(coreSource, 'SECRET_NAME', 'runner-core/src/repl.ts');
  assert.equal(core.source, literal.source, 'runner-core flat pattern (source)');
  assert.equal(core.flags, literal.flags, 'runner-core flat flags (source)');

  assert.equal(SECRET_NAME_PATTERN.source, literal.source, 'runner-core flat pattern');
  assert.equal(SECRET_NAME_PATTERN.flags, literal.flags, 'runner-core flat flags');
  assert.equal(PANEL_SECRET_NAME.source, literal.source, 'variables-panel flat pattern');
  assert.equal(PANEL_SECRET_NAME.flags, literal.flags, 'variables-panel flat flags');
});

/** The names the flat rule has been wrong about, in both directions. A
 *  substring rule answers all of them; a word-boundary one answered none. */
const FLAT_CORPUS = [
  ['password', true],
  ['mypassword', true],
  ['newpassword', true],
  ['password2', true],
  ['mytoken', true],
  ['apitoken', true],
  ['mysecret', true],
  ['secret1', true],
  ['MACHINE_KEY', true],
  ['privateKey', true],
  ['apikey', true],
  ['sort_key', true],
  // The accepted cost of the server's breadth: masked here because masked in
  // the report. As a record COLUMN both are readable — the corpus below.
  ['keyword', true],
  ['monkey', true],
  // Column words that the flat rule does not know, because the server's
  // doesn't either: a flat `pwd` is printed by the report and the run log.
  ['pwd', false],
  ['user_otp', false],
  ['credential', false],
  ['username', false],
  ['payee', false],
];

test('both client mirrors answer the flat corpus the way the server would', () => {
  const server = new RegExp(secretNameLiteral().source, secretNameLiteral().flags);
  for (const [name, expected] of FLAT_CORPUS) {
    assert.equal(server.test(name), expected, `the server's own rule on ${name}`);
    assert.equal(isSecretFlatName(name), expected, `runner-core on ${name}`);
    assert.equal(isSecretFlatNameInline(name), expected, `variables-panel on ${name}`);
  }
});

test('the record-column patterns are the server\'s, character for character', () => {
  const word = regexLiteralSource(serverSource, 'RECORD_SECRET_WORD', 'src/utils/secrets.ts').source;
  const key = regexLiteralSource(serverSource, 'RECORD_SECRET_KEY', 'src/utils/secrets.ts').source;

  // Sanity: the reader found patterns, not an empty match off a comment.
  assert.ok(word.includes('password'), word);
  assert.ok(key.includes('_keys?'), key);

  // From runner-core's SOURCE TEXT as well, for the same reason the flat rule
  // is: a named reader that says which file and which const it could not find.
  for (const [name, expected] of [['RECORD_SECRET_WORD', word], ['RECORD_SECRET_KEY', key]]) {
    const literal = regexLiteralSource(coreSource, name, 'runner-core/src/repl.ts');
    assert.equal(literal.source, expected, `runner-core ${name} (source)`);
    assert.equal(literal.flags, '', `runner-core ${name} flags (source)`);
  }

  assert.equal(RECORD_SECRET_PATTERNS.word.source, word, 'runner-core word pattern');
  assert.equal(RECORD_SECRET_PATTERNS.key.source, key, 'runner-core key pattern');
  assert.equal(PANEL_PATTERNS.word.source, word, 'variables-panel word pattern');
  assert.equal(PANEL_PATTERNS.key.source, key, 'variables-panel key pattern');

  // Unflagged: a `/g` regex carries `lastIndex` between `.test()` calls and
  // would answer about the previous key every other time it was asked.
  for (const pattern of [
    RECORD_SECRET_PATTERNS.word,
    RECORD_SECRET_PATTERNS.key,
    PANEL_PATTERNS.word,
    PANEL_PATTERNS.key,
  ]) {
    assert.equal(pattern.flags, '', String(pattern));
  }
});

/** A function's body with comments stripped and whitespace collapsed. */
function normalizedBody(source, name, file) {
  const hit = new RegExp(`function ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  assert.ok(hit, `could not read the body of ${name} out of ${file}`);
  return hit[1]
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

test('…and so is the normalisation that feeds them', () => {
  // The patterns read words separated by `_`, so what turns a key into words
  // is half the rule: `apiKey` is a secret column only because the camelCase
  // hump becomes one. A mirror that dropped that replace would keep both
  // regexes and still answer differently.
  assert.equal(
    normalizedBody(coreSource, 'isRecordSecretKey', 'runner-core/src/repl.ts'),
    normalizedBody(serverSource, 'isRecordSecretKey', 'src/utils/secrets.ts'),
    'runner-core\'s isRecordSecretKey is no longer the server\'s, line for line',
  );
});

/** The corpus of `tests/secrets.test.ts` (the server's own), plus the columns
 *  review named: both mirrors are asked the same questions the original is. */
const CORPUS = [
  ['password', true],
  ['user_password', true],
  ['passwd', true],
  ['pwd', true],
  ['Token', true],
  ['secret', true],
  ['otp', true],
  ['credential', true],
  ['credentials', true],
  ['api_key', true],
  ['apiKey', true],
  ['access_key', true],
  ['private-key', true],
  ['auth_key', true],
  ['signing_key', true],
  ['encryption_keys', true],
  // `key` with nothing to make it a credential is far more often a sort key
  // or an id, and masking it would replace that value everywhere — including
  // in the DOM snapshot the model plans its next action from.
  ['key', false],
  ['keys', false],
  ['sort_key', false],
  ['sortKey', false],
  ['keyword', false],
  ['monkey', false],
  ['customer', false],
  // One word, no boundary: `apikey` is not a secret COLUMN. (As a name the
  // author chose it still masks — a different rule, `isSecretVarName`.)
  ['apikey', false],
  ['_row', false],
  ['payee', false],
];

test('both mirrors answer the corpus the same way', () => {
  for (const [key, expected] of CORPUS) {
    assert.equal(isRecordSecretKey(key), expected, `runner-core on ${key}`);
    assert.equal(isRecordSecretKeyInline(key), expected, `variables-panel on ${key}`);
  }
});

// ---------------------------------------------------------------------------
// The third clause: the whole dotted name read as one credential key
// ---------------------------------------------------------------------------
//
// `isSecretParameterName` (src/utils/secrets.ts) has three arms, not two: the
// root by the author rule, the property by the record rule, and the WHOLE name
// with the dots read as separators — because not every dotted name is a pass
// binding. A data column or a `[store as:]` output may be called `api.key`,
// where neither half says secret and the two halves together say nothing but.
// Both client mirrors stopped at two arms, so `api.key` and `private.key`
// rendered in full in a view sitting beside a report that said `***`.

test('the whole-name clause is one implementation in three spellings', () => {
  const server = normalizedBody(serverSource, 'wholeNameIsRecordSecret', 'src/utils/secrets.ts');
  assert.ok(server.includes('isRecordSecretKey'), `server body looks wrong: ${server}`);
  assert.equal(
    normalizedBody(coreSource, 'wholeNameIsRecordSecret', 'runner-core/src/repl.ts'),
    server,
    'runner-core\'s wholeNameIsRecordSecret is no longer the server\'s, line for line',
  );
  assert.equal(
    mirrorBody(panelSource, 'wholeNameIsRecordSecretInline', PANEL_SOURCE_FILE),
    mirrorBody(coreSource, 'wholeNameIsRecordSecret', CORE_SOURCE_FILE),
    'the panel\'s copy is no longer runner-core\'s, line for line',
  );
});

/** Dotted names the whole-name clause is the only arm that answers, plus the
 *  ones it must keep its hands off. A two-arm mirror answers the first group
 *  `false` and agrees about the second.
 *
 *  This corpus is the NO-BINDINGS form — `isSecretVarName(name)` with nothing
 *  said about whose the name is, which is what an older server's `frame:scope`
 *  still produces and therefore what the client must keep answering. The
 *  server's `isSecretParameterName` asks `isLoopBinding(map, name)` instead,
 *  and that registry is keyed on the live map's object identity, so a copy
 *  sent over HTTP arrives knowing nothing. `FrameScopeEvent.bindings` is that
 *  registry as data; the corpus below this one is the same question ASKED WITH
 *  it, and it is where `user.apikey` changes its answer. */
const DOTTED_CORPUS = [
  ['api.key', true],
  ['private.key', true],
  ['service.access.key', true],
  ['auth.keys', true],
  ['signing.key', true],
  // The record rule is what reads the joined name, so it stays whole-word.
  ['row.keyword', false],
  ['payment.sort_key', false],
  ['order.monkey', false],
  ['payment.payee', false],
  // Still decided by their own halves, clause or no clause.
  ['payment.password', true],
  ['token.payee', true],
  // Asked with nothing said about whose the name is, all three arms answer
  // no: `user` is not flat-secret, `apikey` is one word so it is not a secret
  // COLUMN, and `user_apikey` is not one either. That was the whole answer
  // until `bindings` reached the wire, and against an older server it still
  // is — the server's own `isSecretParameterName(name, map)` falls back to
  // the FLAT author rule for a dotted entry NO PASS BOUND, which sees `key`
  // and stars it. Asked WITH the list, both mirrors now agree with it; see
  // `SCOPE_CORPUS` below.
  ['user.apikey', false],
];

test('both mirrors answer the dotted corpus the way the server would', () => {
  for (const [name, expected] of DOTTED_CORPUS) {
    assert.equal(isSecretVarName(name), expected, `runner-core on ${name}`);
    assert.equal(isSecretVarNameInline(name), expected, `variables-panel on ${name}`);
  }
});

// ---------------------------------------------------------------------------
// The SCOPE rule, asked with what `frame:scope` now says about its own map
// ---------------------------------------------------------------------------
//
// `FrameScopeEvent.bindings` names the dotted entries a `For each` pass bound
// and `FrameScopeEvent.unmask` the names the test's `## Config: unmask:`
// declares are not secrets. With them, `maskIfSecret` is the server's
// `isSecretParameterName(name, map)` plus `formatParameterBlock`'s hatch,
// rather than an approximation that answered every dotted name the narrow way
// and starred every unmasked one.
//
// Two implementations again — runner-core for the Variables TreeView, the
// panel's inline copy for the webview — so the corpus is asked of both. A body
// comparison would not do it here: the panel's `maskIfSecretInline` carries a
// falsy-value guard runner-core's `maskValue` handles inside itself, so the
// two are deliberately not line for line and only the ANSWERS can be compared.

/** `[what, name, opts, masked]` — `masked` is whether the entry must be
 *  hidden. `opts` is exactly what the wire delivered, `undefined` standing for
 *  an older server that delivered nothing. */
const SCOPE_CORPUS = [
  // The leak the wire closes. `[]` is a real answer, and the one a test with
  // no `For each` in it sends.
  ['a data-file heading, with the run saying it bound nothing', 'user.apikey', { bindings: [] }, true],
  ['…and a passkey heading beside it', 'login.passkey', { bindings: [] }, true],
  ['…the whole key goes to the flat rule, so `keyword` masks', 'payment.keyword', { bindings: [] }, true],
  ['…and so does `sort_key`', 'payment.sort_key', { bindings: [] }, true],
  // A name a pass DID bind keeps the two-segment rule, which is what keeps a
  // page's `keyword` column readable in the view beside a report that prints it.
  ['a bound column takes the record rule', 'payment.keyword', { bindings: ['payment.keyword'] }, false],
  ['…and a bound `sort_key` too', 'payment.sort_key', { bindings: ['payment.sort_key'] }, false],
  ['…while a bound credential column is still hidden', 'payment.password', { bindings: ['payment.password'] }, true],
  // Both kinds in one map — the case no rule could answer from the names.
  ['a binding and a heading, same event, decided apart (binding)', 'payment.keyword', { bindings: ['payment.keyword'] }, false],
  ['a binding and a heading, same event, decided apart (heading)', 'user.apikey', { bindings: ['payment.keyword'] }, true],
  // Absent is not empty: an older server said nothing, and the safe reading of
  // a scope full of real bindings is the narrow one.
  ['an older server: nothing known, so nothing changes', 'user.apikey', undefined, false],
  ['…and a real binding is not masked on its say-so', 'payment.keyword', undefined, false],
  ['an empty opts object means the same as no opts', 'user.apikey', {}, false],
  // A flat name never consults the list, on either side.
  ['a flat name ignores an empty list', 'keyword', { bindings: [] }, true],
  ['…and ignores a list it is in', 'payee', { bindings: ['payee'] }, false],
  // The hatch.
  ['an unmasked flat name is shown', 'keyword', { unmask: ['keyword'] }, false],
  ['…matched exactly, so it says nothing about another name', 'password', { unmask: ['keyword'] }, true],
  ['an unmasked bound column is shown', 'payment.password', { bindings: ['payment.password'], unmask: ['payment.password'] }, false],
  ['an unmasked heading is shown', 'user.apikey', { bindings: [], unmask: ['user.apikey'] }, false],
  ['an empty unmask list changes nothing', 'keyword', { unmask: [] }, true],
  // Both fields together, which is the payload of a real unmasking run.
  ['bindings and unmask together, on a name in neither', 'payment.password', { bindings: ['payment.password'], unmask: ['keyword'] }, true],
];

test('both scope-rule mirrors answer the bindings/unmask corpus identically', () => {
  const value = 'uk_live_1234';
  const masked = '*'.repeat(8);
  for (const [what, name, opts, expected] of SCOPE_CORPUS) {
    const want = expected ? masked : value;
    // `opts === undefined` is called with ONE argument short, not with
    // `undefined` passed in: that is how an older server's event reaches a
    // call site that has nothing to hand over, and a default parameter is
    // what makes the two the same. Asserted both ways for that reason.
    assert.equal(
      opts === undefined ? maskIfSecret(name, value) : maskIfSecret(name, value, opts),
      want,
      `runner-core: ${what} (${name})`,
    );
    assert.equal(
      opts === undefined ? maskIfSecretInline(name, value) : maskIfSecretInline(name, value, opts),
      want,
      `variables-panel: ${what} (${name})`,
    );
  }
});

test('both scope-rule mirrors exempt an unmasked name from the RECORD scan too', () => {
  // The server's `formatParameterBlock` returns an unmasked entry verbatim —
  // no record scan, no free-text masking — because masking a declared
  // non-secret by its shape would take the hatch away through another door.
  const capture = JSON.stringify([{ payee: 'Alinta', password: 'hunter2-not-real' }]);
  assert.equal(maskIfSecret('payments', capture, { unmask: ['payments'] }), capture);
  assert.equal(maskIfSecretInline('payments', capture, { unmask: ['payments'] }), capture);
  // …and without the hatch both still lose the column, so the test above is
  // about the hatch rather than about a value nothing would have masked.
  for (const shown of [maskIfSecret('payments', capture), maskIfSecretInline('payments', capture)]) {
    assert.ok(!shown.includes('hunter2-not-real'), shown);
  }
});

test('both scope-rule mirrors take a Set as readily as an array', () => {
  // The wire hands over arrays; a surface holding one for a whole run would
  // rather hold a Set. Both spellings, both mirrors.
  for (const make of [(xs) => xs, (xs) => new Set(xs)]) {
    const opts = { bindings: make(['payment.keyword']), unmask: make(['keyword']) };
    assert.equal(maskIfSecret('payment.keyword', 'AU', opts), 'AU');
    assert.equal(maskIfSecretInline('payment.keyword', 'AU', opts), 'AU');
    assert.equal(maskIfSecret('user.apikey', 'uk_live_1234', opts), '*'.repeat(8));
    assert.equal(maskIfSecretInline('user.apikey', 'uk_live_1234', opts), '*'.repeat(8));
    assert.equal(maskIfSecret('keyword', 'search', opts), 'search');
    assert.equal(maskIfSecretInline('keyword', 'search', opts), 'search');
  }
});

/** Every surface that renders a SCOPE entry, and the call that must carry the
 *  run's `bindings` / `unmask` into it. A source scan, like
 *  `AUTHORED_CALL_SITES` above and for the same reason: one is a React
 *  closure and the other needs the extension host, so neither is reachable
 *  from `node --test`. A surface that drops the third argument compiles, runs,
 *  and quietly answers the pre-wire way — which is the whole failure this
 *  change exists to end. */
const SCOPE_CALL_SITES = [
  [
    resolve(here, '..', 'src', 'extension', 'variables-view.ts'),
    /maskIfSecret\(node\.name, node\.rawValue, node\.masking\)/,
    'the Variables TreeView row',
  ],
  [
    resolve(here, '..', 'src', 'webview', 'testbench-runner.jsx'),
    /maskIfSecretInline\(row\.name, row\.value, runtimeMasking\)/,
    "the webview Variables panel's rows",
  ],
  [
    resolve(here, '..', 'src', 'webview', 'testbench-runner.jsx'),
    /maskIfSecretInline\(name, value, runtimeMasking\)/,
    'the skill re-run panel, whose rows are scope entries too',
  ],
];

test('the scope surfaces pass the run’s bindings and unmask to the masker', () => {
  for (const [file, pattern, what] of SCOPE_CALL_SITES) {
    assert.match(readFileSync(file, 'utf8'), pattern, `${what} (${file})`);
  }
});

// ---------------------------------------------------------------------------
// The AUTHORED map rule — the server's `redactAuthoredMap`
// ---------------------------------------------------------------------------
//
// A third map rule, for keys that are author-chosen END TO END: a data row's
// cells (src/report/merge-rows.ts) and a step's `[store as:]` outputs
// (src/codebehind/recording.ts). `redactMap`'s two-segment rule is the live
// variable map's, whose dotted entries are a loop's `row.<column>` bindings.
// It is wrong here, and the client applied it to both — so a data column
// headed `user.apikey` showed `uk_live_1234` in the Run Rows pick, the gutter
// hover and the Output banner while the report matrix beside them said `***`.
// The pre-feature client starred it, which makes this a regression.

/** One exported map-redactor's body, out of the server's source. Read rather
 *  than assumed: which predicate each one hands `maskMapBy` is the whole
 *  difference between them, and it is what both client mirrors copy. */
function mapRedactorBody(name) {
  const hit = new RegExp(`export function ${name}\\(([\\s\\S]*?)\\n\\}`).exec(serverSource);
  assert.ok(
    hit,
    `could not read \`${name}\` out of src/utils/secrets.ts — if it was reformatted ` +
      '(a brace left at a column other than 0), update this reader; if it now uses a ' +
      'different rule, the client mirrors (runner-core `maskIfSecretAuthored` / ' +
      '`maskIfSecret`, and the variables-panel copies) need the same change',
  );
  return hit[1];
}

test('the authored-map rule is the FLAT author rule, on the whole key', () => {
  const authored = mapRedactorBody('redactAuthoredMap');
  assert.match(authored, /maskMapBy\([^)]*\bisSecretName\b/, 'redactAuthoredMap');
  // Not the two-segment rule: that is `redactMap`'s, and the difference
  // between them is this whole section. Asserted by NAME rather than by the
  // exact call text — the server may pass it a map or wrap it in an arrow —
  // because what the mirrors copy is which rule, not how it is spelled.
  assert.doesNotMatch(authored, /isSecretParameterName/, 'redactAuthoredMap');
  assert.match(
    mapRedactorBody('redactMap'),
    /isSecretParameterName/,
    'redactMap is expected to keep the two-segment rule',
  );
});

/** Author-chosen keys, dots included, with what the server's
 *  `redactAuthoredMap` does to them. The first five are the measured
 *  regression; the rest are what the flat rule has always said. */
const AUTHORED_CORPUS = [
  ['user.apikey', true],
  ['user.apitoken', true],
  ['row.mypassword', true],
  ['login.passkey', true],
  ['api.key', true],
  ['password', true],
  ['MACHINE_KEY', true],
  // The accepted cost of the author rule's breadth, the same on every surface.
  ['keyword', true],
  ['payment.keyword', true],
  ['payment.sort_key', true],
  ['user.email', false],
  ['payment.payee', false],
  ['username', false],
  ['_row', false],
];

test('both authored-rule mirrors answer the corpus the way the server would', () => {
  const server = new RegExp(secretNameLiteral().source, secretNameLiteral().flags);
  for (const [name, expected] of AUTHORED_CORPUS) {
    assert.equal(server.test(name), expected, `the server's own rule on ${name}`);
    const value = 'uk_live_1234';
    const masked = '*'.repeat(8);
    assert.equal(
      maskIfSecretAuthored(name, value),
      expected ? masked : value,
      `runner-core on ${name}`,
    );
    assert.equal(
      maskIfSecretAuthoredInline(name, value),
      expected ? masked : value,
      `variables-panel on ${name}`,
    );
  }
});

/** Every surface that renders an AUTHOR-chosen map, and the masker it must
 *  use. Neither call site is reachable from `node --test` — one is a React
 *  closure, the other needs the extension host — so this is a source scan, the
 *  same shape `skipped-pass-consumers.test.js` uses for the same reason. */
const AUTHORED_CALL_SITES = [
  [
    resolve(here, '..', 'src', 'webview', 'testbench-runner.jsx'),
    /maskIfSecretAuthoredInline\(event\.name, event\.value\)/,
    'the capture banner (`✎ name ← value`)',
  ],
  [
    resolve(here, '..', 'src', 'extension', 'row-selection-core.ts'),
    /maskIfSecretAuthored\(k, v\)/,
    'rowValuesText — the Run Rows pick, the gutter hover and the Output banner',
  ],
  [
    // `[input: name]` is written in the test file, so the name is the
    // author's the same way a `[store as:]` output or a column heading is.
    // The two maskers cannot disagree about it TODAY — `INPUT_STEP_RE`
    // (src/parser/markdown.ts) matches `\w*`, and they differ only on a
    // dotted name — so this is the rule being stated where it is true rather
    // than a bug being fixed. It is here because the day that grammar widens,
    // nothing else would notice.
    resolve(here, '..', 'src', 'extension', 'run-controller.ts'),
    /maskIfSecretAuthored\(item\.varName, answer\)/,
    'the `[input:]` echo (`✎ name ← value`)',
  ],
];

test('the author-chosen surfaces call the authored masker, not the scope one', () => {
  for (const [file, pattern, what] of AUTHORED_CALL_SITES) {
    assert.match(readFileSync(file, 'utf8'), pattern, `${what} (${file})`);
  }
});

// ---------------------------------------------------------------------------
// The masking itself, not just the rule it consults
// ---------------------------------------------------------------------------
//
// Knowing which KEY is a secret is half of it. `maskRecordSecrets`
// (runner-core) and `maskRecordSecretsInline` (the panel) are what a captured
// table is rendered through, and they had drifted in a way no test asked
// about — which JSON types mask, whether a value nothing changed comes back
// byte for byte. Two checks: the bodies, and the answers.

/**
 * A function body normalised down to what the two languages share.
 *
 * Every rule below erases a TypeScript-vs-JavaScript SPELLING and nothing
 * else: comments, the panel's `Inline` suffix on its own helpers, a `let`/
 * `const` type annotation, the two files' quote styles, and all whitespace —
 * dropped outright rather than collapsed, so `let parsed: unknown;` and
 * `let parsed;` land in the same place. Anything the compiler would call a
 * different program survives and fails the comparison.
 */
function mirrorBody(source, name, file) {
  const hit = new RegExp(`function ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  assert.ok(
    hit,
    `could not read the body of ${name} out of ${file} — if it was reformatted (a brace ` +
      'left at a column other than 0, a parameter list broken over lines), update this reader',
  );
  return hit[1]
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/Inline\b/g, '')
    .replace(/\b(let|const) (\w+)\s*:[^=;]+([=;])/g, '$1 $2$3')
    .replace(/"/g, "'")
    .replace(/\s+/g, '')
    .trim();
}

test('the two record-masking bodies are one implementation in two spellings', () => {
  for (const [core, panel] of [
    ['maskRecordSecrets', 'maskRecordSecretsInline'],
    ['isPlainRecord', 'isPlainRecordInline'],
  ]) {
    const left = mirrorBody(coreSource, core, 'runner-core/src/repl.ts');
    assert.ok(left.length > 20, `${core} body looks empty: ${left}`);
    assert.equal(
      left,
      mirrorBody(panelSource, panel, 'testbench-native/src/webview/lib/variables-panel.js'),
      `${panel} is no longer ${core}, line for line`,
    );
  }
});

/** One corpus, both implementations. `expect` is the exact string each must
 *  return — identity included, because a value nothing was masked in must
 *  come back character for character rather than re-stringified. */
const MASK_CORPUS = [
  [
    'a list of records loses its secret columns',
    JSON.stringify([
      { _row: '1', payee: 'Origin Energy', password: 'hunter2-not-real' },
      { _row: '2', payee: 'Alinta', password: 'swordfish' },
    ]),
    JSON.stringify([
      { _row: '1', payee: 'Origin Energy', password: '********' },
      { _row: '2', payee: 'Alinta', password: '********' },
    ]),
  ],
  [
    'one record masks the same way',
    JSON.stringify({ payee: 'Alinta', api_key: 'pk-live-1' }),
    JSON.stringify({ payee: 'Alinta', api_key: '********' }),
  ],
  [
    'the narrow rule decides: a readable column stays readable',
    JSON.stringify([{ sort_key: 'abc', keyword: 'search', key: 'K-1' }]),
    JSON.stringify([{ sort_key: 'abc', keyword: 'search', key: 'K-1' }]),
  ],
  ['a list of strings is not a list of records', '["password", "token"]', '["password", "token"]'],
  ['a number is not a record', '42', '42'],
  ['a null cell says there is no value, so it keeps saying it', '[{"password":null}]', '[{"password":null}]'],
  [
    'a nested object under a secret key is left for the report to match',
    '[{"password":{"pin":"1234"}}]',
    '[{"password":{"pin":"1234"}}]',
  ],
  [
    'a pretty-printed value nothing masked comes back byte for byte',
    '[\n  { "payee": "Alinta" }\n]',
    '[\n  { "payee": "Alinta" }\n]',
  ],
  ['a number under a secret key masks', '[{"password":123}]', '[{"password":"***"}]'],
  ['a boolean under a secret key masks', '[{"password":true}]', '[{"password":"****"}]'],
  ['an empty secret cell says so', '[{"password":""}]', '[{"password":"(empty)"}]'],
  ['no four-character floor: the key is the rule here', '[{"password":"ab"}]', '[{"password":"**"}]'],
  ['not JSON at all', '[not json', '[not json'],
  ['plain text', 'Origin Energy', 'Origin Energy'],
  // U+FEFF is whitespace to JS, so it passed the `/^\s*[[{]/` sniff and then
  // threw in JSON.parse — and the catch hands the value back untouched, which
  // is the one outcome this function exists to prevent.
  ['a leading BOM does not smuggle a record past the sniff', '\uFEFF[{"password":"hunter2"}]', '[{"password":"*******"}]'],
  ['…and a BOM on something that is not a record changes nothing', '\uFEFFOrigin Energy', '\uFEFFOrigin Energy'],
  ['…nor on a record with nothing to mask', '\uFEFF[{"payee":"Alinta"}]', '\uFEFF[{"payee":"Alinta"}]'],
];

test('both record-masking mirrors answer one corpus identically', () => {
  for (const [what, input, expected] of MASK_CORPUS) {
    assert.equal(maskRecordSecrets(input), expected, `runner-core: ${what}`);
    assert.equal(maskRecordSecretsInline(input), expected, `variables-panel: ${what}`);
  }
});
