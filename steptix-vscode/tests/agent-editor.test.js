/**
 * The editor's half of `[use agent]` (docs/specs/SPEC-use-agent.md §5.6,
 * §5.7, §6.3): the marks and their hover, the squiggles for the block rules,
 * the Allow/Deny choices, and the wire scope a batch sends.
 *
 * What the scope IS is pinned at the repo root (tests/agent-scope.test.ts),
 * where both copies of `agentScopeOf` can be imported. This file pins that the
 * editor surfaces reach it.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { agentScopeOf, agentWireFor } from 'steptix-runner-core';
import { computeSectionDiagnostics } from '../src/extension/section-diagnostics-core.ts';
import { agentMarkHover, agentOptedOutHover } from '../src/extension/agent-marks-core.ts';
import { approvalChoices, approvalTitle } from '../src/extension/agent-approval-core.ts';

const doc = (...lines) => lines.join('\n');

const SECTION = doc(
  '# T',
  '## Steps',
  '1. Export the ledger',
  '',
  '### Export the ledger',
  '1. [use agent]',
  '2. Open the export wizard',
  '3. [no-agent] Verify the wizard closed',
);

test('the marks come from agentScopeOf and say why', () => {
  const scope = agentScopeOf(SECTION);
  assert.deepEqual(scope.steps.map((s) => s.line), [7]);
  assert.match(agentMarkHover(scope.steps[0]), /section "Export the ledger" opens with \[use agent\]/);
  assert.deepEqual(scope.optedOut, [8]);
  assert.match(agentOptedOutHover(), /\[no-agent\]/);
});

test('a bare [use agent] below the first step is squiggled as an error', () => {
  const text = doc('# T', '## Steps', '1. Click Save', '2. [use agent]');
  const errors = computeSectionDiagnostics(text).filter((d) => d.severity === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 3);
  assert.match(errors[0].message, /must be the first step of its block/);
});

test('a [no-agent] outside any scope is a warning', () => {
  const text = doc('# T', '## Steps', '1. [no-agent] Click Save');
  const warnings = computeSectionDiagnostics(text).filter((d) => /no-agent/.test(d.message));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].severity, 'warning');
});

test('the wire scope names positions by line, so Run From Here keeps it', () => {
  const text = doc('# T', '## Steps', '1. [use agent]', '2. Close the panel', '3. Click Save');
  assert.deepEqual(agentWireFor(text, [3, 4, 5]), { steps: [1, 2] });
  assert.deepEqual(agentWireFor(text, [5]), { steps: [0] });
  assert.equal(agentWireFor(doc('# T', '## Steps', '1. Click Save'), [3]), undefined);
});

test('the question offers four answers, the pattern named in the run-long two', () => {
  const choices = approvalChoices('pip install *');
  assert.deepEqual(
    choices.map((c) => c.answer),
    ['allow-once', 'allow-run', 'deny-once', 'deny-run'],
  );
  assert.equal(choices[1].label, 'Allow "pip install *" for the rest of this run');
  assert.equal(approvalTitle(52), 'Steptix agent wants to run a command (52 s)');
  assert.equal(approvalTitle(-3), 'Steptix agent wants to run a command (0 s)');
});

test('a Run refuses what the CLI parser refuses, before anything is sent', async () => {
  const { preflightSections } = await import('../src/extension/sections.ts');
  assert.match(
    preflightSections(doc('# T', '## Steps', '1. Click Save', '2. [use agent]')),
    /^Line 4: .*first step of its block/,
  );
  assert.match(
    preflightSections(doc('# T', '## Steps', '1. [no-agent] [no-hooks] Click Save')),
    /^Line 3: .*goes after `\[no-hooks\]`/,
  );
  assert.equal(preflightSections(doc('# T', '## Steps', '1. [use agent]', '2. Click Save')), null);
});

test('[no-agent] misuse is squiggled as an error', () => {
  const errors = computeSectionDiagnostics(doc('# T', '## Steps', '1. [no-agent] [use agent] Export')).filter(
    (d) => d.severity === 'error',
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /cannot mark a `\[use agent\]` step/);
});
