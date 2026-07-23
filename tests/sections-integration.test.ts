import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parseTestContent, parseTestFile } from '../src/parser/markdown.js';
import { clearSkillCache, expandSkills } from '../src/skills/expander.js';

/**
 * End-to-end parse of a section+skill integration fixture: a section invoked
 * twice whose body itself calls a skill. Exercises the whole chain — capture,
 * resolution, expansion, frames, origins and both provenance tags — against a
 * real file on disk rather than an inline string.
 *
 * This is the rich internal fixture. The self-contained file that `aiui init`
 * ships to users is a *different* file (no skill dependency); it is guarded
 * separately in the final `describe` block below so it can't silently drift.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = path.join(repoRoot, 'fixtures', 'skills');
const demoFile = path.join(repoRoot, 'fixtures', 'tests', 'sections-demo.md');
const shippedDemoFile = path.join(repoRoot, 'templates', 'init', 'tests', 'sections-demo.md');

beforeEach(() => {
  clearSkillCache();
});

describe('fixtures/tests/sections-demo.md', () => {
  it('expands the section at both call sites, skill body included', async () => {
    const parsed = await parseTestFile(demoFile, { skillsDir });

    const signInBody = [
      'Type "{{username}}" into the username field',
      'Type "{{password}}" into the password field',
      'Click the Sign in button and verify the dashboard loads',
      'Capture the visible text of the welcome banner [store as: welcome_text]',
      'Verify the dashboard greeting is visible',
    ];

    expect(parsed.steps).toEqual([
      'Open the demo app',
      ...signInBody,
      'Add the first product to the cart',
      ...signInBody,
      'Verify the order confirmation shows "Thank you"',
    ]);
  });

  it('captures the section without leaving it in the main flow', async () => {
    const parsed = await parseTestFile(demoFile, { skillsDir });
    expect(Object.keys(parsed.sections)).toEqual(['sign in']);
    expect(parsed.sections['sign in']!.name).toBe('Sign in');
    expect(parsed.sections['sign in']!.steps).toHaveLength(2);
  });

  it('tags skill-expanded body steps with both a section and a skill', async () => {
    const parsed = await parseTestFile(demoFile, { skillsDir });

    // Main-flow steps carry neither tag.
    expect(parsed.sourceSections[0]).toBeNull();
    expect(parsed.sourceSkills[0]).toBeNull();

    // Steps 1-4 of the body come from the skill, invoked from the section.
    expect(parsed.sourceSections[1]).toBe('Sign in');
    expect(parsed.sourceSkills[1]).toBe('fill_login_form');

    // The body's own last step is the section's, not the skill's.
    expect(parsed.sourceSections[5]).toBe('Sign in');
    expect(parsed.sourceSkills[5]).toBeNull();
  });

  it('mints a distinct frame per invocation, with the skill nested in the section', async () => {
    // parseTestFile keeps only the flattened result, so drive the expander
    // directly to inspect frames. Parse without expanding — note that
    // `parseTestFile(demoFile, {})` would now expand (the file defines
    // sections) and correctly fail on the unresolvable skill.
    const parsed = parseTestContent(readFileSync(demoFile, 'utf-8'), demoFile);
    const expansion = await expandSkills(
      parsed.steps,
      skillsDir,
      undefined,
      demoFile,
      parsed.stepLines,
      { sections: parsed.sections, rawSteps: parsed.rawSteps },
    );

    const frames = Object.values(expansion.frames);
    // Two section invocations, each containing one skill invocation.
    expect(frames.filter((f) => f.kind === 'section')).toHaveLength(2);
    expect(frames.filter((f) => f.kind === 'skill')).toHaveLength(2);
    expect(new Set(frames.map((f) => f.id)).size).toBe(4);

    for (const section of frames.filter((f) => f.kind === 'section')) {
      expect(section.parentId).toBeNull();
      expect(section.uri).toBe(demoFile);
      expect(section.skillName).toBe('Sign in');
    }
    for (const skill of frames.filter((f) => f.kind === 'skill')) {
      // Each skill frame is nested inside a section frame, not the test frame.
      const parent = expansion.frames[skill.parentId!];
      expect(parent?.kind).toBe('section');
    }

    // The two invocation lines in the demo file.
    expect(
      frames.filter((f) => f.kind === 'section').map((f) => f.invocationLine).sort(),
    ).toEqual([19, 21]);
  });

  it('points every expanded step at its call site in the test file', async () => {
    const parsed = await parseTestFile(demoFile, { skillsDir });
    // Body steps report the invocation line — the line the author has open.
    const [callA, callB] = [19, 21];
    expect(parsed.stepLines).toEqual([
      18,
      callA, callA, callA, callA, callA,
      20,
      callB, callB, callB, callB, callB,
      22,
    ]);
  });

  it('leaves hooks and skipHooks consistent with the expanded list', async () => {
    const parsed = await parseTestFile(demoFile, { skillsDir });
    expect(parsed.skipHooks).toHaveLength(parsed.steps.length);
    expect(parsed.skipHooks.every((v) => v === false)).toBe(true);
    expect(parsed.toolCalls).toHaveLength(parsed.steps.length);
  });
});

/**
 * The file `aiui init` scaffolds into every new project. It is self-contained
 * — a section is defined and called twice, with no skill dependency — so a
 * fresh project can run it immediately. These assertions pin the exact shape
 * users receive: if an edit to the template breaks parsing or provenance,
 * every new project's `aiui run` would break silently, and this catches it.
 *
 * Deliberately mirrors nothing from the fixture above: the two files diverge
 * on purpose (see the header comment), so they need independent guards.
 */
describe('templates/init/tests/sections-demo.md (the file `aiui init` ships)', () => {
  const signInBody = [
    'Navigate to the login page',
    'Enter "{{email}}" in the email field',
    'Enter "{{password}}" in the password field',
    'Click the Sign In button',
    'Assert the dashboard is visible',
  ];

  it('parses self-contained (no skillsDir needed) into one section called twice', async () => {
    // Pass no skillsDir at all — the demo must resolve without one.
    const parsed = await parseTestFile(shippedDemoFile, {});
    expect(Object.keys(parsed.sections)).toEqual(['sign in']);
    expect(parsed.sections['sign in']!.name).toBe('Sign in');
    expect(parsed.sections['sign in']!.steps).toHaveLength(5);
  });

  it('expands the section body at both call sites, leaving no skill tags', async () => {
    const parsed = await parseTestFile(shippedDemoFile, {});
    expect(parsed.steps).toEqual([
      ...signInBody,
      'Open the account settings page',
      'Change the display name to "Demo User" and save',
      'Sign out',
      ...signInBody,
      'Assert the display name shows "Demo User"',
    ]);
    // Self-contained: nothing came from a skill.
    expect(parsed.sourceSkills.every((s) => s === null)).toBe(true);
  });

  it('tags body steps with the section and leaves main-flow steps untagged', async () => {
    const parsed = await parseTestFile(shippedDemoFile, {});
    // First five are the body of the first call.
    expect(parsed.sourceSections.slice(0, 5)).toEqual([
      'Sign in',
      'Sign in',
      'Sign in',
      'Sign in',
      'Sign in',
    ]);
    // Index 5 is the first main-flow step after the call ('Open the account…').
    expect(parsed.sourceSections[5]).toBeNull();
  });

  it('points every expanded step back at its call site in the file', async () => {
    const parsed = await parseTestFile(shippedDemoFile, {});
    // Both calls sit on their own line (25 and 29); the body reports the call.
    const [callA, callB] = [25, 29];
    expect(parsed.stepLines).toEqual([
      callA, callA, callA, callA, callA,
      26,
      27,
      28,
      callB, callB, callB, callB, callB,
      30,
    ]);
    // A clean parse leaves no dead-section or duplicate residue.
    expect(parsed.skipHooks).toHaveLength(parsed.steps.length);
    expect(parsed.skipHooks.every((v) => v === false)).toBe(true);
  });
});
