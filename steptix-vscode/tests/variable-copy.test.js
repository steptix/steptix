/**
 * What Copy on a variable puts on the clipboard and says in the status bar —
 * one rule for the Variables view's commands and the Test Runner panel's
 * Variables menu (variable-copy-core.ts).
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  placeholderFor,
  variableCopy,
  variablesCsv,
  variablesCsvFileName,
} from '../src/extension/variable-copy-core.ts';

// ---------------------------------------------------------------------------
// Value
// ---------------------------------------------------------------------------

test('value: copies the raw value', () => {
  assert.deepEqual(variableCopy('value', { name: 'username', value: 'alice' }), {
    ok: true,
    text: 'alice',
    status: 'Steptix: copied the value of username',
  });
});

test('value: a masked row copies the real value and says it was unmasked', () => {
  // The mask keeps a credential off the screen; stars on the clipboard would
  // be no use, so the copy is the real value — and the status bar says so.
  const got = variableCopy('value', { name: 'password', value: 'variable-copy-test-password', masked: true });
  assert.equal(got.ok, true);
  assert.equal(got.text, 'variable-copy-test-password');
  assert.equal(got.status, 'Steptix: copied the unmasked value of password');
});

test('value: an empty value copies, and the status says it was empty', () => {
  const got = variableCopy('value', { name: 'note', value: '' });
  assert.equal(got.ok, true);
  assert.equal(got.text, '');
  assert.equal(got.status, 'Steptix: copied the value of note (empty)');
});

test('value: a row with no value yet copies nothing', () => {
  // The panel lists a declared `[output: x]` before anything captures it.
  assert.deepEqual(variableCopy('value', { name: 'orderId' }), {
    ok: false,
    status: 'Steptix: orderId has no value yet',
  });
});

test('value: multi-line values copy whole', () => {
  const table = '[{"id":"1"},\n{"id":"2"}]';
  assert.equal(variableCopy('value', { name: 'rows', value: table }).text, table);
});

// ---------------------------------------------------------------------------
// Name
// ---------------------------------------------------------------------------

test('name: copies the name as the row shows it, value or not', () => {
  assert.deepEqual(variableCopy('name', { name: 'payment.reference' }), {
    ok: true,
    text: 'payment.reference',
    status: 'Steptix: copied the name payment.reference',
  });
});

// ---------------------------------------------------------------------------
// Placeholder
// ---------------------------------------------------------------------------

test('placeholder: wraps the name in {{…}}', () => {
  assert.deepEqual(variableCopy('placeholder', { name: 'username', value: 'alice' }), {
    ok: true,
    text: '{{username}}',
    status: 'Steptix: copied {{username}}',
  });
});

test('placeholder: a record property keeps its one dot', () => {
  assert.equal(placeholderFor('payment.reference'), '{{payment.reference}}');
  assert.equal(placeholderFor('payment._row'), '{{payment._row}}');
});

test('placeholder: a skill local drops the expander prefix the skill file never wrote', () => {
  assert.equal(placeholderFor('__skill2_query'), '{{query}}');
  assert.equal(placeholderFor('__skill12_order.id'), '{{order.id}}');
});

test('placeholder: a name the runtime grammar cannot reference has none', () => {
  // Typed into the page as text rather than resolved, so refuse instead.
  for (const name of ['order.Order ID', 'order.content-type', 'order.address.city', 'two words', '']) {
    assert.equal(placeholderFor(name), null, name);
  }
  assert.deepEqual(variableCopy('placeholder', { name: 'order.Order ID', value: 'A-1' }), {
    ok: false,
    status: 'Steptix: order.Order ID cannot be written as a {{placeholder}}',
  });
});

test('placeholder: a root that starts with a digit still resolves', () => {
  // The root is `\w+` — `{{1st}}` has always resolved (PARAM_REF_RE).
  assert.equal(placeholderFor('1st'), '{{1st}}');
});

// ---------------------------------------------------------------------------
// Export as CSV
// ---------------------------------------------------------------------------

const BOM = '\uFEFF';

test('csv: a name,value header, CRLF line ends, a UTF-8 BOM for Excel', () => {
  assert.equal(
    variablesCsv([
      { name: 'username', value: 'alice' },
      { name: 'orderId', value: 'ORD-1042' },
    ]),
    `${BOM}name,value\r\nusername,alice\r\norderId,ORD-1042\r\n`,
  );
});

test('csv: no rows is the header alone', () => {
  assert.equal(variablesCsv([]), `${BOM}name,value\r\n`);
});

test('csv: commas, quotes and line breaks are quoted, quotes doubled', () => {
  const csv = variablesCsv([
    { name: 'address', value: '1 Main St, Sydney' },
    { name: 'quote', value: 'she said "hi"' },
    { name: 'note', value: 'line one\nline two' },
    { name: 'blank', value: '' },
  ]);
  assert.equal(
    csv,
    `${BOM}name,value\r\n` +
      'address,"1 Main St, Sydney"\r\n' +
      'quote,"she said ""hi"""\r\n' +
      'note,"line one\nline two"\r\n' +
      'blank,\r\n',
  );
});

test('csv: a whole JSON table stays one field and reads back unchanged', () => {
  const table = JSON.stringify([
    { _row: 1, payee: 'Origin Energy', amount: '$140.00' },
    { _row: 2, payee: 'Sydney Water, Ltd', amount: '$86.10' },
  ]);
  const csv = variablesCsv([{ name: 'payments', value: table }]);
  // Undo the one quoting rule to read the field back.
  const field = csv.slice(`${BOM}name,value\r\npayments,`.length, -'\r\n'.length);
  assert.equal(field.startsWith('"') && field.endsWith('"'), true);
  assert.deepEqual(JSON.parse(field.slice(1, -1).replace(/""/g, '"')), JSON.parse(table));
});

test('csv: writes the value it is given — masking is the caller showing it', () => {
  // The views pass what they SHOW; a masked row arrives as its stars.
  assert.equal(
    variablesCsv([{ name: 'password', value: '*******' }]),
    `${BOM}name,value\r\npassword,*******\r\n`,
  );
});

test('csv file name: the test file with -variables.csv', () => {
  assert.equal(variablesCsvFileName('/c:/tests/login.md'), 'login-variables.csv');
  assert.equal(variablesCsvFileName('C:\\tests\\Checkout Flow.MD'), 'Checkout Flow-variables.csv');
  assert.equal(variablesCsvFileName(null), 'steptix-variables.csv');
});
