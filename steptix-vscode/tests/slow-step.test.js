/**
 * An install that is slow (docs/specs/SPEC-install.md §5.2): no time limit,
 * but a step that has not moved on for three minutes gets a hint. The timer
 * is a fake that fires when the test says, so nothing here waits.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { SLOW_STEP_HINT, SLOW_STEP_MS, SlowStepWatch, slowStepMessage } from '../src/extension/slow-step.ts';

/** A timer that only fires on `fire()`, and says what is set. */
function fakeTimer() {
  let next = 1;
  const set = new Map();
  return {
    timer: {
      set: (fn, ms) => {
        const handle = next++;
        set.set(handle, { fn, ms });
        return handle;
      },
      clear: (handle) => set.delete(handle),
    },
    set,
    fire() {
      for (const [handle, { fn }] of [...set]) {
        set.delete(handle);
        fn();
      }
    },
  };
}

function watch() {
  const shown = [];
  const t = fakeTimer();
  return { shown, t, steps: new SlowStepWatch((message) => shown.push(message), t.timer) };
}

test('the hint is in the spec\'s words, after three minutes', () => {
  assert.equal(SLOW_STEP_MS, 3 * 60 * 1000);
  assert.equal(
    SLOW_STEP_HINT,
    'This is taking longer than usual. If your company uses a proxy or its own npm registry, check that npm works in a terminal (npm view steptix).',
  );
  assert.equal(slowStepMessage('Downloading Node.js'), `Downloading Node.js… ${SLOW_STEP_HINT}`);
  assert.equal(slowStepMessage('Installing Steptix 1.4.2…'), `Installing Steptix 1.4.2… ${SLOW_STEP_HINT}`);
});

test('a step shows as it starts, and the hint only once it has gone three minutes without moving on', () => {
  const { shown, t, steps } = watch();
  steps.step('Downloading steptix 1.4.2');
  assert.deepEqual(shown, ['Downloading steptix 1.4.2']);
  assert.deepEqual([...t.set.values()].map((s) => s.ms), [SLOW_STEP_MS]);

  t.fire();
  assert.deepEqual(shown, ['Downloading steptix 1.4.2', slowStepMessage('Downloading steptix 1.4.2')]);
});

test('the next step replaces the hint and starts the wait again', () => {
  const { shown, t, steps } = watch();
  steps.step('Downloading Node.js');
  t.fire();
  steps.step('Downloading steptix 1.4.2');
  assert.equal(shown.at(-1), 'Downloading steptix 1.4.2', 'the hint went with the step it was about');
  assert.equal(t.set.size, 1, 'one wait, for the new step');

  steps.step('Setting up the Steptix server');
  assert.equal(t.set.size, 1, "the previous step's wait was cleared");
  t.fire();
  assert.equal(shown.at(-1), slowStepMessage('Setting up the Steptix server'));
});

test('the same step again has not moved on, so its wait goes on', () => {
  const { shown, t, steps } = watch();
  steps.step('Downloading Node.js');
  const [handle] = t.set.keys();
  steps.step('Downloading Node.js');
  assert.deepEqual(shown, ['Downloading Node.js']);
  assert.deepEqual([...t.set.keys()], [handle]);
});

test('no hint comes once the install has ended', () => {
  const { shown, t, steps } = watch();
  steps.step('Downloading steptix 1.4.2');
  steps.dispose();
  assert.equal(t.set.size, 0);
  t.fire();
  assert.deepEqual(shown, ['Downloading steptix 1.4.2']);
});
