/**
 * Create a sample project during an install (docs/specs/SPEC-install.md §8.3,
 * §7.1, §7.3), over two launches on one machine with no Node.js on PATH:
 *
 *   1. Install Server starts, as the welcome page's button starts it. Once
 *      Node.js is downloaded and npm is downloading the server, the welcome
 *      page's Create a sample project makes the sample and opens it in this
 *      window. VS Code would reload the window there, ending the extension
 *      host and the install with it; here the open is held back and the
 *      launch ends instead, which ends them the same way. npm, a child
 *      process, may carry on for a while after it.
 *   2. VS Code opens the sample, as the reloaded window would. The startup
 *      checks carry the install on without asking, under "Carrying on
 *      installing the Steptix server", with the Node.js launch 1 downloaded,
 *      and a matching server ends up in runtimes/. The welcome page comes
 *      back on the first step still undone: the server's, which is
 *      installing.
 *
 * The remembered answers are files in the Steptix folder, not VS Code's
 * globalState, which VS Code keeps in memory while it runs extension tests
 * (see ask-once.test.cjs). So the sample test that globalState would open in
 * launch 2 is not checked here.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { ROOT, VERSION, hooks, installRecord, installed, required, stubPrompts, waitFor } = require('./helpers.cjs');

const QUESTION = /needs its local server/;
const launch = () => Number(required('STEPTIX_INSTALL_TEST_LAUNCH'));
/** Where Create a sample project is told to put the sample. */
const PROJECTS = () => required('STEPTIX_INSTALL_TEST_PROJECTS');
const SAMPLE = () => path.join(PROJECTS(), 'steptix-sample');
const WANTED = () => path.join(ROOT(), 'install-wanted.json');
const REOPEN = () => path.join(ROOT(), 'welcome-reopen.json');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
/** One folder however it is written: a Uri's fsPath lowercases a Windows
 *  drive letter, and the temporary folder may be named by its short name. */
const sameFolder = (a, b) => {
  const canonical = (p) => fs.realpathSync.native(p);
  return process.platform === 'win32' ? canonical(a).toLowerCase() === canonical(b).toLowerCase() : canonical(a) === canonical(b);
};
const runtimesEntries = () => (fs.existsSync(path.join(ROOT(), 'runtimes')) ? fs.readdirSync(path.join(ROOT(), 'runtimes')) : []);
/** Steptix's own Node.js copies, with when each was made. */
const ownNodes = () => {
  const dir = path.join(ROOT(), 'node');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .map((n) => ({ version: n, made: fs.statSync(path.join(dir, n)).birthtimeMs }));
};

/** Replace `obj[name]` for the rest of the describe block. */
function stub(obj, name, make) {
  let original;
  before(() => {
    original = obj[name];
    obj[name] = make(original);
  });
  after(() => {
    obj[name] = original;
  });
}

describe(`an install cut off by Create a sample project (launch ${process.env.STEPTIX_INSTALL_TEST_LAUNCH})`, function () {
  this.timeout(20 * 60_000);
  const prompts = stubPrompts();

  /** What Create a sample project asked VS Code to open, held back. */
  const opened = [];
  stub(vscode.commands, 'executeCommand', (original) => (command, ...args) => {
    if (command !== 'vscode.openFolder') return original.call(vscode.commands, command, ...args);
    opened.push(args[0]);
    return Promise.resolve(undefined);
  });
  stub(vscode.window, 'showOpenDialog', () => async () => [vscode.Uri.file(PROJECTS())]);
  /** Every install progress: its title, and the steps it reported. */
  const progress = [];
  stub(vscode.window, 'withProgress', (original) => (options, task) => {
    const seen = { title: options.title, messages: [] };
    progress.push(seen);
    return original.call(vscode.window, options, (p, token) =>
      task(
        {
          report: (value) => {
            if (value?.message) seen.messages.push(value.message);
            p.report(value);
          },
        },
        token,
      ),
    );
  });

  it('Create a sample project opens the sample while npm downloads the server', async function () {
    if (launch() !== 1) this.skip();
    const h = await hooks();
    const state = async () => (await h.welcome.send({ type: 'ready' })).find((m) => m.type === 'state').state;
    fs.mkdirSync(PROJECTS(), { recursive: true });
    assert.deepEqual(installed(), [], 'starts with nothing installed');

    // What the welcome page's Install server sends; not waited for, since it
    // ends only when the install does.
    void vscode.commands.executeCommand('steptix.installServer', { addToPath: false });
    await waitFor(
      'npm to be downloading the server',
      async () => /^Downloading steptix/.test((await state()).server.progress ?? ''),
      15 * 60_000,
    );
    assert.deepEqual(progress.map((p) => p.title), ['Installing the Steptix server']);
    assert.equal(ownNodes().length, 1, `Node.js comes first: ${JSON.stringify(ownNodes())}`);
    assert.ok(runtimesEntries().some((n) => n.startsWith('.partial-npm-')), `npm's scratch folder: ${runtimesEntries()}`);
    assert.deepEqual(
      readJson(WANTED()),
      { addToPath: false, pid: process.pid },
      'the yes is remembered while it installs, naming the extension host installing',
    );

    await h.welcome.send({ type: 'createSample' });
    assert.equal(opened.length, 1, 'Create a sample project opened no folder');
    assert.ok(fs.existsSync(path.join(SAMPLE(), 'tests', 'first-test.md')), 'the sample was made');
    assert.ok(sameFolder(opened[0].fsPath, SAMPLE()), `opened ${opened[0].fsPath}, not the sample`);
    assert.ok(sameFolder(readJson(REOPEN()).folder, SAMPLE()), `the page notes ${readJson(REOPEN()).folder}, not the sample`);

    assert.ok(!installed().includes(VERSION()), 'the install finished before the window would have reloaded, so nothing was cut off');
    assert.deepEqual(prompts.matching(QUESTION), []);
    // The launch ends here, with the install still going.
  });

  it('carries the install on without asking, and the welcome page comes back on the first undone step', async function () {
    if (launch() !== 2) this.skip();
    const h = await hooks();
    assert.ok(sameFolder(vscode.workspace.workspaceFolders[0].uri.fsPath, SAMPLE()), 'opened on the sample');
    const left = readJson(WANTED());
    assert.equal(left.addToPath, false, 'launch 1 left its yes remembered');
    assert.notEqual(left.pid, process.pid, "the note is launch 1's extension host's, not this one's");
    assert.ok(!installed().includes(VERSION()), 'launch 1 left no server');
    const nodes = ownNodes();
    assert.equal(nodes.length, 1, `launch 1 downloaded Node.js: ${JSON.stringify(nodes)}`);
    // npm's scratch folder from launch 1 is not checked: npm may still be
    // writing to it, and the launcher removes it at its next copy only once
    // nothing holds it open (§8.3).

    await h.serverStartupChecks();
    assert.equal(await h.welcome.start(), 'server', 'the welcome page came back on the server step');
    assert.equal(fs.existsSync(REOPEN()), false, 'the note is used once');
    assert.equal(await h.welcome.start(), null, 'came back a second time');

    await waitFor(`runtimes/${VERSION()}`, () => installed().includes(VERSION()), 15 * 60_000);
    await waitFor('the install to be forgotten', () => !fs.existsSync(WANTED()), 120_000);
    assert.equal(installRecord(VERSION()).source, 'extension');
    assert.deepEqual(prompts.matching(QUESTION), [], 'it asked again');
    const titles = progress.map((p) => p.title);
    assert.deepEqual(titles, ['Carrying on installing the Steptix server'], `progress titles: ${JSON.stringify(titles)}`);
    const steps = progress.flatMap((p) => p.messages);
    assert.ok(!steps.includes('Downloading Node.js'), `Node.js was downloaded again: ${JSON.stringify(steps)}`);
    assert.deepEqual(ownNodes(), nodes, "launch 1's Node.js was kept and used");
  });
});
