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

describe('renderStep — source-skill chip', () => {
  it('renders a `skill: <name>` chip when sourceSkill is set', () => {
    const html = renderStep({ ...baseStep(), sourceSkill: 'login' });
    expect(html).toContain('badge-skill');
    expect(html).toContain('login');
    // Tooltip mentions the skill provenance for screen-reader users.
    expect(html).toContain('Step expanded from skill login');
  });

  it('omits the chip when sourceSkill is unset', () => {
    const html = renderStep(baseStep());
    expect(html).not.toContain('badge-skill');
  });

  it('escapes the skill name to prevent HTML injection', () => {
    const html = renderStep({ ...baseStep(), sourceSkill: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

