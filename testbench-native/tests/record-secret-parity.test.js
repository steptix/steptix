/**
 * What counts as a secret is decided in three places, by two rules, and they
 * must decide it identically (docs/specs/SPEC-structured-table-reads.md §7.6).
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
 * is what hides them — so a mirror that forgets a word shows a password the
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
  maskRecordSecrets,
} from 'ai-ui-automation-runner-core';
import {
  RECORD_SECRET_PATTERNS as PANEL_PATTERNS,
  SECRET_NAME_PATTERN as PANEL_SECRET_NAME,
  isRecordSecretKeyInline,
  isSecretFlatNameInline,
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

/** The pattern of a `const <name> = /…/;` line, as a string. Both files spell
 *  these as plain unflagged literals on one line; anything else is a reformat
 *  this reader is entitled to fail on. */
function regexLiteralSource(source, name, file) {
  const hit = new RegExp(`const ${name} = /(.*)/;`).exec(source);
  assert.ok(
    hit,
    `could not read \`const ${name} = /…/;\` out of ${file} — if that line was ` +
      'reformatted, update this reader; if the pattern was renamed or removed, ' +
      'every mirror listed at the top of this file needs the same change',
  );
  return hit[1];
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
  const word = regexLiteralSource(serverSource, 'RECORD_SECRET_WORD', 'src/utils/secrets.ts');
  const key = regexLiteralSource(serverSource, 'RECORD_SECRET_KEY', 'src/utils/secrets.ts');

  // Sanity: the reader found patterns, not an empty match off a comment.
  assert.ok(word.includes('password'), word);
  assert.ok(key.includes('_keys?'), key);

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
];

test('both record-masking mirrors answer one corpus identically', () => {
  for (const [what, input, expected] of MASK_CORPUS) {
    assert.equal(maskRecordSecrets(input), expected, `runner-core: ${what}`);
    assert.equal(maskRecordSecretsInline(input), expected, `variables-panel: ${what}`);
  }
});
