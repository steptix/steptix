import { describe, it, expect } from 'vitest';
import { renderStep } from '../src/report/generator.js';
import type { StepResult } from '../src/report/types.js';

/**
 * Report provenance for inline sections. The section chip is one of the three
 * mitigations for bare-name invocation being silent: a resolved call's steps
 * are visibly badged, an unresolved one's are not.
 */

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

describe('renderStep — section chip', () => {
  it('renders a `section: <name>` chip when sourceSection is set', () => {
    const html = renderStep({ ...baseStep(), sourceSection: 'Sign in' });
    expect(html).toContain('badge-section');
    expect(html).toContain('Sign in');
  });

  it('omits the chip when sourceSection is absent', () => {
    expect(renderStep(baseStep())).not.toContain('badge-section');
  });

  it('renders both chips for a skill invoked from inside a section', () => {
    // The two are additive, not exclusive — this is the case the demo fixture
    // produces for every skill-body step.
    const html = renderStep({
      ...baseStep(),
      sourceSection: 'Sign in',
      sourceSkill: 'fill_login_form',
    });
    expect(html).toContain('badge-section');
    expect(html).toContain('badge-skill');
    expect(html).toContain('Sign in');
    expect(html).toContain('fill_login_form');
  });

  it('escapes the section name', () => {
    const html = renderStep({ ...baseStep(), sourceSection: '<img src=x>' });
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;img src=x&gt;');
  });

  it('uses a class distinct from badge-skill (the prefix is baked into CSS)', () => {
    const html = renderStep({ ...baseStep(), sourceSection: 'Sign in' });
    // `.badge-skill::before { content: 'skill: ' }` would mislabel a section.
    expect(html).toMatch(/class="badge badge-section"/);
  });
});
