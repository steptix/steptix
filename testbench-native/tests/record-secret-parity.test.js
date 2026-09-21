/**
 * What counts as a secret RECORD COLUMN is decided in three places, and they
 * must decide it identically (docs/specs/SPEC-structured-table-reads.md §7.6).
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
import { RECORD_SECRET_PATTERNS, isRecordSecretKey } from 'ai-ui-automation-runner-core';
import {
  RECORD_SECRET_PATTERNS as PANEL_PATTERNS,
  isRecordSecretKeyInline,
} from '../src/webview/lib/variables-panel.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_SOURCE_FILE = resolve(here, '..', '..', 'src', 'utils', 'secrets.ts');
const CORE_SOURCE_FILE = resolve(here, '..', '..', 'runner-core', 'src', 'repl.ts');

const serverSource = readFileSync(SERVER_SOURCE_FILE, 'utf8');
const coreSource = readFileSync(CORE_SOURCE_FILE, 'utf8');

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
