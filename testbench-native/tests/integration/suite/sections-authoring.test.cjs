/**
 * Authoring providers for inline sections — go-to-definition, document links,
 * completion — in a real VS Code extension host.
 *
 * The diagnostic DECISION is unit-tested without a host
 * (`tests/section-diagnostics.test.js`); this covers the parts that need the
 * real language-feature surface. The fixture (`sections-authoring.md`) has a
 * resolved call on line 8 (`Login` → heading 12), another on line 10
 * (`Do checkout` → heading 16), and a near-miss (`Logn`) on line 9.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'pkent.testbench-native';
const FIXTURES_DIR =
  process.env.TESTBENCH_FIXTURES_DIR || path.resolve(__dirname, '..', 'fixtures');
const fixtureUri = (name) => vscode.Uri.file(path.resolve(FIXTURES_DIR, name));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      // transient
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

const defLine = (d) => ('range' in d ? d.range.start.line : d.targetRange.start.line);

describe('TestBench inline sections — authoring', function () {
  this.timeout(20_000);

  let authoringUri;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    authoringUri = fixtureUri('sections-authoring.md');
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('vscode.open', authoringUri);
    await waitFor('authoring fixture active', () => {
      const editor = vscode.window.activeTextEditor;
      return editor && editor.document.uri.toString() === authoringUri.toString();
    });
  });

  it('go-to-definition on a call jumps to the section heading', async () => {
    // The `Login` call is on line 8 (0-based 7), name from column 3.
    const defs = await vscode.commands.executeCommand(
      'vscode.executeDefinitionProvider',
      authoringUri,
      new vscode.Position(7, 4),
    );
    assert.ok(defs && defs.length >= 1, 'expected a definition');
    assert.equal(defLine(defs[0]), 11, '### Login is on line 12 (0-based 11)');
  });

  it('go-to-definition on the OTHER call resolves independently', async () => {
    // `Do checkout` on line 10 (0-based 9) → heading 16 (0-based 15).
    const defs = await vscode.commands.executeCommand(
      'vscode.executeDefinitionProvider',
      authoringUri,
      new vscode.Position(9, 5),
    );
    assert.ok(defs && defs.length >= 1);
    assert.equal(defLine(defs[0]), 15, '### Do checkout is on line 16 (0-based 15)');
  });

  it('go-to-definition on a HEADING returns its call site(s)', async () => {
    // Cursor on `### Login` (line 12, 0-based 11) → the call on line 8.
    const defs = await vscode.commands.executeCommand(
      'vscode.executeDefinitionProvider',
      authoringUri,
      new vscode.Position(11, 5),
    );
    assert.ok(defs && defs.length >= 1, 'expected the call site(s)');
    assert.ok(
      defs.map(defLine).includes(7),
      'the call on line 8 (0-based 7) is a usage of Login',
    );
  });

  it('go-to-definition on a near-miss resolves to nothing', async () => {
    // `Logn` on line 9 (0-based 8) is not a call — no jump.
    const defs = await vscode.commands.executeCommand(
      'vscode.executeDefinitionProvider',
      authoringUri,
      new vscode.Position(8, 4),
    );
    assert.ok(!defs || defs.length === 0, 'a typo is not a resolved call');
  });

  it('document links underline resolved calls and skip near-misses', async () => {
    const links = await vscode.commands.executeCommand(
      'vscode.executeLinkProvider',
      authoringUri,
    );
    const sectionLinks = (links ?? []).filter(
      (l) => l.target && l.target.toString().includes('revealSectionLine'),
    );
    const linkLines = sectionLinks.map((l) => l.range.start.line).sort((a, b) => a - b);
    // Calls on lines 8 and 10 (0-based 7, 9). The near-miss on line 9 (0-based
    // 8) resolves to nothing and gets NO link — the whole point of the link is
    // that a call which stays plain text stands out.
    assert.deepEqual(linkLines, [7, 9]);
  });

  it('completion offers section names after a step number', async () => {
    // Insert a fresh `4. ` step line below the last main-flow step, then
    // complete against its ordinal prefix.
    const editor = vscode.window.activeTextEditor;
    await editor.edit((b) => b.insert(new vscode.Position(9, 14), '\n4. '));
    const list = await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      authoringUri,
      new vscode.Position(10, 3),
    );
    // OUR items only (detail 'inline section'); the built-in word completer
    // also offers document words, which would make a label check pass for the
    // wrong reason.
    const sectionLabels = (list?.items ?? [])
      .filter((i) => i.detail === 'inline section')
      .map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
    assert.ok(sectionLabels.includes('Login'), 'Login should be offered');
    assert.ok(sectionLabels.includes('Do checkout'), 'Do checkout should be offered');
    assert.ok(sectionLabels.includes('Cleanup'), 'every section, called or not, is offerable');
  });

  it('completion does not offer an invalid section name', async () => {
    // A reserved-named section is flagged as an Error by diagnostics; offering
    // it as a completion would insert a step the same file marks broken. Add
    // one, then complete against a fresh step line.
    const editor = vscode.window.activeTextEditor;
    const end = new vscode.Position(editor.document.lineCount, 0);
    await editor.edit((b) => b.insert(end, '\n### Steps\n1. reserved body\n'));
    // Now type a new main-flow step and complete there.
    await editor.edit((b) => b.insert(new vscode.Position(9, 14), '\n4. '));

    const list = await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      authoringUri,
      new vscode.Position(10, 3),
    );
    const sectionLabels = (list?.items ?? [])
      .filter((i) => i.detail === 'inline section')
      .map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
    assert.ok(sectionLabels.includes('Login'), 'valid names are still offered');
    assert.ok(!sectionLabels.includes('Steps'), 'a reserved name must not be offered');
  });

  it('completion does NOT fire on a numbered line inside a fenced block', async () => {
    // The line-prefix regex alone would pop section names inside an example
    // fence; the region guard stops it. Target the SECOND fence line, not the
    // first: `classifyLines` doesn't track fences, so a numbered line inside
    // one classifies as a step, and a nearest-ancestor walk only excludes the
    // first fence line (whose opener above it is prose). Line 2+ is the case
    // that leaked before the fence scan was added.
    const editor = vscode.window.activeTextEditor;
    const end = new vscode.Position(editor.document.lineCount, 0);
    await editor.edit((b) => b.insert(end, '\n```text\n1. first fence line\n2. inside a fence\n```\n'));

    let fenceLine = -1;
    for (let i = 0; i < editor.document.lineCount; i++) {
      if (editor.document.lineAt(i).text === '2. inside a fence') {
        fenceLine = i;
        break;
      }
    }
    assert.ok(fenceLine >= 0, 'fixture edit did not take');

    const list = await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      authoringUri,
      new vscode.Position(fenceLine, 3),
    );
    // Assert on OUR items, identified by the `inline section` detail — not on
    // the label alone: VS Code aggregates the built-in markdown word completer
    // too, which offers "Login" because it appears elsewhere in the document.
    const ourSections = (list?.items ?? []).filter((i) => i.detail === 'inline section');
    assert.equal(ourSections.length, 0, 'section completions must not fire inside a code fence');
  });

  it('diagnostics squiggle the near-miss AND the dead section', async () => {
    // The provider is host-only; assert it actually publishes to the
    // `testbench-sections` collection (the decision itself is unit-tested).
    await waitFor(
      'diagnostics published',
      () => vscode.languages.getDiagnostics(authoringUri).some((d) => d.source === 'testbench-sections'),
      6_000,
    );
    const diags = vscode.languages
      .getDiagnostics(authoringUri)
      .filter((d) => d.source === 'testbench-sections');

    // The near-miss `Logn` (line 9, 0-based 8) is a Warning.
    assert.ok(
      diags.some(
        (d) => d.range.start.line === 8 && d.severity === vscode.DiagnosticSeverity.Warning,
      ),
      'expected a near-miss warning on the Logn line',
    );
    // `### Cleanup` (line 19, 0-based 18) is never called → Information.
    assert.ok(
      diags.some(
        (d) =>
          d.range.start.line === 18 &&
          d.severity === vscode.DiagnosticSeverity.Information &&
          /never used/.test(d.message),
      ),
      'expected a "never used" info on the Cleanup heading',
    );
  });
});
