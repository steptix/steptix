/**
 * Parameter completion inside an open `[skill` call, in a real extension
 * host. The argument-position decisions live in `openSkillArgsContext`
 * (unit-tested in tests/invocation-target-core.test.js); this proves the
 * wiring: parameters come from the skill file's own `## Parameters`, insert
 * as `name="│"` snippets replacing the typed partial, already-passed
 * parameters drop out, outputs ride along as `out.<name>`, and value
 * positions stay quiet.
 *
 * Same layout as skill-name-completion.test.cjs: a runtime-generated
 * `sac-project/` (gitignored) with its own `steptix.config.json`.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'pkent.steptix-vscode';
const FIXTURES_DIR =
  process.env.STEPTIX_FIXTURES_DIR || path.resolve(__dirname, '..', 'fixtures');
const PROJECT_DIR = path.join(FIXTURES_DIR, 'sac-project');
const STEPS_MD = path.join(PROJECT_DIR, 'sac-steps.md');

const STEPS_LINES = [
  '# SAC fixture',
  '',
  '## Steps',
  '1. [skill login ',
  '2. [skill login user',
  '3. [skill login username="x" ',
  '4. [skill login msg="unterminated ',
  '5. [skill: login out.',
  '6. [skill nope ',
  '',
];

const lineText = (marker) => {
  const line = STEPS_LINES.find((l) => l.startsWith(marker));
  assert.ok(line !== undefined, `no fixture line starts with "${marker}"`);
  return line;
};

/** Completions with the cursor at the END of the line starting with `marker`. */
async function completionsAt(marker) {
  const uri = vscode.Uri.file(STEPS_MD);
  const doc = await vscode.workspace.openTextDocument(uri);
  let pos = null;
  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    if (text.startsWith(marker)) {
      pos = new vscode.Position(i, text.length);
      break;
    }
  }
  assert.ok(pos, `fixture line starting with "${marker}" not found`);
  const list = await vscode.commands.executeCommand(
    'vscode.executeCompletionItemProvider',
    uri,
    pos,
  );
  return (list?.items ?? []).map((i) => ({
    label: typeof i.label === 'string' ? i.label : i.label.label,
    detail: i.detail,
    doc: typeof i.documentation === 'string' ? i.documentation : i.documentation?.value,
    insert:
      i.insertText instanceof vscode.SnippetString ? i.insertText.value : i.insertText,
    rangeStart: i.range instanceof vscode.Range ? i.range.start.character : undefined,
    rangeEnd: i.range instanceof vscode.Range ? i.range.end.character : undefined,
  }));
}

const paramItems = (items) => items.filter((i) => i.detail === 'parameter');
const outputItems = (items) => items.filter((i) => i.detail === 'output');

describe('Steptix parameter completion in [skill …', function () {
  this.timeout(20_000);

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();

    fs.mkdirSync(path.join(PROJECT_DIR, 'skills'), { recursive: true });
    fs.writeFileSync(
      path.join(PROJECT_DIR, 'steptix.config.json'),
      JSON.stringify({ tests: { skillsDir: 'skills' } }),
    );
    fs.writeFileSync(
      path.join(PROJECT_DIR, 'skills', 'login.md'),
      [
        '# login',
        '',
        '## Parameters',
        '- username: the account to sign in as',
        '- password: $SB_PASSWORD',
        '',
        '## Outputs',
        '- session_id: the logged-in session identifier',
        '',
        '## Steps',
        '1. Sign in as {{username}}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(STEPS_MD, STEPS_LINES.join('\n'));
  });

  after(() => {
    fs.rmSync(PROJECT_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('offers the declared parameters with caret-in-quotes snippets, then outputs', async () => {
    const items = await completionsAt('1. [skill login ');
    const params = paramItems(items);
    assert.deepEqual(
      params.map((i) => i.label),
      ['username', 'password'],
      'declaration order',
    );
    // The bullet's literal text is the documentation — the env ref stays
    // four unresolved words, never the secret behind it.
    assert.equal(params[0].doc, 'the account to sign in as');
    assert.equal(params[1].doc, '$SB_PASSWORD');
    assert.equal(params[0].insert, 'username="$1"$0');
    assert.deepEqual(
      outputItems(items).map((i) => i.label),
      ['out.session_id'],
    );
    // Fresh position: an empty replace range at the cursor.
    const col = lineText('1. [skill login ').length;
    for (const i of [...params, ...outputItems(items)]) {
      assert.equal(i.rangeStart, col, `${i.label} range start`);
      assert.equal(i.rangeEnd, col, `${i.label} range end`);
    }
  });

  it('replaces the typed partial in place', async () => {
    const items = await completionsAt('2. [skill login user');
    const params = paramItems(items);
    assert.ok(params.some((i) => i.label === 'username'));
    const line = lineText('2. [skill login user');
    for (const i of params) {
      assert.equal(i.rangeStart, line.length - 'user'.length, `${i.label} range start`);
      assert.equal(i.rangeEnd, line.length, `${i.label} range end`);
    }
  });

  it('drops parameters the call already passes', async () => {
    const items = await completionsAt('3. [skill login username="x" ');
    const labels = paramItems(items).map((i) => i.label);
    assert.deepEqual(labels, ['password'], `username must be excluded, got ${labels}`);
  });

  it('stays quiet inside a quoted value', async () => {
    const items = await completionsAt('4. [skill login msg="unterminated ');
    assert.equal(paramItems(items).length, 0);
    assert.equal(outputItems(items).length, 0);
  });

  it('completes an out. partial, colon spelling included', async () => {
    const items = await completionsAt('5. [skill: login out.');
    const outs = outputItems(items);
    assert.deepEqual(
      outs.map((i) => i.label),
      ['out.session_id'],
    );
    const line = lineText('5. [skill: login out.');
    assert.equal(outs[0].rangeStart, line.length - 'out.'.length, 'range covers the out. partial');
  });

  it('offers nothing for a skill with no file', async () => {
    const items = await completionsAt('6. [skill nope ');
    assert.equal(paramItems(items).length, 0);
    assert.equal(outputItems(items).length, 0);
  });
});
