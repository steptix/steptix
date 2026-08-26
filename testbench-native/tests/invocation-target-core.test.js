/**
 * `toolFileFor` / `canonicalSkillName` / `collectSkillNames` — where an
 * invocation name points, and what completion may offer.
 *
 * These were extracted from `definition-provider.ts` and `section-providers.ts`
 * (which import `vscode`) so the rules are testable under `node --test`.
 * Every one of them MIRRORS a canonical implementation in the root package:
 *
 *   toolFileFor        ← parseToolRef       (src/tools/registry.ts)
 *   canonicalSkillName ← parseSkillCall     (src/skills/skill-call-parser.ts)
 *   collectSkillNames  ← loadSkill's layout + listToolFiles' walk rules
 *
 * The parity rows below are copied verbatim from the canonical implementations'
 * own tests (tests/tool-ref-parser.test.ts, tests/skill-call-parser.test.ts) and
 * hardcode the expected values rather than importing `src/` — the root package
 * is not a dependency of the extension, and a mirror that imports its original
 * proves nothing about drift anyway. If a row here disagrees with the root
 * suite, F12 opens a different file from the one the runner loads.
 *
 * Direct `.ts` specifier: the module is node builtins only (fs + path, no
 * vscode), so Node strips the types and loads it — same convention as
 * cache-dir-parity.test.js.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  TOOL_FILE_EXTS,
  canonicalSkillName,
  collectSkillNames,
  parseInvocationLine,
  skillHeading,
  toolFileFor,
} from '../src/extension/invocation-target-core.ts';

// ── toolFileFor: parity with parseToolRef ────────────────────────────────────
// One row per VALID ref in tests/tool-ref-parser.test.ts. `expected` is that
// test's `.file` value, verbatim.
const TOOL_REF_PARITY = [
  { ref: 'check_health', file: 'check_health' },
  { ref: 'my-cool-tool', file: 'my-cool-tool' },
  { ref: 'auth/login', file: 'auth' },
  { ref: 'auth/login/login', file: 'auth/login' },
  { ref: 'a/b/c/run', file: 'a/b/c' },
];

test('toolFileFor reproduces parseToolRef().file for every valid ref', () => {
  for (const row of TOOL_REF_PARITY) {
    assert.equal(
      toolFileFor(row.ref),
      row.file,
      `drift on "${row.ref}": got ${toolFileFor(row.ref)}, want ${row.file}`,
    );
  }
});

test('toolFileFor resolves a still-typing ref to the file being typed into', () => {
  // The author is mid-keystroke: `auth/login/` has no tool name yet, so the
  // file is everything before the trailing slash. Dropping ALL empty segments
  // instead (the bug this replaced) would apply last-segment-is-the-tool and
  // land on `auth` — the opposite of where they are heading.
  assert.equal(toolFileFor('auth/login/'), 'auth/login');
  assert.equal(toolFileFor('auth/'), 'auth');
});

test('toolFileFor refuses a leading slash, exactly like parseToolRef', () => {
  // `[skill: /a/b]` is legal sugar at runtime; `[tool: /a/b]` is not —
  // parseToolRef throws "empty path segment" on it. Navigating would bless a
  // ref the runner rejects, so the editor warns instead.
  assert.equal(toolFileFor('/check_health'), null);
  assert.equal(toolFileFor('/auth/login'), null);
});

test('toolFileFor returns null on an interior empty segment', () => {
  assert.equal(toolFileFor('auth//login'), null);
  assert.equal(toolFileFor('a//b/c'), null);
  assert.equal(toolFileFor('/'), null);
  assert.equal(toolFileFor(''), null);
});

test('TOOL_FILE_EXTS matches the registry probe order', () => {
  assert.deepEqual([...TOOL_FILE_EXTS], ['.ts', '.mts', '.js', '.mjs']);
});

// ── canonicalSkillName: parity with parseSkillCall ───────────────────────────

test('canonicalSkillName canonicalises exactly what parseSkillCall accepts', () => {
  const rows = [
    ['auth/login', 'auth/login'],
    ['/auth/login', 'auth/login'],
    ['flat', 'flat'],
    ['/flat', 'flat'],
    ['admin/users/create_user', 'admin/users/create_user'],
    // Every spelling below throws SkillCallSyntaxError in the runner, so the
    // editor must refuse to navigate rather than let path.join collapse it.
    ['auth//login', null],
    ['auth/', null],
    ['/', null],
    ['//', null],
    ['', null],
  ];
  for (const [input, expected] of rows) {
    assert.equal(
      canonicalSkillName(input),
      expected,
      `canonicalSkillName("${input}") should be ${JSON.stringify(expected)}`,
    );
  }
});

test('skillHeading is the last path segment', () => {
  assert.equal(skillHeading('auth/login'), 'login');
  assert.equal(skillHeading('admin/users/create_user'), 'create_user');
  assert.equal(skillHeading('flat'), 'flat');
});

// ── collectSkillNames ────────────────────────────────────────────────────────

/** Build a skills tree under a fresh tmp dir. Keys are `/`-separated paths. */
function makeSkillsDir(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-skills-'));
  for (const rel of files) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '# stub\n');
  }
  return root;
}

test('collectSkillNames emits subfolder skills with forward slashes, sorted', () => {
  const root = makeSkillsDir([
    'capture_url.md',
    'auth/login.md',
    'auth/reset_password.md',
    'admin/users/create_user.md',
  ]);
  try {
    assert.deepEqual(collectSkillNames(root), [
      'admin/users/create_user',
      'auth/login',
      'auth/reset_password',
      'capture_url',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collectSkillNames skips dot-dirs, node_modules and non-markdown files', () => {
  const root = makeSkillsDir([
    'login.md',
    '.aiui-codebehind-cache/login.steps.ts.candidate',
    '.aiui-codebehind-cache/notes.md',
    'node_modules/some-pkg/README.md',
    'auth/login.steps.ts',
  ]);
  try {
    assert.deepEqual(collectSkillNames(root), ['login']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collectSkillNames drops names the invocation grammar cannot lex', () => {
  // `[skill: bad dir/x]` stops lexing at the space and `[skill: v1.2/x]` at the
  // dot, so offering either as a completion would insert a step that fails to
  // parse. Same for a file whose basename has a space.
  const root = makeSkillsDir([
    'bad dir/x.md',
    'v1.2/y.md',
    'ok_dir/z.md',
    'has space.md',
  ]);
  try {
    assert.deepEqual(collectSkillNames(root), ['ok_dir/z']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collectSkillNames returns [] for a missing skills dir', () => {
  assert.deepEqual(collectSkillNames(path.join(os.tmpdir(), 'tb-skills-does-not-exist')), []);
});

test('collectSkillNames survives self-referential directory links (visited-set, not depth)', (t) => {
  // Two links back into the root: a depth cap alone makes this walk
  // O(links^depth) — measured in MINUTES at depth 16 — and it runs
  // synchronously per completion keystroke. The realpath visited-set means
  // every REAL directory is read once, so the loops contribute nothing and
  // the walk stays proportional to the actual tree.
  const root = makeSkillsDir(['real/login.md', 'real/deep/nested.md']);
  try {
    try {
      fs.symlinkSync(root, path.join(root, 'loop_a'), 'junction');
      fs.symlinkSync(root, path.join(root, 'loop_b'), 'junction');
    } catch (err) {
      t.skip(`cannot create junctions here: ${err.code ?? err.message}`);
      return;
    }
    const started = Date.now();
    const names = collectSkillNames(root);
    assert.ok(Date.now() - started < 2_000, 'a looping walk must terminate fast');
    // The root's real path is visited first, so the loop junctions resolve to
    // an already-visited directory and are skipped outright.
    assert.deepEqual(names, ['real/deep/nested', 'real/login']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collectSkillNames offers a junctioned subfolder once, under the first prefix walked', (t) => {
  // A junction to a SIBLING directory is the legitimate share case. Each real
  // directory is owned by whichever prefix reaches it first, and both
  // spellings resolve at runtime — the set exists to stop loops and duplicate
  // fan-out, not to pick a canonical alias. Which prefix wins depends on
  // readdir order, which NTFS sorts by name but other filesystems need not,
  // so assert "exactly one of the two spellings" rather than a fixed winner.
  const root = makeSkillsDir(['real/login.md']);
  try {
    try {
      fs.symlinkSync(path.join(root, 'real'), path.join(root, 'linked'), 'junction');
    } catch (err) {
      t.skip(`cannot create junctions here: ${err.code ?? err.message}`);
      return;
    }
    const names = collectSkillNames(root);
    assert.equal(names.length, 1, `one real dir, one visit: ${JSON.stringify(names)}`);
    assert.ok(
      names[0] === 'linked/login' || names[0] === 'real/login',
      `either spelling resolves at runtime, got ${JSON.stringify(names)}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collectSkillNames follows a symlinked skill file', (t) => {
  // `readdir`'s dirents are lstat-flavoured, so a symlink answers false to both
  // isFile() and isDirectory(). Classifying from a following statSync is what
  // keeps a symlinked skill visible — it was visible under the old flat
  // readdir, so dropping it would be a regression.
  const root = makeSkillsDir(['real/login.md']);
  try {
    try {
      fs.symlinkSync(path.join(root, 'real', 'login.md'), path.join(root, 'linked.md'), 'file');
    } catch (err) {
      // Windows without Developer Mode / admin refuses symlink creation.
      t.skip(`cannot create symlinks here: ${err.code ?? err.message}`);
      return;
    }
    assert.deepEqual(collectSkillNames(root), ['linked', 'real/login']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── parseInvocationLine: parity with parseInvocation's token finder ──────────
// One row per shape in tests/skill-call-parser.test.ts ("optional colon") and
// tests/tool-call-parser.test.ts. The editor and the tokenizer must agree on
// WHICH lines are invocations, or F12 navigates on a line the runner treats
// as prose (or vice versa).

test('parseInvocationLine accepts both the colon and colon-less spellings', () => {
  const rows = [
    ['1. [skill: login]', 'skill', 'login'],
    ['1. [skill login]', 'skill', 'login'],
    ['1. [skill  auth/login]', 'skill', 'auth/login'],
    ['1. [skill : login]', 'skill', 'login'],
    ['1. [skill:login]', 'skill', 'login'],
    ['1. Sign in [skill login user="x"]', 'skill', 'login'],
    ['1. [tool: seed_cart items=2]', 'tool', 'seed_cart'],
    ['1. [tool seed_cart items=2]', 'tool', 'seed_cart'],
    ['1. [tool auth/login/login]', 'tool', 'auth/login/login'],
  ];
  for (const [line, kind, name] of rows) {
    const inv = parseInvocationLine(line);
    assert.ok(inv, `"${line}" should parse as an invocation`);
    assert.equal(inv.kind, kind, `kind of "${line}"`);
    assert.equal(inv.name, name, `name of "${line}"`);
  }
});

test('parseInvocationLine reports the name range under both spellings', () => {
  // `1. [skill login]` — name starts after `1. [skill ` (10 chars).
  assert.deepEqual(parseInvocationLine('1. [skill login]').nameRange, [10, 15]);
  // `1. [skill: login]` — the colon shifts it one to the right.
  assert.deepEqual(parseInvocationLine('1. [skill: login]').nameRange, [11, 16]);
});

test('parseInvocationLine leaves bracketed prose alone', () => {
  // No colon and no whitespace directly after the keyword — never a call.
  for (const line of [
    '1. Check the [skillful] animation',
    '1. Open the [skills] page',
    '1. Open the [toolbox] panel',
    '1. A bare [skill] token',
    '1. plain prose with no brackets',
  ]) {
    assert.equal(parseInvocationLine(line), null, `"${line}" must stay prose`);
  }
});

test('parseInvocationLine scans past a near-miss to the real token', () => {
  const inv = parseInvocationLine('1. see [skillful] then [skill login]');
  assert.equal(inv?.kind, 'skill');
  assert.equal(inv?.name, 'login');
});
