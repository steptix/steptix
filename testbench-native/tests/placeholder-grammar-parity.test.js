/**
 * The editor's `{{name.property}}` mirror must be the runtime's grammar —
 * checked against the runtime's own source, not against a remembered string
 * (docs/specs/SPEC-structured-table-reads.md §8.3, §8.4).
 *
 * TestBench cannot import `src/`: `src/parser/parameters.ts` pulls in the
 * logger and the whole server-side tree, so `env-data-definition-core.ts`
 * carries `PLACEHOLDER_SOURCE` by hand. That is the drift this file exists to
 * catch, and it catches it the way `cache-dir-parity.test.js` does — one
 * agreed artefact, asserted from both sides. Here the artefact is the runtime
 * module's own text: the root suite (`tests/placeholder-dotted.test.ts`) pins
 * what the constant IS and what every `src/` reader DOES with it, and this
 * file pins that the extension's copy is that same literal.
 *
 * Reading the source text rather than importing it is deliberate. A regex over
 * one `export const` line is a blunt instrument, and it is the only one
 * available on this side of the boundary; if someone reformats that line this
 * test fails loudly with the line it could not read, which is a far better
 * outcome than the alternative — an editor quietly reading `{{order.id}}` as
 * `{{order}}` followed by the text `.id}}` on every table loop.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
// Both cores load directly under `node --test` (Node strips the types): they
// depend on runner-core, jsonc-parser and node builtins — never on `vscode`.
import {
  PARAM_REF_RE,
  findParameterBullet,
  paramRefAtPosition,
} from '../src/extension/env-data-definition-core.ts';
import {
  captureNamesBefore,
  findForEachBinding,
  isFencedLine,
} from '../src/extension/env-data-completion-core.ts';

const here = dirname(fileURLToPath(import.meta.url));
const RUNTIME_SOURCE_FILE = resolve(here, '..', '..', 'src', 'parser', 'parameters.ts');
const TESTS_DIR = resolve(here, '..', '..', 'templates', 'init', 'tests');

/**
 * The value of a single-quoted `export const <name> = '…';` in TypeScript
 * source, as JavaScript would see it. The grammar constants are plain
 * single-quoted literals with no quotes of their own, so JSON's unescaping is
 * exactly JavaScript's over this input.
 */
function exportedStringLiteral(source, name) {
  const hit = new RegExp(`export const ${name} = '([^']*)';`).exec(source);
  assert.ok(
    hit,
    `could not read \`export const ${name} = '…';\` out of src/parser/parameters.ts — ` +
      'if that line was reformatted, update this reader; if the constant was ' +
      'renamed or removed, the extension mirror below needs the same change',
  );
  return JSON.parse(`"${hit[1]}"`);
}

const runtimeSource = readFileSync(RUNTIME_SOURCE_FILE, 'utf8');
const NAME_SOURCE = exportedStringLiteral(runtimeSource, 'PLACEHOLDER_NAME_SOURCE');
/** `PLACEHOLDER_SOURCE`, composed the way parameters.ts composes it. */
const PLACEHOLDER_SOURCE = `\\{\\{(${NAME_SOURCE})\\}\\}`;

// ───────────────────────────────────────────────────────────────────────────
// The literal
// ───────────────────────────────────────────────────────────────────────────

test('the runtime constant is still the string both suites pin', () => {
  // The same golden as tests/placeholder-dotted.test.ts. Written out rather
  // than derived, so that a change to the runtime grammar has to be made
  // deliberately in three places instead of propagating silently into two.
  assert.equal(NAME_SOURCE, '\\w+(?:\\.[A-Za-z_][A-Za-z0-9_]*)?');
  assert.equal(PLACEHOLDER_SOURCE, '\\{\\{(\\w+(?:\\.[A-Za-z_][A-Za-z0-9_]*)?)\\}\\}');
});

test('the extension mirror is that literal, character for character', () => {
  assert.equal(PARAM_REF_RE.source, PLACEHOLDER_SOURCE);
  assert.equal(PARAM_REF_RE.flags, 'g');
});

// ───────────────────────────────────────────────────────────────────────────
// …and reads the same things with it
// ───────────────────────────────────────────────────────────────────────────

/** `[text, the name it should be read as, or null for "not a reference"]` —
 *  the corpus of tests/placeholder-dotted.test.ts, so the two sides are
 *  compared on the same cases and not on two convenient halves. */
const CORPUS = [
  ['{{email}}', 'email'],
  ['{{__skill1_username}}', '__skill1_username'],
  ['{{a}}', 'a'],
  // The root is `\w+` and always was — `{{1st}}` resolves.
  ['{{1st}}', '1st'],
  ['{{order.id}}', 'order.id'],
  ['{{order._row}}', 'order._row'],
  ['{{payment.next_payment}}', 'payment.next_payment'],
  ['{{_a._b}}', '_a._b'],
  ['{{o.p2}}', 'o.p2'],
  // One property segment, and no more.
  ['{{order.address.city}}', null],
  ['{{order.1}}', null],
  ['{{order.}}', null],
  ['{{.id}}', null],
  ['{{order-id}}', null],
  ['{{order id}}', null],
  ['{{ order.id }}', null],
];

test('the cursor hit-test reads what the runtime grammar reads', () => {
  const anchored = new RegExp(`^${PLACEHOLDER_SOURCE}$`);
  for (const [text, expected] of CORPUS) {
    // What the runtime would make of it, computed from ITS source…
    assert.equal(anchored.exec(text)?.[1] ?? null, expected, `runtime grammar on ${text}`);
    // …and what F12 makes of it, with the cursor in the middle of the token.
    const line = `Verify ${text} is shown`;
    const cursor = line.indexOf(text) + Math.floor(text.length / 2);
    assert.equal(
      paramRefAtPosition(line, cursor)?.name ?? null,
      expected,
      `editor hit-test on ${text}`,
    );
  }
});

test('a dotted reference is ONE token, not a flat one with text after it', () => {
  // The regression the width exists to prevent: a `\w+`-only mirror matches
  // nothing in `{{order.id}}` at all (there is no `}}` after `order`), so F12
  // and hover went dead there — and the moment anything DID read the prefix,
  // it would report the wrong name and toast about the wrong variable.
  const line = '2. Verify the row for "{{order.id}}" shows "{{order.status}}"';
  const names = [...line.matchAll(PARAM_REF_RE)].map((m) => m[1]);
  assert.deepEqual(names, ['order.id', 'order.status']);
  // Every match spans its whole `{{…}}`, leaving no `.id}}` behind as text.
  for (const m of line.matchAll(PARAM_REF_RE)) {
    assert.ok(m[0].startsWith('{{') && m[0].endsWith('}}'), m[0]);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// What a step WRITES stays flat
// ───────────────────────────────────────────────────────────────────────────

test('the definition-side copies stay flat, because they are definitions', () => {
  const setDotted = ['## Steps', '1. Set {{order.id}} to "A"', '2. done'].join('\n');
  assert.deepEqual(
    captureNamesBefore(setDotted, 99).map((c) => c.name),
    [],
    'a dotted Set target is not a Set step — the runtime refuses it too',
  );
  const setFlat = ['## Steps', '1. Set {{summary}} to "done"', '2. done'].join('\n');
  assert.deepEqual(
    captureNamesBefore(setFlat, 99).map((c) => c.name),
    ['summary'],
  );
  const storeDotted = ['## Steps', '1. Read the total [store as: order.total]'].join('\n');
  assert.deepEqual(
    captureNamesBefore(storeDotted, 99).map((c) => c.name),
    [],
    'a `[store as:]` names a variable, never a property of one',
  );
});

// ───────────────────────────────────────────────────────────────────────────
// Where a loop item comes from
// ───────────────────────────────────────────────────────────────────────────

const LOOP_FILE = [
  '## Steps',
  '1. Read the Order ID column as id from every row in the Orders table [store as: orders]',
  '2. For each {{order}} in {{orders}}, Check the order',
  '',
  '### Check the order',
  '1. Verify {{order.id}} is shown',
  '',
  '```markdown',
  '3. For each {{ghost}} in {{ghosts}}, Do nothing',
  '```',
].join('\n');

test('a loop item resolves to its For each header, by root', () => {
  const byRoot = findForEachBinding(LOOP_FILE, 'order');
  const byProperty = findForEachBinding(LOOP_FILE, 'order.id');
  assert.deepEqual(byRoot, byProperty, '{{order.id}} and {{order}} have one origin');
  assert.equal(byRoot.length, 1);
  // 0-based line 2 is `2. For each …`, and the column selects `order` inside
  // its braces rather than the whole header.
  assert.equal(byRoot[0].line, 2);
  assert.equal(
    LOOP_FILE.split('\n')[2].slice(byRoot[0].column, byRoot[0].column + byRoot[0].length),
    'order',
  );
});

test('an example inside a fence binds nothing', () => {
  assert.deepEqual(findForEachBinding(LOOP_FILE, 'ghost'), []);
});

test('a line that only looks like a loop binds nothing', () => {
  const notLoops = [
    '## Steps',
    '1. Verify the For each {{order}} in {{orders}} example is shown',
    '2. For each {{order}} in {{orders}}',
  ].join('\n');
  assert.deepEqual(findForEachBinding(notLoops, 'order'), []);
});

// ───────────────────────────────────────────────────────────────────────────
// The eight acceptance files, end to end
// ───────────────────────────────────────────────────────────────────────────

/** The `table-read`-tagged acceptance tests (the `table-baseline-*` four are
 *  the pre-feature control and carry no dotted reference). */
function tableReadFiles() {
  return readdirSync(TESTS_DIR)
    .filter((f) => f.startsWith('table-') && f.endsWith('.md'))
    .map((f) => ({ name: f, text: readFileSync(resolve(TESTS_DIR, f), 'utf8') }))
    .filter((f) => /^tags:.*\btable-read\b/m.test(f.text));
}

test('the acceptance corpus is present and actually dotted', () => {
  const files = tableReadFiles();
  assert.equal(files.length, 8, 'expected the eight table-read acceptance tests');
  for (const file of files) {
    assert.ok(
      /\{\{\w+\.[A-Za-z_]\w*\}\}/.test(file.text),
      `${file.name} carries no dotted reference — this suite would pass vacuously`,
    );
  }
});

test('no dotted reference in a step of them is left without a definition', () => {
  // The provider's exact predicate (env-data-definition.ts `paramTarget`):
  // a parameter bullet, an in-scope capture, or a `For each` header. When all
  // three come back empty it toasts — so this is the test that says the
  // widened grammar introduced no false report on the corpus it was widened
  // for. Steps only, and unfenced: a `{{item.property}}` in one of these
  // files' prose IS a name nothing binds (table-orders.md says so while
  // describing the feature), and saying so is the toast doing its job.
  let checked = 0;
  for (const { name, text } of tableReadFiles()) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*\d+\.\s+\S/.test(lines[i]) || isFencedLine(text, i)) continue;
      for (const m of lines[i].matchAll(PARAM_REF_RE)) {
        const root = m[1].split('.')[0];
        const resolved =
          findParameterBullet(text, root) !== null ||
          captureNamesBefore(text, i).some((c) => c.name === root) ||
          findForEachBinding(text, root).length > 0;
        assert.ok(resolved, `${name}:${i + 1} — nothing defines {{${m[1]}}}`);
        if (m[1].includes('.')) {
          checked++;
          // …and the `For each` is WHY. A loop item is not a capture and not a
          // parameter, so without `findForEachBinding` every one of these
          // would fall through to the toast — which is the regression the
          // widened grammar would otherwise have introduced.
          assert.equal(
            findParameterBullet(text, root) === null &&
              !captureNamesBefore(text, i).some((c) => c.name === root),
            true,
            `${name}:${i + 1} — {{${m[1]}}}'s root is written by a step, so this file ` +
              'no longer exercises the loop-binding path',
          );
        }
      }
    }
  }
  assert.ok(checked >= 20, `only ${checked} dotted step references checked`);
});
