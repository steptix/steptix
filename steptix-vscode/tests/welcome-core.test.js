/**
 * The welcome page's rules (docs/specs/SPEC-install.md §7): which AI is in
 * use, the status bar's words for it, where a sample goes, Chrome, the page's
 * security policy, and the notice when Copilot stops answering.
 */
import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  aiStatusText,
  chromeFound,
  currentAi,
  keyHintFor,
  sampleFolderName,
  welcomeHtml,
} from '../src/extension/welcome-core.ts';
import { copilotTroubleNotice } from '../src/extension/lm-bridge-core.ts';

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

test("the project's own AI choice wins over the one for all projects", () => {
  const machine = 'AI_MODEL=anthropic/claude-sonnet-5-5\nAI_API_KEY=welcome-test-machine-key\n';
  assert.deepEqual(currentAi('', machine), {
    model: 'anthropic/claude-sonnet-5-5',
    key: 'welcome-test-machine-key',
    savedFor: 'all',
    blockedByProject: false,
  });
  assert.deepEqual(currentAi('AI_MODEL=openai/gpt-6-luna\nAI_API_KEY=welcome-test-project-key\n', machine), {
    model: 'openai/gpt-6-luna',
    key: 'welcome-test-project-key',
    savedFor: 'project',
    blockedByProject: false,
  });
});

test('an empty AI_API_KEY= in the project keeps the all-projects key out, and says so', () => {
  const ai = currentAi('AI_API_KEY=\n', 'AI_MODEL=openai/gpt-6-luna\nAI_API_KEY=welcome-test-machine-key\n');
  assert.equal(ai.model, null);
  assert.equal(ai.blockedByProject, true);
});

test('nothing chosen reads as not chosen', () => {
  assert.deepEqual(currentAi('', ''), { model: null, key: null, savedFor: null, blockedByProject: false });
  assert.equal(aiStatusText(null), 'AI: not chosen');
});

test("the status bar names the AI as a person reads it; a provider's key shows only its end", () => {
  assert.equal(aiStatusText('gateway/copilot/gpt-6-luna'), 'AI: Copilot · GPT 6 Luna');
  assert.equal(aiStatusText('openai/gpt-6-luna'), 'AI: OpenAI · GPT 6 Luna');
  assert.equal(keyHintFor('openai/gpt-6-luna', 'welcome-test-key-a1b2'), 'key ending …a1b2');
  assert.equal(keyHintFor('gateway/copilot/gpt-6-luna', 'bridge-token'), null);
});

test('a new sample goes in a folder that is not taken', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'steptix-welcome-'));
  made.push(parent);
  assert.equal(sampleFolderName(parent), 'steptix-sample');
  mkdirSync(path.join(parent, 'steptix-sample'));
  mkdirSync(path.join(parent, 'steptix-sample-2'));
  assert.equal(sampleFolderName(parent), 'steptix-sample-3');
});

test('Chrome is found where it installs', () => {
  const env = { ProgramFiles: 'C:\Program Files' };
  const expected = path.win32.join('C:\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
  assert.equal(chromeFound('win32', env, (p) => p === expected), true);
  assert.equal(chromeFound('win32', env, () => false), false);
  assert.equal(chromeFound('linux', {}, (p) => p === '/usr/bin/google-chrome-stable'), true);
});

test('the page runs only its own script and style, by nonce', () => {
  const html = welcomeHtml({ nonce: 'welcome-test-nonce', cspSource: 'vscode-resource:' });
  assert.match(html, /default-src 'none'; style-src vscode-resource: 'nonce-welcome-test-nonce'; script-src 'nonce-welcome-test-nonce';/);
  assert.equal(html.match(/<script nonce="welcome-test-nonce">/g)?.length, 1);
  assert.match(html, /<title>Welcome to Steptix<\/title>/);
});

test('Copilot stopping answering gets the notice with its way out, in the spec\'s words', () => {
  const err = (code, message = '') => ({ status: 429, body: { error: { code, message, type: 'x' } } });
  assert.equal(
    copilotTroubleNotice(err('quota_exhausted')),
    "Copilot has used up this month's requests. Compiled tests still run. To keep working now, switch to an AI provider.",
  );
  assert.equal(
    copilotTroubleNotice(err('model_not_found', 'Copilot no longer offers "copilot/gpt-6-luna"')),
    'Your Copilot no longer offers GPT 6 Luna. Pick another Copilot model, or switch to an AI provider.',
  );
  assert.match(copilotTroubleNotice(err('no_permissions')), /no longer has permission to use Copilot/);
  assert.equal(copilotTroubleNotice(err('lm_error')), null);
});
