/**
 * Prompt-string regression for `readTable`
 * (docs/specs/SPEC-structured-table-reads.md §6.3, last paragraph).
 *
 * The action type, the column shape and the runtime are all typed, so a
 * refactor that deletes the prompt rule still compiles and every unit test
 * still passes — and the model then never emits `readTable` at all. These
 * assertions are the only thing standing between that and a silent
 * regression to three parallel plural reads.
 *
 * They check vocabulary and shape, not wording: each needle is a phrase the
 * rule cannot lose without losing its meaning.
 */
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, contentBlocksToText } from '../src/ai/prompts.js';

/** The whole system prompt as the model reads it. */
function systemPromptText(): string {
  return contentBlocksToText(buildSystemPrompt(''));
}

describe('step prompt — readTable rule', () => {
  const prompt = systemPromptText();

  it('names the action and says when to choose it over parallel plural reads', () => {
    expect(prompt).toContain('"readTable"');
    expect(prompt).toContain('TWO OR MORE named columns');
    expect(prompt).toContain('parallel arrays');
    // The other half of the choice: one flat column stays a `read multiple`.
    expect(prompt).toMatch(/ONE flat column/);
  });

  it('carries the canonical header-named JSON example from §6.1', () => {
    expect(prompt).toContain('"action": "readTable"');
    expect(prompt).toContain('"columns": [ { "header": "Order ID", "key": "id" }');
    expect(prompt).toContain('"as": "orders"');
  });

  it('carries the positional-column example, with index and no header', () => {
    expect(prompt).toContain('"columns": [ { "index": 1, "key": "payee" }');
    expect(prompt).toContain('the 1st column as payee');
    expect(prompt).toContain('Never emit both "header" and "index" for one column');
    expect(prompt).toContain('needs an explicit alias');
  });

  it('carries the SPLIT GRIDS clause, after the positional rule it overrides (§6.3)', () => {
    // §12.25. Without this clause the model does the reasonable thing with a
    // Kendo grid — sees a row table with no `<th>` in it and switches to
    // `index` — and a release that reorders the columns then reads the wrong
    // ones, silently. The three vendor names are how it recognises the markup
    // in the first place.
    expect(prompt).toContain('SPLIT GRIDS.');
    expect(prompt).toMatch(/Telerik\/Kendo, DevExpress and Syncfusion/);
    expect(prompt).toContain('"selector": "#orders-grid"');
    expect(prompt).toMatch(/NEVER select the table that holds only the header/);
    expect(prompt).toMatch(/Do NOT switch to "index" because the row table shows no <th>/);
    // It overrides the positional clause, so it has to come after it — and
    // before the bound, where the rest of the read vocabulary lives.
    expect(prompt.indexOf('COLUMNS BY POSITION.')).toBeLessThan(prompt.indexOf('SPLIT GRIDS.'));
    expect(prompt.indexOf('SPLIT GRIDS.')).toBeLessThan(prompt.indexOf('BOUNDED ROWS.'));
  });

  it('names RadGrid in SPLIT GRIDS as the three-table form (§5.7)', () => {
    // The box holds a header table, the row table AND a pager table, so the
    // "two tables" wording above does not describe what the model is looking
    // at — measured, the extractor saw three tables with rows before §7.2
    // counted DATA rows.
    expect(prompt).toMatch(/Telerik RadGrid \(ASP\.NET AJAX\) is the THREE-table form/);
    expect(prompt).toMatch(/a header table, the row table and a pager table inside one box/);
  });

  it('carries the BANDED HEADERS clause, after SPLIT GRIDS (§6.3, §12.28)', () => {
    // Without it the model copies the band ("GENERAL INFORMATION") or a
    // filter's current value ("All") as a column name, and the read is refused
    // for a reason the author cannot see in the step they wrote.
    expect(prompt).toContain('BANDED HEADERS.');
    expect(prompt).toMatch(/names each column by the LOWEST heading over it/);
    expect(prompt).toMatch(/A filter row of inputs and selects inside the header names nothing/);
    expect(prompt).toContain('{ "header": "Q1 > Fee", "key": "q1_fee" }');
    expect(prompt.indexOf('SPLIT GRIDS.')).toBeLessThan(prompt.indexOf('BANDED HEADERS.'));
    expect(prompt.indexOf('BANDED HEADERS.')).toBeLessThan(prompt.indexOf('BOUNDED ROWS.'));
  });

  it('says what "row 7" means and how to address it, beside the placeholder rule', () => {
    // §12.28, rewritten after the live run: the clause has to cover the
    // LITERAL form the model sees once the placeholder is gone — "row 7 of the
    // Loan applications grid" — because that is what it read on pass 7 before
    // it counted the rows itself and built `#RadGrid1_ctl00__7`, clicking row
    // 8 and passing green. The row number is not arithmetic on an id: the read
    // leaves `data-steptix-row` on the page and the selector uses that.
    expect(prompt).toContain('ROW IDS.');
    expect(prompt).toMatch(/means the SEVENTH DATA row of that table, counting from 1/);
    expect(prompt).toMatch(
      /Header rows, a filter row, hidden rows and an expanded detail row are not data rows/,
    );
    expect(prompt).toContain('carries data-steptix-row="N"');
    expect(prompt).toContain('the row matching [data-steptix-row="7"] INSIDE that table');
    expect(prompt).toContain('"#grid_row_7" is row EIGHT');
    // SCOPING is in the prose, not only in the example. Every read of this run
    // leaves the same attribute on ITS table, so a selector that is just
    // `[data-steptix-row="7"]` matches row 7 of the first table in the page —
    // shown once in an example, the model wrote the bare attribute.
    expect(prompt).toContain(
      'the selector is ALWAYS the TABLE\'s own selector followed by [data-steptix-row="N"]',
    );
    expect(prompt).toContain(
      'NEVER write the attribute on its own: it matches a row in EVERY table read this run',
    );
    expect(prompt).toMatch(/NEVER use "tr:nth-child\(7\)" either/);
    // And what to do when the attribute is not there — an unread or
    // re-rendered table — so the rule never leaves the model stuck.
    expect(prompt).toMatch(/count the data rows in the snapshot yourself/);
    // Beside 8a, and well before the table-reading rule it is the consequence
    // of — a rule the model reads only when it is planning the read itself.
    const clause = 'ROW IDS.';
    expect(prompt.indexOf(clause)).toBeLessThan(prompt.indexOf('13d. READING A TABLE'));
    expect(prompt.indexOf('8a. PLACEHOLDERS')).toBeLessThan(prompt.indexOf(clause));
  });

  it('carries the bounded-window example and its limit restrictions', () => {
    expect(prompt).toContain('"limit": 10');
    expect(prompt).toContain('nth-child(-n+10)');
    expect(prompt).toMatch(/pagination, scrolling, last N, a starting row, a range/);
  });

  it('says what _row counts, and that the model must never request it', () => {
    expect(prompt).toContain('Never request "_row" as a column');
    expect(prompt).toContain('count DATA rows');
    // The distinction the plain case hides: hidden and placeholder rows take
    // no row number, so "row 3" is the third row that holds data.
    expect(prompt).toMatch(/skips hidden rows and full-width placeholder or group rows/);
  });

  it('teaches the alias derivation rule and forbids inventing columns', () => {
    expect(prompt).toContain('"Order ID" → "order_id"');
    expect(prompt).toContain('"Last updated (UTC)" → "last_updated_utc"');
    expect(prompt).toContain('Copy header text EXACTLY');
    expect(prompt).toMatch(/never add a checkbox, action or hidden column/i);
    expect(prompt).toContain('Never calculate nth-child() selectors for columns');
  });

  it('tells the model to ask rather than guess, and to complete the read', () => {
    expect(prompt).toContain('names no columns, return a "prompt"');
    expect(prompt).toMatch(/Set "needs_reeval": false/);
  });

  it('refuses the phase-2 wording by name instead of reading it as text', () => {
    expect(prompt).toMatch(/checkbox's ticked state, an input's value or an attribute is not supported yet/);
  });

  // The one cache check this file keeps: ROW IDS, SPLIT GRIDS and 13d are all
  // in the single rules template (prompts.ts), whose block prompts-cache.test.ts
  // pins as cacheable, so a check per clause would find the same block again.
  it('keeps the rule inside the cacheable rules block, beside the read rules', () => {
    const blocks = buildSystemPrompt('');
    const rules = blocks.find(
      (b) => b.type === 'text' && b.text.includes('13d. READING A TABLE INTO ROW RECORDS'),
    );
    expect(rules, 'the readTable rule should live in the rules block').toBeDefined();
    expect(rules && 'cache' in rules ? rules.cache : false).toBe(true);
    // Ordering matters only in that it sits with the capture rules it is the
    // structured sibling of, before "count".
    const text = rules!.type === 'text' ? rules!.text : '';
    expect(text.indexOf('13a. CAPTURING A LIST')).toBeLessThan(text.indexOf('13d. READING A TABLE'));
    expect(text.indexOf('13d. READING A TABLE')).toBeLessThan(text.indexOf('14. For "count" actions'));
  });
});
