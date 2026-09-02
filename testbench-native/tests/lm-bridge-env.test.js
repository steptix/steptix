/**
 * What "TestBench: Use Copilot for AI" writes into `.env`
 * (stories/copilot-lm-bridge.md §The setup command, effect 3).
 *
 * The file holds the user's other secrets, so the rules worth pinning are the
 * conservative ones: unrelated lines survive untouched, an existing assignment
 * is rewritten where it sits rather than appended a second time, and the
 * confirm the user approves never renders the token. Plus the one edge the
 * story calls out in words — a deliberately blank `AI_API_KEY` is a project
 * pinned keyless, and overwriting it changes what runs do.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  ENV_COMMENT_LINES,
  PREVIOUS_KEY_PLACEHOLDER,
  TOKEN_PLACEHOLDER,
  envCommentLines,
  isLocalServerUrl,
  overlayBridgeKeys,
  planEnvUpdate,
  serverUrlIn,
} from '../src/extension/lm-bridge-env.ts';

const TOKEN = 'f'.repeat(64);
const INPUT = {
  model: 'gateway/copilot/gpt-4.1',
  gatewayUrl: 'http://127.0.0.1:18790',
  token: TOKEN,
};

const plan = (text) => planEnvUpdate({ text, ...INPUT });
const lines = (result) => result.text.split('\n');

test('an absent .env is created with the trio and the symptom comments', () => {
  const result = plan('');
  assert.equal(result.unchanged, false);
  assert.ok(result.text.includes('AI_MODEL=gateway/copilot/gpt-4.1'));
  assert.ok(result.text.includes('AI_GATEWAY_URL=http://127.0.0.1:18790'));
  assert.ok(result.text.includes(`AI_API_KEY=${TOKEN}`));
  for (const comment of ENV_COMMENT_LINES) assert.ok(result.text.includes(comment));
  assert.ok(result.text.endsWith('\n'), 'files end with a newline');
});

test('the comment names both failure symptoms, since neither explains itself', () => {
  const text = plan('').text;
  assert.match(text, /Connection refused/);
  assert.match(text, /401/);
  assert.match(text, /another machine/);
  assert.match(text, /SecretStorage/);
});

test('the comment blames the machine, not Settings Sync', () => {
  // Both bridge settings are scope "machine", which Settings Sync EXCLUDES —
  // so "Sync copies the settings but not the token" described a mechanism that
  // does not run, and sent a reader looking at their sync config instead of at
  // whether a bridge is up in this window.
  const text = plan('').text;
  assert.doesNotMatch(text, /Settings Sync/);
  assert.match(text, /no bridge is running on this machine/);
  assert.match(text, /Rerun setup in this window/);
});

test('unrelated lines are preserved exactly, in place', () => {
  const before = [
    '# my project',
    'SERVER_URL=http://localhost:3100',
    'BANK_PASSWORD=hunter2',
    '',
  ].join('\n');
  const after = plan(before).text;
  assert.ok(after.startsWith(before.slice(0, before.length - 1)), 'the head is untouched');
  assert.ok(after.includes('BANK_PASSWORD=hunter2'));
});

test('an existing assignment is rewritten where it sits, not appended again', () => {
  const before = [
    '# which model to use',
    'AI_MODEL=openai/chatgpt-5.5',
    'SERVER_URL=http://localhost:3100',
    '',
  ].join('\n');
  const result = plan(before);
  const out = lines(result);
  assert.equal(out[0], '# which model to use', 'the comment stays attached to its line');
  assert.equal(out[1], 'AI_MODEL=gateway/copilot/gpt-4.1');
  assert.equal(
    out.filter((l) => l.startsWith('AI_MODEL=')).length,
    1,
    'exactly one AI_MODEL survives',
  );
});

test('when a key is assigned twice, the line a run would win with is the one rewritten', () => {
  const before = ['AI_MODEL=first', 'AI_MODEL=second', ''].join('\n');
  const out = lines(plan(before));
  assert.equal(out[0], 'AI_MODEL=first', 'the shadowed line is left alone');
  assert.equal(out[1], 'AI_MODEL=gateway/copilot/gpt-4.1');
});

test('a file already pointing here is unchanged — no confirm, no rewrite', () => {
  const settled = plan('').text;
  const result = plan(settled);
  assert.equal(result.unchanged, true);
  assert.deepEqual(result.changes, []);
});

test('a second write does not stack a second copy of the comment block', () => {
  const first = plan('').text;
  // Same file, different port: the trio is rewritten in place and nothing is
  // appended, so the comment cannot double.
  const second = planEnvUpdate({
    text: first,
    ...INPUT,
    gatewayUrl: 'http://127.0.0.1:18791',
  }).text;
  const occurrences = second.split(ENV_COMMENT_LINES[0]).length - 1;
  assert.equal(occurrences, 1);
  assert.ok(second.includes('AI_GATEWAY_URL=http://127.0.0.1:18791'));
});

test('a blank AI_API_KEY is a keyless project, and filling it is flagged in words', () => {
  const result = plan(['SERVER_URL=http://localhost:3100', 'AI_API_KEY=', ''].join('\n'));
  assert.equal(result.flipsKeylessToKeyed, true);
  assert.ok(result.text.includes(`AI_API_KEY=${TOKEN}`));
});

test('a file with no AI_API_KEY at all is not a keyless flip — nothing was pinned', () => {
  assert.equal(plan('SERVER_URL=http://localhost:3100\n').flipsKeylessToKeyed, false);
  assert.equal(plan('').flipsKeylessToKeyed, false);
});

test('replacing a real key is not a keyless flip either', () => {
  const result = plan('AI_API_KEY=sk-live-something\n');
  assert.equal(result.flipsKeylessToKeyed, false);
  assert.ok(result.text.includes(`AI_API_KEY=${TOKEN}`));
});

test('the preview shows the diff the user approves, with the token masked', () => {
  const result = plan('AI_API_KEY=sk-live-something\n');
  assert.ok(result.preview.includes(TOKEN_PLACEHOLDER));
  assert.ok(!result.preview.includes(TOKEN), 'the token itself never reaches a dialog');
  assert.match(result.preview, /\+ AI_MODEL=gateway\/copilot\/gpt-4\.1/);
});

test('the key being REPLACED is masked too — the minus side is just as sensitive', () => {
  const result = plan('AI_API_KEY=sk-live-something\n');
  assert.ok(
    !result.preview.includes('sk-live-something'),
    'a modal gets screenshotted; the old key must not be in it',
  );
  assert.match(result.preview, new RegExp(`- AI_API_KEY=${PREVIOUS_KEY_PLACEHOLDER}`));
});

test('a BLANK previous key is shown as blank — that is the keyless pin, and it must be visible', () => {
  const result = plan('AI_API_KEY=\n');
  assert.match(result.preview, /- AI_API_KEY=\n/);
  assert.ok(!result.preview.includes(PREVIOUS_KEY_PLACEHOLDER));
});

test('a non-secret key keeps its old value in the diff — there is nothing to hide', () => {
  const result = plan('AI_MODEL=openai/chatgpt-5.5\n');
  assert.match(result.preview, /- AI_MODEL=openai\/chatgpt-5\.5/);
});

test('SERVER_URL is read back so the caller can warn about a remote server', () => {
  assert.equal(plan('SERVER_URL=https://ci.corp.example\n').serverUrl, 'https://ci.corp.example');
  assert.equal(plan('').serverUrl, null);
});

test('a loopback SERVER_URL is local; anything else is not', () => {
  assert.equal(isLocalServerUrl('http://localhost:3100'), true);
  assert.equal(isLocalServerUrl('http://127.0.0.1:3100'), true);
  assert.equal(isLocalServerUrl('http://[::1]:3100'), true);
  assert.equal(isLocalServerUrl('http://app.localhost:3100'), true);
  assert.equal(isLocalServerUrl('https://ci.corp.example'), false);
  assert.equal(isLocalServerUrl('http://192.168.1.20:3100'), false);
});

test('an unparseable or empty SERVER_URL does not raise a second, wrong warning', () => {
  assert.equal(isLocalServerUrl(''), true);
  assert.equal(isLocalServerUrl('   '), true);
  assert.equal(isLocalServerUrl('http://'), true);
});

test('a CRLF file stays CRLF — rewritten lines and appended ones both', () => {
  const before = 'SERVER_URL=http://localhost:3100\r\nAI_MODEL=openai/chatgpt-5.5\r\n';
  const after = plan(before).text;
  assert.ok(after.includes('AI_MODEL=gateway/copilot/gpt-4.1\r\n'), 'the rewrite keeps its \\r');
  assert.ok(after.includes(`AI_API_KEY=${TOKEN}\r\n`), 'the append takes the file\'s ending');
  assert.equal(
    after.split('\n').filter((l) => l !== '' && !l.endsWith('\r')).length,
    0,
    'no line was left with a bare LF in a CRLF file',
  );
  // And running again is a no-op, so the \r does not read as a changed value.
  assert.equal(planEnvUpdate({ text: after, ...INPUT }).unchanged, true);
});

test('an LF file stays LF — no stray \\r is introduced', () => {
  const after = plan('SERVER_URL=http://localhost:3100\n').text;
  assert.ok(!after.includes('\r'));
});

test('a file without a trailing newline gains a separating blank line, not a joined line', () => {
  const out = lines(plan('SERVER_URL=http://localhost:3100'));
  assert.equal(out[0], 'SERVER_URL=http://localhost:3100');
  assert.equal(out[1], '', 'the appended block starts on its own line');
});

// ---------------------------------------------------------------------------
// The active environment's overlay (stories/env-overlay-awareness.md Part A)
// ---------------------------------------------------------------------------

test('an absent overlay file sets none of the trio — that is the no-conflict case', () => {
  // A missing `.env.<name>` reaches the detector as '' (readIfPresent), and so
  // does no active env at all. Both mean "nothing shadows the write".
  assert.deepEqual(overlayBridgeKeys(''), []);
});

test('an overlay with none of the trio does not interrupt setup', () => {
  const text = ['SERVER_URL=http://localhost:3100', 'BANK_PASSWORD=hunter2', ''].join('\n');
  assert.deepEqual(overlayBridgeKeys(text), []);
});

test('each of the three counts on its own, because each composes a broken run alone', () => {
  // AI_API_KEY is the incident. AI_MODEL alone is worse: the bridge token is
  // posted to whatever provider that model names. AI_GATEWAY_URL alone dials a
  // stranger — and surfaces as the SDK's bare 'Connection error.'
  assert.deepEqual(overlayBridgeKeys('AI_API_KEY=sk-live-other\n'), ['AI_API_KEY']);
  assert.deepEqual(overlayBridgeKeys('AI_MODEL=openai/chatgpt-5.5\n'), ['AI_MODEL']);
  assert.deepEqual(overlayBridgeKeys('AI_GATEWAY_URL=https://uat.example\n'), ['AI_GATEWAY_URL']);
  assert.deepEqual(
    overlayBridgeKeys('AI_API_KEY=x\nSERVER_URL=y\nAI_MODEL=z\n'),
    ['AI_MODEL', 'AI_API_KEY'],
    'reported in trio order, whatever order the file has',
  );
});

test('a blank AI_API_KEY in the overlay still shadows — an empty value is a value', () => {
  // `AI_API_KEY=` pins a run keyless. Written into the overlay it beats a
  // perfect `.env`, and the symptom is "AI is not configured", not a 401.
  assert.deepEqual(overlayBridgeKeys('AI_API_KEY=\n'), ['AI_API_KEY']);
});

test('the overlay is read with the server grammar, not a second one', () => {
  // scanServerEnv skips a malformed line instead of throwing, and keys
  // `export FOO=1` as `export FOO` — exactly as the server does. A stricter
  // reader here would either blow up on someone's file or claim a conflict a
  // run would never see.
  assert.deepEqual(overlayBridgeKeys('this is not an assignment\nAI_MODEL=m\n'), ['AI_MODEL']);
  assert.deepEqual(overlayBridgeKeys('export AI_API_KEY=k\n'), []);
});

test('writing the overlay produces the SAME full trio, not just the shadowed key', () => {
  // Half a trio in the file that wins is the failure this whole check exists
  // to prevent: an overlay AI_MODEL=openai/... over a bridge token posts that
  // token to OpenAI.
  const overlay = planEnvUpdate({ text: 'AI_API_KEY=sk-live-other\n', ...INPUT, envName: 'uat' });
  assert.ok(overlay.text.includes('AI_MODEL=gateway/copilot/gpt-4.1'));
  assert.ok(overlay.text.includes('AI_GATEWAY_URL=http://127.0.0.1:18790'));
  assert.ok(overlay.text.includes(`AI_API_KEY=${TOKEN}`));
  assert.equal(overlay.changes.length, 3);
});

test('targeting the overlay changes only the comment block — the same plan, either file', () => {
  const base = plan('SERVER_URL=http://localhost:3100\n');
  const overlay = planEnvUpdate({
    text: 'SERVER_URL=http://localhost:3100\n',
    ...INPUT,
    envName: 'uat',
  });
  const assignments = (text) => text.split('\n').filter((l) => !l.startsWith('#'));
  assert.deepEqual(assignments(overlay.text), assignments(base.text));
});

test('the overlay file says it only applies while that env is active', () => {
  // The head's advice is "rerun setup in this window", which in a `.env.uat`
  // is true only while uat is selected — the staleness that mints the next 401.
  const text = planEnvUpdate({ text: '', ...INPUT, envName: 'uat' }).text;
  assert.match(text, /\.env\.uat/);
  assert.match(text, /active environment \(testbench-native\.activeEnv\)/);
  assert.match(text, /--env uat/);
});

test('the base .env names the overlay as the third 401 cause', () => {
  // The one the file cannot see for itself, and the one "rerun setup" does not
  // fix: setup finds `.env` already correct and writes nothing.
  const text = plan('').text;
  assert.match(text, /testbench-native\.activeEnv/);
  assert.match(text, /\.env\.<name> sets its own/);
});

test('the overlay file does NOT carry the base file\'s overlay cause — it IS the winner', () => {
  const text = planEnvUpdate({ text: '', ...INPUT, envName: 'uat' }).text;
  assert.doesNotMatch(text, /beats this file on every run/);
});

test('both blocks share their first line, so switching target cannot stack two', () => {
  assert.equal(envCommentLines('uat')[0], ENV_COMMENT_LINES[0]);
  const first = planEnvUpdate({ text: '', ...INPUT, envName: 'uat' }).text;
  // Same file, different port: the trio is rewritten in place, nothing appended.
  const second = planEnvUpdate({
    text: first,
    ...INPUT,
    envName: 'uat',
    gatewayUrl: 'http://127.0.0.1:18791',
  }).text;
  assert.equal(second.split(ENV_COMMENT_LINES[0]).length - 1, 1);
});

test('SERVER_URL reads back the same way for either file', () => {
  assert.equal(serverUrlIn('SERVER_URL=https://ci.corp.example\n'), 'https://ci.corp.example');
  assert.equal(serverUrlIn('SERVER_URL=a\nSERVER_URL=b\n'), 'b', 'the line a run wins with');
  assert.equal(serverUrlIn(''), null);
});
