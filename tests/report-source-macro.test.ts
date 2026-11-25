import { describe, it, expect } from 'vitest';
import { renderStep } from '../src/report/generator.js';
import type { StepResult } from '../src/report/types.js';

function baseStep(): StepResult {
  return {
    index: 1,
    instruction: 'Type the username',
    status: 'passed',
    turns: [],
    durationMs: 120,
    retried: false,
  };
}

describe('renderStep — source-macro chip', () => {
  it('renders a `macro: <name>` chip when sourceMacro is set', () => {
    const html = renderStep({ ...baseStep(), sourceMacro: 'login' });
    expect(html).toContain('badge-macro');
    expect(html).toContain('login');
    // Tooltip mentions the macro provenance for screen-reader users.
    expect(html).toContain('Step expanded from macro login');
  });

  it('omits the chip when sourceMacro is unset', () => {
    const html = renderStep(baseStep());
    expect(html).not.toContain('badge-macro');
  });

  it('escapes the macro name to prevent HTML injection', () => {
    const html = renderStep({ ...baseStep(), sourceMacro: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

