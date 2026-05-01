import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { parseTestFile } from '../src/parser/markdown.js';
import { clearSkillCache } from '../src/skills/expander.js';

/**
 * Integration test for the skill-call shorthand syntax. Exercises the full
 * parser → expander pipeline against real fixtures on disk
 * (`fixtures/skills/fill_login_form.md` invoked from
 * `fixtures/tests/skill-shorthand-demo.md`).
 *
 * Verifies that a `[skill: name p1 p2 out.o1]` shorthand call is expanded
 * exactly the same as the canonical `[skill: name p1="{{p1}}" p2="{{p2}}" out.o1="o1"]`
 * form would be.
 */

const repoRoot = path.resolve(__dirname, '..');
const skillsDir = path.join(repoRoot, 'fixtures', 'skills');
const demoFile = path.join(repoRoot, 'fixtures', 'tests', 'skill-shorthand-demo.md');

beforeEach(() => {
  clearSkillCache();
});

describe('skill shorthand — end-to-end through parseTestFile', () => {
  it('expands the demo fixture into a flat step list with placeholders preserved', async () => {
    const parsed = await parseTestFile(demoFile, { skillsDir });

    expect(parsed.steps).toEqual([
      'Navigate to {{baseUrl}}/login',
      'Type "{{username}}" into the username field',
      'Type "{{password}}" into the password field',
      'Click the Sign in button and verify the dashboard loads',
      'Capture the visible text of the welcome banner [store as: welcome_text]',
      'Verify the welcome banner reads "{{welcome_text}}"',
    ]);
  });

  it('produces the same expansion as the explicit long form', async () => {
    const shorthand = await parseTestFile(demoFile, { skillsDir });

    // Build a synthetic "explicit" copy of the demo using the long form, parse
    // it the same way, and confirm the two expansions match.
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shorthand-eq-'));
    try {
      const explicit = `---
tags: [smoke, skills]
---

# Skill shorthand demo (explicit form)

## Parameters
- username: $LOGIN_USERNAME
- password: $LOGIN_PASSWORD

## Steps
1. Navigate to {{baseUrl}}/login
2. [skill: fill_login_form username="{{username}}" password="{{password}}" out.welcome_text="welcome_text"]
3. Verify the welcome banner reads "{{welcome_text}}"
`;
      const explicitPath = path.join(tmpDir, 'explicit.md');
      await fs.writeFile(explicitPath, explicit);

      const explicitParsed = await parseTestFile(explicitPath, { skillsDir });
      expect(shorthand.steps).toEqual(explicitParsed.steps);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
