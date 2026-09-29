/**
 * What a user's line selection means, once section bodies became runnable.
 *
 * Spec: steptix-vscode/stories/specs/sections-run-and-resume.md §4.1.
 * Contract: stories/test-script-sections-contract.md §4 (signature) and §5
 * (consumer split).
 *
 * The fixture's shape, for reading the line numbers below:
 *
 *     13, 17, 18   main flow
 *     ### Login    heading on 20, body steps 24, 25 (29 is inert — it sits
 *                  under `#### Notes with heading text` on 27)
 *     ### Cleanup  heading on 31, body step 33
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  classifySelectedSteps,
  resolveRunLines,
  resolveRunSelection,
  sectionBodyLinesAt,
} from '../dist/step-lines.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'sections',
);
const text = readFileSync(path.join(FIXTURES, 'classification.md'), 'utf-8');

const MAIN_FLOW = [13, 17, 18];
const LOGIN_BODY = [24, 25];
const CLEANUP_BODY = [33];

// ---------------------------------------------------------------------------
// resolveRunSelection — the five rungs
// ---------------------------------------------------------------------------

test('rung 1: an empty request is every main-flow step, never a body', () => {
  assert.deepEqual(resolveRunSelection(text, []), {
    scope: 'main-flow',
    lines: MAIN_FLOW,
  });
});

test('rung 2: selected main-flow lines resolve to themselves', () => {
  assert.deepEqual(resolveRunSelection(text, [17, 18]), {
    scope: 'main-flow',
    lines: [17, 18],
  });
});

test('rung 2 wins over rung 3: a mixed selection drops the body lines', () => {
  // Line 17 is the `Login` call; 24 and 25 are the body it expands into.
  // Running all three would execute the body twice — once inline, once at the
  // call site. This ordering is the guard against that, and it is also what
  // keeps every pre-sections selection behaving identically.
  assert.deepEqual(resolveRunSelection(text, [17, 24, 25]), {
    scope: 'main-flow',
    lines: [17],
  });
});

test('rung 2 wins even when the body lines outnumber the main-flow one', () => {
  assert.deepEqual(resolveRunSelection(text, [18, 24, 25, 33]), {
    scope: 'main-flow',
    lines: [18],
  });
});

test('rung 3: a body-only selection resolves to those body lines', () => {
  assert.deepEqual(resolveRunSelection(text, [24, 25]), {
    scope: 'section-body',
    lines: [24, 25],
  });
});

test('rung 3: one body line is a one-step run', () => {
  assert.deepEqual(resolveRunSelection(text, [25]), {
    scope: 'section-body',
    lines: [25],
  });
});

test('an inert line resolves to nothing — it is not addressable', () => {
  // Line 29 sits under `#### Notes with heading text` (contract §5 rule 4a).
  // It looks like a step and is not one, so it names no step in either scope
  // and no main-flow step sits below it. The empty resolution is what the
  // extension's STX025 guard turns into a refusal, which is why "Run Step Here"
  // on it sends nothing to the server.
  assert.deepEqual(resolveRunSelection(text, [29]), { scope: 'main-flow', lines: [] });
});

test('rung 3: body lines from two different sections keep document order', () => {
  assert.deepEqual(resolveRunSelection(text, [33, 25]), {
    scope: 'section-body',
    lines: [25, 33],
  });
});

test('rung 4: a line that names no step falls back to the steps below it', () => {
  // Line 15 is prose between two main-flow steps.
  assert.deepEqual(resolveRunSelection(text, [15]), {
    scope: 'main-flow',
    lines: [17, 18],
  });
});

test('rung 5: prose inside a body resolves to nothing at all', () => {
  // Line 22 is prose inside `### Login`. It is not a body STEP, so rung 3
  // does not fire, and no main-flow step sits below it — bodies are defined
  // under the main flow. The honest answer is "nothing", which the caller
  // turns into STX025 rather than into a whole-file run.
  assert.deepEqual(resolveRunSelection(text, [22]), {
    scope: 'main-flow',
    lines: [],
  });
});

test('a section heading line itself resolves to nothing', () => {
  assert.deepEqual(resolveRunSelection(text, [20]), {
    scope: 'main-flow',
    lines: [],
  });
});

// ---------------------------------------------------------------------------
// resolveRunLines — unchanged by all of the above
// ---------------------------------------------------------------------------

test('resolveRunLines is byte-identical on every selection shape', () => {
  const rows = [
    [[], MAIN_FLOW],
    [[17, 18], [17, 18]],
    [[17, 24, 25], [17]],
    [[24, 25], []],
    [[29], []],
    [[15], [17, 18]],
    [[22], []],
    [[20], []],
  ];
  for (const [requested, expected] of rows) {
    assert.deepEqual(
      resolveRunLines(text, requested),
      expected,
      `resolveRunLines(${JSON.stringify(requested)})`,
    );
  }
});

test('resolveRunLines never leaks a body line, whatever the scope', () => {
  const bodies = new Set([...LOGIN_BODY, ...CLEANUP_BODY]);
  for (const requested of [[], [24], [24, 25], [17, 24], [33]]) {
    for (const line of resolveRunLines(text, requested)) {
      assert.equal(bodies.has(line), false, `body line ${line} leaked into runLines`);
    }
  }
});

// ---------------------------------------------------------------------------
// classifySelectedSteps — scope argument
// ---------------------------------------------------------------------------

test('classifySelectedSteps defaults to main-flow, so a body line selects nothing', () => {
  assert.deepEqual(classifySelectedSteps(text, [24]), []);
});

test('classifySelectedSteps in section-body scope selects the body step', () => {
  const classified = classifySelectedSteps(text, [24, 25], 'section-body');
  assert.deepEqual(
    classified.map((s) => s.line),
    [24, 25],
  );
  assert.deepEqual(
    classified.map((s) => s.instruction),
    ['Type the username', 'Click Sign in'],
  );
});

test('classifySelectedSteps in section-body scope with no request takes every body', () => {
  const classified = classifySelectedSteps(text, [], 'section-body');
  assert.deepEqual(
    classified.map((s) => s.line),
    [...LOGIN_BODY, ...CLEANUP_BODY],
  );
});

test('body steps carrying [input:] / [interactive] classify like main-flow ones', () => {
  const doc = [
    '## Steps',
    '1. Sign in',
    '',
    '### Sign in',
    '',
    '1. [input: token] Paste the OTP',
    '2. [interactive] Poke around',
    '3. Press submit',
  ].join('\n');

  const classified = classifySelectedSteps(doc, [6, 7, 8], 'section-body');
  assert.deepEqual(
    classified.map((s) => s.kind),
    ['input', 'interactive', 'step'],
  );
  assert.equal(classified[0].varName, 'token');
  assert.equal(classified[0].prompt, 'Paste the OTP');
  assert.equal(classified[1].hint, 'Poke around');
});

// ---------------------------------------------------------------------------
// sectionBodyLinesAt — the resume anchor's snap candidates
// ---------------------------------------------------------------------------

test('sectionBodyLinesAt answers with the containing section body', () => {
  assert.deepEqual(sectionBodyLinesAt(text, 24), LOGIN_BODY);
  assert.deepEqual(sectionBodyLinesAt(text, 29), LOGIN_BODY);
  assert.deepEqual(sectionBodyLinesAt(text, 33), CLEANUP_BODY);
});

test('sectionBodyLinesAt spans heading-to-heading, not step-to-step', () => {
  // The heading itself, the blank line under it, the prose inside the body,
  // and the inert `#### Notes` heading all answer with the same section —
  // which is what lets a resume anchor whose own step was just deleted still
  // find its siblings.
  for (const line of [20, 21, 22, 26, 27, 30]) {
    assert.deepEqual(sectionBodyLinesAt(text, line), LOGIN_BODY, `line ${line}`);
  }
});

test('sectionBodyLinesAt is empty above the first section', () => {
  for (const line of [1, 12, 13, 18, 19]) {
    assert.deepEqual(sectionBodyLinesAt(text, line), [], `line ${line}`);
  }
});

test('sectionBodyLinesAt is empty for a file with no sections', () => {
  assert.deepEqual(sectionBodyLinesAt('## Steps\n1. Go\n', 2), []);
});
