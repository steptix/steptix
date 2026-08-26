/**
 * `${data.X.Y}` / `${env.X}` / `${<source>.X}` go-to-definition in a real
 * extension host. The token hit-testing, JSON position walk, and .env line
 * scan are unit-tested (`tests/env-data-definition.test.js`); this proves the
 * wiring — the data file resolves under the `aiui.config.json` project root
 * for the ACTIVE env, the overlay .env wins over the base, dataSources
 * namespaces navigate to their own file, and the gates (no env, skills'
 * `data`, undeclared namespaces) yield no navigation.
 *
 * Same layout convention as the completion suite next door: the project lives
 * in a runtime-generated `dd-project/` subfolder of the fixtures workspace
 * with its OWN `aiui.config.json`, so the walk-up stops there.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'pkent.testbench-native';
const FIXTURES_DIR =
  process.env.TESTBENCH_FIXTURES_DIR || path.resolve(__dirname, '..', 'fixtures');
const PROJECT_DIR = path.join(FIXTURES_DIR, 'dd-project');

const STEPS_MD = path.join(PROJECT_DIR, 'dd-steps.md');
const SKILL_MD = path.join(PROJECT_DIR, 'dd-skill.md');
const DATA_JSON = path.join(PROJECT_DIR, 'data', 'dd1.json');
const CATALOG_JSON = path.join(PROJECT_DIR, 'data', 'dd-catalog.json');
const BASE_ENV = path.join(PROJECT_DIR, '.env');
const OVERLAY_ENV = path.join(PROJECT_DIR, '.env.dd1');

const setEnv = (name) =>
  vscode.workspace
    .getConfiguration('testbench-native')
    .update('activeEnv', name, vscode.ConfigurationTarget.Global);

/** Fixture contents hoisted as line arrays so the expected line/column of
 *  every target is derived by searching them, never hard-coded — editing a
 *  fixture then can't silently invalidate an assertion. */
const DATA_LINES = [
  '{',
  '  "users": {',
  '    "admin": { "email": "dd@x.com", "password": "$DD_TOKEN" }',
  '  },',
  '  "list": ["a", "b"]',
  '}',
];
const CATALOG_LINES = ['{', '  "product": { "name": "Anvil" }', '}'];
const BASE_ENV_LINES = ['DD_BASE=hello', 'DD_SHARED=base'];
const OVERLAY_ENV_LINES = ['DD_TOKEN=sekret', 'DD_SHARED=overlay'];

/** The steps fixture, hoisted so `{{...}}` assertions can derive their
 *  expected in-file lines/columns instead of hard-coding them. */
const STEPS_LINES = [
  '---',
  'dataSources:',
  '  catalog: ./data/dd-catalog.json',
  '---',
  '',
  '# DD definition fixture',
  '',
  '## Parameters',
  '- username: demo@x.com',
  '- shadowed: from-params',
  '',
  '## Steps',
  '1. Use ${data.users.admin.email} to sign in',
  '2. Base is ${env.DD_BASE} and ${env.DD_SHARED}',
  '3. Catalog ${catalog.product.name}',
  '4. Missing ${data.users.ghost}',
  '5. Unknown ${nonesuch.thing}',
  '6. Sign in as {{username}}',
  '7. Read the balance [store as: balance]',
  '8. Also store [store as: shadowed]',
  '9. Verify {{balance}} and {{shadowed}}',
  '10. Check {{early}} before its write',
  '11. Read the total [store as: early]',
  '12. And {{ghost}} resolves to nothing',
  '',
];

/** 0-based document line of the first fixture line starting with `prefix`. */
const stepsLine = (prefix) => {
  const line = STEPS_LINES.findIndex((l) => l.startsWith(prefix));
  assert.ok(line >= 0, `fixture line starting with "${prefix}" not found`);
  return line;
};

/** 0-based {line, column} of `token` in a hoisted fixture. */
const posIn = (lines, token) => {
  const line = lines.findIndex((l) => l.includes(token));
  assert.ok(line >= 0, `fixture token "${token}" not found`);
  return { line, column: lines[line].indexOf(token) };
};

/**
 * Definitions at the first character INSIDE `token` on the first fixture line
 * starting with `marker`, normalized to {fsPath, range} whether the host
 * hands back Locations or LocationLinks.
 */
async function defsAt(fileAbs, marker, token) {
  const uri = vscode.Uri.file(fileAbs);
  const doc = await vscode.workspace.openTextDocument(uri);
  let pos = null;
  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    if (!text.startsWith(marker)) continue;
    const col = text.indexOf(token);
    assert.ok(col >= 0, `token "${token}" not on the "${marker}" line`);
    pos = new vscode.Position(i, col + 1);
    break;
  }
  assert.ok(pos, `fixture line starting with "${marker}" not found`);
  const raw = await vscode.commands.executeCommand(
    'vscode.executeDefinitionProvider',
    uri,
    pos,
  );
  return (raw ?? []).map((d) => ({
    fsPath: (d.targetUri ?? d.uri).fsPath,
    range: d.targetSelectionRange ?? d.targetRange ?? d.range,
  }));
}

/** The definition entry targeting `fileAbs`, asserting there is exactly one. */
function targeting(defs, fileAbs) {
  const wanted = fileAbs.toLowerCase();
  const hits = defs.filter((d) => d.fsPath.toLowerCase() === wanted);
  assert.equal(hits.length, 1, `expected one definition into ${fileAbs}, got ${hits.length}`);
  return hits[0];
}

/** No definition points into the project's data/env files. */
function assertNoFileTargets(defs) {
  const files = defs.filter(
    (d) => d.fsPath.toLowerCase().endsWith('.json') || d.fsPath.toLowerCase().includes('.env'),
  );
  assert.deepEqual(
    files.map((d) => d.fsPath),
    [],
    'no data/env file should be a target here',
  );
}

describe('TestBench ${...} go-to-definition', function () {
  this.timeout(20_000);

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();

    fs.mkdirSync(path.join(PROJECT_DIR, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(PROJECT_DIR, 'aiui.config.json'),
      JSON.stringify({ tests: { dataDir: 'data' } }),
    );
    fs.writeFileSync(BASE_ENV, BASE_ENV_LINES.join('\n') + '\n');
    fs.writeFileSync(OVERLAY_ENV, OVERLAY_ENV_LINES.join('\n') + '\n');
    fs.writeFileSync(DATA_JSON, DATA_LINES.join('\n') + '\n');
    fs.writeFileSync(CATALOG_JSON, CATALOG_LINES.join('\n') + '\n');

    fs.writeFileSync(STEPS_MD, STEPS_LINES.join('\n'));
    fs.writeFileSync(
      SKILL_MD,
      [
        '---',
        'type: skill',
        '---',
        '',
        '# dd skill',
        '',
        '## Steps',
        '1. Use ${data.users.admin.email} here',
        '',
      ].join('\n'),
    );
  });

  after(async () => {
    await setEnv(undefined);
    fs.rmSync(PROJECT_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('jumps from a ${data...} segment to that key in the active data file', async () => {
    await setEnv('dd1');
    const defs = await defsAt(STEPS_MD, '1. Use ${data', 'email');
    const hit = targeting(defs, DATA_JSON);
    const expected = posIn(DATA_LINES, 'email');
    assert.equal(hit.range.start.line, expected.line);
    assert.equal(hit.range.start.character, expected.column);
    assert.equal(hit.range.end.character, expected.column + 'email'.length);
  });

  it('an earlier segment jumps to its own (shallower) key', async () => {
    await setEnv('dd1');
    const defs = await defsAt(STEPS_MD, '1. Use ${data', 'users');
    const hit = targeting(defs, DATA_JSON);
    const expected = posIn(DATA_LINES, 'users');
    assert.equal(hit.range.start.line, expected.line);
    assert.equal(hit.range.start.character, expected.column);
  });

  it('the namespace token opens the data file at the top', async () => {
    await setEnv('dd1');
    const defs = await defsAt(STEPS_MD, '1. Use ${data', 'data');
    const hit = targeting(defs, DATA_JSON);
    assert.equal(hit.range.start.line, 0);
    assert.equal(hit.range.start.character, 0);
  });

  it('${env.X} lands on the assignment line — the overlay winning over the base', async () => {
    await setEnv('dd1');

    const shared = await defsAt(STEPS_MD, '2. Base is', 'DD_SHARED');
    const sharedHit = targeting(shared, OVERLAY_ENV);
    assert.equal(sharedHit.range.start.line, posIn(OVERLAY_ENV_LINES, 'DD_SHARED').line);
    assert.equal(sharedHit.range.start.character, 0);
    assert.equal(sharedHit.range.end.character, 'DD_SHARED'.length);

    const base = await defsAt(STEPS_MD, '2. Base is', 'DD_BASE');
    const baseHit = targeting(base, BASE_ENV);
    assert.equal(baseHit.range.start.line, posIn(BASE_ENV_LINES, 'DD_BASE').line);
  });

  it('a declared dataSources namespace navigates into its own file', async () => {
    await setEnv('dd1');
    const defs = await defsAt(STEPS_MD, '3. Catalog', 'name');
    const hit = targeting(defs, CATALOG_JSON);
    const expected = posIn(CATALOG_LINES, 'name');
    assert.equal(hit.range.start.line, expected.line);
    assert.equal(hit.range.start.character, expected.column);
  });

  it('a missing key still navigates — to the nearest existing ancestor', async () => {
    await setEnv('dd1');
    const defs = await defsAt(STEPS_MD, '4. Missing', 'ghost');
    const hit = targeting(defs, DATA_JSON);
    const expected = posIn(DATA_LINES, 'users');
    assert.equal(hit.range.start.line, expected.line);
    assert.equal(hit.range.start.character, expected.column);
  });

  it('an undeclared namespace is not a jump target', async () => {
    await setEnv('dd1');
    assertNoFileTargets(await defsAt(STEPS_MD, '5. Unknown', 'thing'));
  });

  it('skills never navigate ${data...} — they cannot see the caller data file', async () => {
    await setEnv('dd1');
    assertNoFileTargets(await defsAt(SKILL_MD, '1. Use ${data', 'email'));
  });

  it('with no environment selected there is nothing to navigate to', async () => {
    await setEnv(undefined);
    assertNoFileTargets(await defsAt(STEPS_MD, '1. Use ${data', 'email'));
  });

  it('{{param}} jumps to its Parameters bullet — with NO env required', async () => {
    // The deliberate parity gap: `{{}}` resolves without an env, so its
    // definition must too.
    await setEnv(undefined);
    const defs = await defsAt(STEPS_MD, '6. Sign in as', 'username');
    const hit = targeting(defs, STEPS_MD);
    const bulletLine = stepsLine('- username');
    assert.equal(hit.range.start.line, bulletLine);
    assert.equal(hit.range.start.character, STEPS_LINES[bulletLine].indexOf('username'));
    assert.equal(hit.range.end.character, hit.range.start.character + 'username'.length);
  });

  it('{{capture}} jumps to the earlier step that stores it', async () => {
    await setEnv('dd1');
    const defs = await defsAt(STEPS_MD, '9. Verify', 'balance');
    const hit = targeting(defs, STEPS_MD);
    const storeLine = stepsLine('7. Read the balance');
    assert.equal(hit.range.start.line, storeLine);
    // The name token inside `[store as: balance]`, not the prose mention.
    assert.equal(hit.range.start.character, STEPS_LINES[storeLine].lastIndexOf('balance'));
  });

  it('a captured-over parameter yields both writers as a peek list', async () => {
    await setEnv('dd1');
    const defs = await defsAt(STEPS_MD, '9. Verify', 'shadowed');
    const ours = defs
      .filter((d) => d.fsPath.toLowerCase() === STEPS_MD.toLowerCase())
      .map((d) => [d.range.start.line, d.range.start.character])
      .sort((a, b) => a[0] - b[0]);
    const bulletLine = stepsLine('- shadowed');
    const storeLine = stepsLine('8. Also store');
    assert.deepEqual(ours, [
      [bulletLine, STEPS_LINES[bulletLine].indexOf('shadowed')],
      [storeLine, STEPS_LINES[storeLine].indexOf('shadowed')],
    ]);
  });

  it('a capture below the cursor is out of scope — nothing to jump to', async () => {
    await setEnv('dd1');
    const defs = await defsAt(STEPS_MD, '10. Check', 'early');
    assert.deepEqual(
      defs.filter((d) => d.fsPath.toLowerCase() === STEPS_MD.toLowerCase()),
      [],
      'a step cannot read a value written after it',
    );
  });

  it('a {{name}} nothing writes is not a jump target', async () => {
    await setEnv('dd1');
    const defs = await defsAt(STEPS_MD, '12. And', 'ghost');
    assert.deepEqual(
      defs.filter((d) => d.fsPath.toLowerCase() === STEPS_MD.toLowerCase()),
      [],
    );
  });
});
