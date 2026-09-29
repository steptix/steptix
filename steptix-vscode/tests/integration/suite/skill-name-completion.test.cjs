/**
 * Skill-NAME completion inside an open `[skill` token, in a real extension
 * host. The anchor decisions (which cursor positions count as "inside an
 * open token") are unit-tested in tests/invocation-target-core.test.js;
 * this proves the wiring: names come from the project's `skills/` walk,
 * items replace exactly the typed partial, closed calls and bracketed
 * prose stay quiet, and the step-start snippet path replaces the typed
 * token instead of appending after it.
 *
 * Same layout as env-data-completion.test.cjs: the whole project lives in
 * a runtime-generated `snc-project/` subfolder of the fixtures workspace
 * with its OWN `steptix.config.json`, so `resolveProjectDirs`' walk-up stops
 * there and the suite never depends on the repo's real skills.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'pkent.steptix-vscode';
const FIXTURES_DIR =
  process.env.STEPTIX_FIXTURES_DIR || path.resolve(__dirname, '..', 'fixtures');
const PROJECT_DIR = path.join(FIXTURES_DIR, 'snc-project');
const STEPS_MD = path.join(PROJECT_DIR, 'snc-steps.md');

/** The fixture, hoisted so assertions derive columns from the lines. */
const STEPS_LINES = [
  '# SNC fixture',
  '',
  '## Steps',
  '1. [skill ',
  '2. Log in [skill: au',
  '3. [skill auth/',
  '4. see [skillful] anim',
  '5. [skill: capture_url] then prose',
  '6. [sk',
  // A bracket token preceded by other non-space text. STEP_START_RE admits
  // any single non-space run, so a `\S*$` replace range spanned `"Save"[sk`
  // and accepting a completion DELETED the author's `"Save"`.
  '7. "Save"[sk',
  '',
];

const lineText = (marker) => {
  const line = STEPS_LINES.find((l) => l.startsWith(marker));
  assert.ok(line !== undefined, `no fixture line starts with "${marker}"`);
  return line;
};

/** Completions with the cursor at the END of the line starting with `marker`,
 *  mapped to plain objects. `range` is flattened to start/end characters —
 *  our items always carry a single-line vscode.Range. */
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
    kind: i.kind,
    detail: i.detail,
    rangeStart: i.range instanceof vscode.Range ? i.range.start.character : undefined,
    rangeEnd: i.range instanceof vscode.Range ? i.range.end.character : undefined,
  }));
}

/** Just our skill-name items (detail 'skill'), labels sorted. */
const nameItems = (items) => items.filter((i) => i.detail === 'skill');
/** Whole-call snippet items from the step-start path. */
const snippetItems = (items) => items.filter((i) => i.detail === 'skill invocation');

describe('Steptix skill-name completion in [skill …', function () {
  this.timeout(20_000);

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();

    fs.mkdirSync(path.join(PROJECT_DIR, 'skills', 'auth'), { recursive: true });
    fs.writeFileSync(
      path.join(PROJECT_DIR, 'steptix.config.json'),
      JSON.stringify({ tests: { skillsDir: 'skills' } }),
    );
    for (const rel of ['capture_url.md', 'auth/login.md', 'auth/reset_password.md']) {
      fs.writeFileSync(path.join(PROJECT_DIR, 'skills', ...rel.split('/')), '# stub\n');
    }
    fs.writeFileSync(STEPS_MD, STEPS_LINES.join('\n'));
  });

  after(() => {
    fs.rmSync(PROJECT_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('offers every skill NAME after `[skill ` — no whole-call snippets, no sections', async () => {
    const items = await completionsAt('1. [skill ');
    assert.deepEqual(
      nameItems(items)
        .map((i) => i.label)
        .sort(),
      ['auth/login', 'auth/reset_password', 'capture_url'],
    );
    // The author has committed to a skill call: nothing else of ours.
    assert.equal(snippetItems(items).length, 0, 'no whole-call snippets inside an open token');
    assert.equal(
      items.filter((i) => i.detail === 'inline section').length,
      0,
      'no section items inside an open token',
    );
    // Empty partial: the replace range is empty, sitting at the cursor.
    const col = lineText('1. [skill ').length;
    for (const i of nameItems(items)) {
      assert.equal(i.rangeStart, col, `${i.label} range start`);
      assert.equal(i.rangeEnd, col, `${i.label} range end`);
    }
  });

  it('replaces the typed partial in place (label form, colon separator)', async () => {
    const items = await completionsAt('2. Log in [skill: au');
    const labels = nameItems(items).map((i) => i.label);
    assert.ok(labels.includes('auth/login'), `expected auth/login in ${JSON.stringify(labels)}`);
    // Range spans exactly the `au` the author typed — the client-side filter
    // does the narrowing; the provider offers the full list.
    const line = lineText('2. Log in [skill: au');
    for (const i of nameItems(items)) {
      assert.equal(i.rangeStart, line.length - 'au'.length, `${i.label} range start`);
      assert.equal(i.rangeEnd, line.length, `${i.label} range end`);
    }
  });

  it('keeps completing across a subfolder slash, colon-less spelling', async () => {
    const items = await completionsAt('3. [skill auth/');
    const labels = nameItems(items).map((i) => i.label);
    assert.ok(labels.includes('auth/login'));
    assert.ok(labels.includes('auth/reset_password'));
    const line = lineText('3. [skill auth/');
    for (const i of nameItems(items)) {
      assert.equal(i.rangeStart, line.length - 'auth/'.length, `${i.label} range start`);
    }
  });

  it('stays quiet inside bracketed prose and after a closed call', async () => {
    for (const marker of ['4. see', '5. [skill: capture_url]']) {
      const items = await completionsAt(marker);
      assert.equal(nameItems(items).length, 0, `${marker}: no name items`);
      assert.equal(snippetItems(items).length, 0, `${marker}: no snippet items`);
    }
  });

  it('step-start snippets replace the typed token (the `1. [[skill:` fix)', async () => {
    const items = await completionsAt('6. [sk');
    const snippets = snippetItems(items);
    assert.deepEqual(
      snippets.map((i) => i.label).sort(),
      ['[skill: auth/login]', '[skill: auth/reset_password]', '[skill: capture_url]'],
    );
    // Range covers the typed `[sk` token, so acceptance replaces it.
    const line = lineText('6. [sk');
    for (const i of snippets) {
      assert.equal(i.rangeStart, line.length - '[sk'.length, `${i.label} range start`);
      assert.equal(i.rangeEnd, line.length, `${i.label} range end`);
    }
  });

  it('the snippet range covers ONLY the bracket token, never preceding text', async () => {
    // Regression: the range was `\S*$`, which at `7. "Save"[sk` spanned
    // `"Save"[sk` — accepting a completion silently deleted `"Save"`.
    const items = await completionsAt('7. "Save"[sk');
    const snippets = snippetItems(items);
    assert.ok(snippets.length > 0, 'snippets should still be offered here');
    const line = lineText('7. "Save"[sk');
    for (const i of snippets) {
      assert.equal(
        i.rangeStart,
        line.length - '[sk'.length,
        `${i.label} must replace only "[sk", not the preceding "Save"`,
      );
      assert.equal(i.rangeEnd, line.length, `${i.label} range end`);
    }
  });
});
