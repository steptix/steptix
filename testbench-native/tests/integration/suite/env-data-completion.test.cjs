/**
 * `${env.X}` / `${data.X.Y}` / `${<source>.X}` / `${envName}` completion in a
 * real extension host. The parsing/masking decisions are unit-tested
 * (`tests/env-data-completion.test.js`); this proves the wiring — the active
 * env comes from the EnvSelector setting (or a frontmatter pin), env/data
 * files resolve under the `aiui.config.json` project root with NO walk-up
 * (server parity), and dataSources paths interpolate for skills.
 *
 * The whole project lives in a runtime-generated `dc-project/` subfolder of
 * the fixtures workspace with its OWN `aiui.config.json`: the walk-up must
 * stop there, not at this repo's root config — which also keeps the suite
 * from depending on the repo's real `fixtures/data/*` files.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'pkent.testbench-native';
const FIXTURES_DIR =
  process.env.TESTBENCH_FIXTURES_DIR || path.resolve(__dirname, '..', 'fixtures');
const PROJECT_DIR = path.join(FIXTURES_DIR, 'dc-project');

const STEPS_MD = path.join(PROJECT_DIR, 'dc-steps.md');
const PINNED_MD = path.join(PROJECT_DIR, 'dc-pinned.md');
const EMPTY_PIN_MD = path.join(PROJECT_DIR, 'dc-empty-pin.md');
const SKILL_MD = path.join(PROJECT_DIR, 'dc-skill.md');
const NESTED_MD = path.join(PROJECT_DIR, 'tests', 'dc-nested.md');

const setEnv = (name) =>
  vscode.workspace
    .getConfiguration('testbench-native')
    .update('activeEnv', name, vscode.ConfigurationTarget.Global);

/** Completions at the end of the first line starting with `marker`, filtered
 *  down to OUR items (module/variable/struct/value/constant kinds) — the
 *  built-in markdown word/path suggesters also answer and must not be able
 *  to satisfy or break an assertion. */
async function completionsAt(fileAbs, marker, kinds) {
  const uri = vscode.Uri.file(fileAbs);
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
  return (list?.items ?? [])
    .filter((i) => kinds.includes(i.kind))
    .map((i) => ({
      label: typeof i.label === 'string' ? i.label : i.label.label,
      kind: i.kind,
      detail: i.detail,
    }));
}

const K = vscode.CompletionItemKind;
const NAMESPACE_KINDS = [K.Module, K.Constant];
const VALUE_KINDS = [K.Struct, K.Value, K.Variable];
const ALL_OUR_KINDS = [...NAMESPACE_KINDS, ...VALUE_KINDS];

describe('TestBench ${...} env/data completion', function () {
  this.timeout(20_000);

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();

    fs.mkdirSync(path.join(PROJECT_DIR, 'data'), { recursive: true });
    fs.mkdirSync(path.join(PROJECT_DIR, 'tests'), { recursive: true });
    fs.writeFileSync(
      path.join(PROJECT_DIR, 'aiui.config.json'),
      JSON.stringify({ tests: { dataDir: 'data' } }),
    );
    // Project-root .env + the dc1 overlay — the two files the server's
    // resolveEnvBundle reads. The nested tests/.env exists to prove the
    // provider does NOT walk up from the test file.
    fs.writeFileSync(path.join(PROJECT_DIR, '.env'), 'DC_BASE_VAR=hello\n');
    fs.writeFileSync(
      path.join(PROJECT_DIR, '.env.dc1'),
      'DC_TOKEN=supersecret\nDC_OVERLAY=from-overlay\n',
    );
    fs.writeFileSync(path.join(PROJECT_DIR, 'tests', '.env'), 'DC_NESTED_VAR=nested\n');
    fs.writeFileSync(
      path.join(PROJECT_DIR, 'data', 'dc1.json'),
      JSON.stringify({
        users: { admin: { email: 'dc@x.com', password: '$DC_TOKEN' } },
        fixtures: { currency: 'USD' },
      }),
    );
    fs.writeFileSync(
      path.join(PROJECT_DIR, 'data', 'dc-catalog.json'),
      JSON.stringify({ product: { name: 'Anvil', price: 9 } }),
    );
    fs.writeFileSync(
      path.join(PROJECT_DIR, 'data', 'dc1-endpoints.json'),
      JSON.stringify({ api: { url: 'http://dc.example' } }),
    );

    fs.writeFileSync(
      STEPS_MD,
      [
        '---',
        'dataSources:',
        '  catalog: ./data/dc-catalog.json',
        '---',
        '',
        '# DC completion fixture',
        '',
        '## Steps',
        '1. Navigate to ${',
        '2. Sign in with ${data.',
        '3. Use ${data.users.admin.',
        '4. Base is ${env.',
        '5. Catalog ${catalog.',
        '6. Deep ${env.DC_BASE_VAR.',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      PINNED_MD,
      ['---', 'env: dc1', '---', '', '## Steps', '1. Go to ${', ''].join('\n'),
    );
    // A present-but-blank `env:` pins "no env" — batch-run semantics.
    fs.writeFileSync(
      EMPTY_PIN_MD,
      ['---', 'env:', '---', '', '## Steps', '1. Pinned off ${', ''].join('\n'),
    );
    fs.writeFileSync(
      SKILL_MD,
      [
        '---',
        'type: skill',
        'dataSources:',
        '  endpoints: ./data/${envName}-endpoints.json',
        '---',
        '',
        '# dc skill',
        '',
        '## Steps',
        '1. Open ${',
        '2. Hit ${endpoints.',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      NESTED_MD,
      ['## Steps', '1. Nested ${env.', ''].join('\n'),
    );
  });

  after(async () => {
    await setEnv(undefined);
    fs.rmSync(PROJECT_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('offers data, the declared source, env, and envName after ${', async () => {
    await setEnv('dc1');
    const items = await completionsAt(STEPS_MD, '1. Navigate to ${', NAMESPACE_KINDS);
    const byLabel = Object.fromEntries(items.map((i) => [i.label, i]));

    assert.ok(byLabel.data, 'data namespace offered');
    assert.equal(byLabel.data.detail, 'data/dc1.json');
    assert.ok(byLabel.catalog, 'declared dataSources namespace offered');
    assert.equal(byLabel.catalog.detail, './data/dc-catalog.json');
    assert.ok(byLabel.env, 'env namespace offered');
    assert.ok(byLabel.envName, 'envName offered while an env is active');
    assert.equal(byLabel.envName.detail, 'dc1');
  });

  it('walks the active data file: top level, then a nested branch', async () => {
    await setEnv('dc1');
    const top = await completionsAt(STEPS_MD, '2. Sign in with ${data.', VALUE_KINDS);
    assert.deepEqual(
      top.map((i) => i.label).sort(),
      ['fixtures', 'users'],
    );

    const admin = await completionsAt(STEPS_MD, '3. Use ${data.users.admin.', VALUE_KINDS);
    const byLabel = Object.fromEntries(admin.map((i) => [i.label, i]));
    assert.equal(byLabel.email.detail, 'dc@x.com');
    // `$DC_TOKEN` resolves against the composed env (overlay), then masks —
    // the real value must never surface in the completion UI.
    assert.equal(byLabel.password.detail, '********');
  });

  it('composes ${env.} from the project-root .env plus the overlay, no walk-up', async () => {
    await setEnv('dc1');
    const items = await completionsAt(STEPS_MD, '4. Base is ${env.', VALUE_KINDS);
    const byLabel = Object.fromEntries(items.map((i) => [i.label, i]));

    assert.equal(byLabel.DC_BASE_VAR.detail, 'hello');
    assert.equal(byLabel.DC_OVERLAY.detail, 'from-overlay');
    assert.equal(byLabel.DC_TOKEN.detail, '********', 'secret-named env vars are masked');
    // Both env files live at the aiui.config.json root — the fixture
    // workspace root's .env (SERVER_URL etc.) is not this project's.
    assert.ok(!byLabel.SERVER_URL, 'outer .env must not leak into the project');

    // Server parity: ${env.X} resolves from <projectRoot>/.env only, so a
    // test-adjacent tests/.env contributes nothing — and the project root's
    // keys are offered even from a nested test file.
    const nested = await completionsAt(NESTED_MD, '1. Nested ${env.', VALUE_KINDS);
    const nestedLabels = nested.map((i) => i.label);
    assert.ok(nestedLabels.includes('DC_BASE_VAR'), 'project-root .env keys offered when nested');
    assert.ok(!nestedLabels.includes('DC_NESTED_VAR'), 'walked-up .env keys must not be offered');
  });

  it('env is a flat namespace — nothing is offered below ${env.X.', async () => {
    await setEnv('dc1');
    const items = await completionsAt(STEPS_MD, '6. Deep ${env.DC_BASE_VAR.', VALUE_KINDS);
    assert.deepEqual(items, [], 'no env var forms a valid reference one level deep');
  });

  it('completes a declared dataSources namespace from its JSON file', async () => {
    await setEnv('dc1');
    const items = await completionsAt(STEPS_MD, '5. Catalog ${catalog.', VALUE_KINDS);
    assert.deepEqual(
      items.map((i) => [i.label, i.detail]),
      [['product', '{2 keys}']],
    );
  });

  it('skills: no data namespace, and ${envName} interpolates in the source path', async () => {
    await setEnv('dc1');
    const ns = await completionsAt(SKILL_MD, '1. Open ${', NAMESPACE_KINDS);
    const labels = ns.map((i) => i.label);
    assert.ok(!labels.includes('data'), 'skills never see the caller-env data file');
    assert.ok(labels.includes('endpoints'), 'the skill-private source is offered');

    // `./data/${envName}-endpoints.json` → data/dc1-endpoints.json.
    const keys = await completionsAt(SKILL_MD, '2. Hit ${endpoints.', VALUE_KINDS);
    assert.deepEqual(
      keys.map((i) => i.label),
      ['api'],
    );
  });

  it('no env → no suggestions; a frontmatter env: pin still enables them', async () => {
    await setEnv(undefined);
    // A run with no env interpolates nothing — completing any ${...} would
    // hand the AI literal text, so the provider offers nothing at all.
    const bare = await completionsAt(STEPS_MD, '1. Navigate to ${', ALL_OUR_KINDS);
    assert.deepEqual(bare, [], 'no env selected → nothing offerable');

    const pinned = await completionsAt(PINNED_MD, '1. Go to ${', NAMESPACE_KINDS);
    const byLabel = Object.fromEntries(pinned.map((i) => [i.label, i]));
    assert.ok(byLabel.data, 'the frontmatter pin selects the env, like a batch run');
    assert.equal(byLabel.data.detail, 'data/dc1.json');
    assert.equal(byLabel.envName.detail, 'dc1');
  });

  it('a blank env: pin means "no env" even while the selector has one', async () => {
    await setEnv('dc1');
    // Batch semantics: the pin is sent verbatim and a blank one trims to
    // none — that run interpolates nothing, so completion offers nothing.
    const items = await completionsAt(EMPTY_PIN_MD, '1. Pinned off ${', ALL_OUR_KINDS);
    assert.deepEqual(items, [], 'blank pin shadows the selector');
  });
});
