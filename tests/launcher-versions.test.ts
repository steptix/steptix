/**
 * Version rules shared by the launcher and the extension
 * (docs/specs/SPEC-install.md §4.2), and the Node.js check that runs before
 * the launcher (§5.1).
 */
import { describe, expect, it } from 'vitest';
import { compareVersions, defaultRequirement, majorMinor, satisfies } from '../src/launcher/versions.js';
import { nodeVersionProblem } from '../src/launcher/node-check.js';

describe('compareVersions', () => {
  it('orders by major, minor, then patch, numerically', () => {
    const sorted = ['1.10.0', '1.2.10', '1.2.9', '2.0.0', '1.2.0'].sort(compareVersions);
    expect(sorted).toEqual(['1.2.0', '1.2.9', '1.2.10', '1.10.0', '2.0.0']);
  });

  it('puts a pre-release below its release, and a name that is not a version below both', () => {
    expect(['1.0.0', 'notes', '1.0.0-beta.1'].sort(compareVersions)).toEqual(['notes', '1.0.0-beta.1', '1.0.0']);
  });
});

describe('satisfies', () => {
  it('needs the same major.minor and at least the patch asked for', () => {
    expect(satisfies('1.4.3', '1.4.0')).toBe(true);
    expect(satisfies('1.4.0', '1.4.2')).toBe(false);
    expect(satisfies('1.5.0', '1.4.0')).toBe(false);
    expect(satisfies('1.3.9', '1.4.0')).toBe(false);
    expect(satisfies('2.4.0', '1.4.0')).toBe(false);
  });

  it('turns down a pre-release of the minimum and anything that is not a version', () => {
    expect(satisfies('1.0.0-beta.1', '1.0.0')).toBe(false);
    expect(satisfies('latest', '1.0.0')).toBe(false);
  });
});

describe('majorMinor and defaultRequirement', () => {
  it('reads the shared part and the requirement a client with no stated patch has', () => {
    expect(majorMinor('1.4.3')).toBe('1.4');
    expect(defaultRequirement('1.4.3')).toBe('1.4.0');
    expect(defaultRequirement('nope')).toBeNull();
  });
});

describe('nodeVersionProblem', () => {
  it('accepts 22.21 and later', () => {
    expect(nodeVersionProblem('22.21.0')).toBeNull();
    expect(nodeVersionProblem('22.22.1')).toBeNull();
    expect(nodeVersionProblem('24.0.0')).toBeNull();
  });

  it('refuses an older Node.js with the version it found and what to do', () => {
    expect(nodeVersionProblem('20.11.1')).toBe(
      'Steptix needs Node.js 22.21 or later. You have 20.11. Install a newer Node.js from nodejs.org and run this again.',
    );
    expect(nodeVersionProblem('22.20.0')).toContain('You have 22.20.');
  });
});
