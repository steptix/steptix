import { describe, it, expect } from 'vitest';
import { renderStep } from '../src/report/generator.js';
import type { StepResult } from '../src/report/types.js';

function baseStep(): StepResult {
  return {
    index: 1,
    instruction: 'Extract the total available in $ amount',
    status: 'passed',
    turns: [],
    durationMs: 120,
    retried: false,
  };
}

describe('renderStep — captured variables (issue 042)', () => {
  it('renders a Captured block with the variable name and value', () => {
    const html = renderStep({ ...baseStep(), outputs: { total_available: '37.76' } });
    expect(html).toContain('captures-block');
    expect(html).toContain('Captured');
    expect(html).toContain('total_available');
    expect(html).toContain('37.76');
  });

  it('renders every captured variable when a step captures more than one', () => {
    const html = renderStep({
      ...baseStep(),
      outputs: { firstName: 'Alice', lastName: 'Smith' },
    });
    expect(html).toContain('firstName');
    expect(html).toContain('Alice');
    expect(html).toContain('lastName');
    expect(html).toContain('Smith');
  });

  it('omits the Captured block entirely when outputs is unset', () => {
    const html = renderStep(baseStep());
    expect(html).not.toContain('captures-block');
    expect(html).not.toContain('Captured');
  });

  it('omits the Captured block entirely when outputs is an empty object', () => {
    const html = renderStep({ ...baseStep(), outputs: {} });
    expect(html).not.toContain('captures-block');
  });

  it('escapes HTML in captured names and values to prevent injection', () => {
    const html = renderStep({
      ...baseStep(),
      outputs: { '<script>alert(1)</script>': '<img src=x onerror=alert(2)>' },
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x');
  });

  it('suppresses the green Captured block on a tool step, even when outputs is set (issue 043 review)', () => {
    // A `[output: x] [tool: t out.x="y"]` step: the same value is aliased
    // into both toolStep.outputs (purple) and the general outputs (green).
    // Only the tool section should render — a second box would just repeat it.
    const html = renderStep({
      ...baseStep(),
      outputs: { x: 'y' },
      toolStep: { name: 't', args: {}, outputs: { x: 'y' }, logs: [] },
    });
    expect(html).not.toContain('captures-block');
    expect(html).toContain('tool-block');
  });
});


// ── §7.10's report line (SPEC-structured-table-reads.md, "Log and report") ──
//
// A `readTable` the runtime had to ask the model about reads exactly like a
// structural one in the records, and the mapping it used rides in the step
// cache from then on. Without this line a report of a run over an odd grid
// shows a read that "just worked" — and a stale cached mapping is invisible
// after the fact, which is the one thing a reader needs when the values look
// wrong.
describe('renderStep — the structure a readTable was read with', () => {
  function stepWithAction(action: Record<string, unknown>): StepResult {
    return {
      ...baseStep(),
      turns: [{
        turnNumber: 1,
        attemptNumber: 1,
        timestamp: '2026-09-23T00:00:00.000Z',
        aiInteractions: [],
        subActions: [{
          index: 1,
          action: {
            action: 'readTable',
            description: 'Read the payees table',
            selector: '#legacy-payees',
            ...action,
          },
          durationMs: 7,
        }],
      }],
    } as unknown as StepResult;
  }

  it('renders a table mapping as the shape, not as JSON', () => {
    const html = renderStep(stepWithAction({
      mapping: {
        kind: 'table',
        rows: '#late-header-rows',
        header: { selector: '#late-header-head', bodyRow: 1 },
      },
    }));
    expect(html).toContain('structure (table)');
    expect(html).toContain('rows: #late-header-rows');
    expect(html).toContain('header: #late-header-head (body row 1)');
  });

  it('leaves the body row out when the header has none', () => {
    const html = renderStep(stepWithAction({
      mapping: { kind: 'table', rows: '#rows', header: { selector: '#head' } },
    }));
    expect(html).toContain('header: #head');
    expect(html).not.toContain('body row');
  });

  it('renders a collection mapping as the item and one line per field', () => {
    const html = renderStep(stepWithAction({
      mapping: {
        kind: 'collection',
        item: '.account-card',
        fields: { account: '.card-title', balance: '.field:nth-child(1) .value' },
      },
    }));
    expect(html).toContain('structure (collection)');
    expect(html).toContain('item: .account-card');
    expect(html).toContain('account: .card-title');
    expect(html).toContain('balance: .field:nth-child(1) .value');
  });

  it('renders nothing at all for an ordinary read', () => {
    // A report of a run that met no odd grid is byte-identical to one written
    // before this existed.
    expect(renderStep(stepWithAction({}))).not.toContain('structure (');
  });

  it('escapes a selector rather than putting it into the page as markup', () => {
    const html = renderStep(stepWithAction({
      mapping: { kind: 'table', rows: '<img src=x onerror=alert(1)>' },
    }));
    expect(html).not.toContain('<img src=x onerror');
    expect(html).toContain('&lt;img src=x');
  });
});
