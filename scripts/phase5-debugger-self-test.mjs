/**
 * Phase 5 manual e2e step 1 of 2: prove `debugger;` actually causes a pause
 * when an inspector client is attached.
 *
 * Uses Node's built-in `inspector` module to self-attach. Calls `executeToolStep`
 * with `pauseBeforeRun: true`. If the cooperative pause works, the
 * `Debugger.paused` event will fire and we'll see it from the listener.
 *
 * Self-attached inspector quirk: `Debugger.paused` for a `debugger;` keyword
 * IS supported in same-process sessions (per Node docs). The pause is observable
 * via the `Session` event listener even though there's no external client to
 * accept the pause and resume.
 */
import inspector from 'node:inspector';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Self-attach BEFORE importing the dist code so the inspector is live the
// moment `debugger;` is reached.
const session = new inspector.Session();
session.connect();

const events = [];
session.on('Debugger.paused', (ev) => {
  events.push({ at: Date.now(), reason: ev.params.reason });
  // Resume immediately — we can't sit on the pause forever, the process
  // will be wedged.
  session.post('Debugger.resume', () => {});
});

await new Promise((r) => session.post('Debugger.enable', r));

// Now import the compiled tool executor and run a no-op tool with
// pauseBeforeRun: true.
const executorPath = path.resolve(repoRoot, 'dist/tools/executor.js');
const { executeToolStep } = await import(new URL('file:///' + executorPath.replace(/\\/g, '/')));

// Build a synthetic tool catalogue + call. The framework normally loads
// these from disk but the in-memory shape is identical.
const def = {
  name: 'noop',
  description: 'no-op for debugger; test',
  parameters: {},
  outputs: { ok: { type: 'string' } },
  async run(args, ctx) {
    ctx.step.setVar('ok', 'true');
  },
};
const fakeCatalogue = {
  get: (name) => name === 'noop' ? { definition: def, filePath: '/synthetic/noop.ts' } : undefined,
  has: (name) => name === 'noop',
  require(name) {
    const got = this.get(name);
    if (!got) throw new Error(`tool ${name} missing`);
    return got;
  },
  names: () => ['noop'],
};

const call = { name: 'noop', args: {}, outputAliases: {} };
const resolvedParameters = {};
const fakePage = { url: () => '', title: async () => '' };

console.log('[before executeToolStep] paused events:', events.length);

const outcome = await executeToolStep(call, {
  page: fakePage,
  context: {},
  browser: {},
  resolvedParameters,
  catalogue: fakeCatalogue,
  pauseBeforeRun: true,
});

console.log('[after executeToolStep] paused events:', events.length);
console.log('outcome.status =', outcome.status);
console.log('outcome.outputs =', JSON.stringify(outcome.outputs));

if (events.length === 0) {
  console.error('FAIL: Debugger.paused never fired — `debugger;` did not pause execution.');
  process.exit(1);
}
if (events[0].reason !== 'other' && events[0].reason !== 'debugCommand') {
  console.error('FAIL: paused event fired but for wrong reason:', events[0].reason);
  process.exit(1);
}
if (outcome.status !== 'passed') {
  console.error('FAIL: tool did not complete:', outcome.status, outcome.error);
  process.exit(1);
}
console.log('PASS: debugger; statement paused execution at executeToolStep:pauseBeforeRun');
console.log('PASS: tool ran to completion after resume');
session.disconnect();
process.exit(0);
