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
