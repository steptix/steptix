import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { agentScopeOf as cliScope } from '../src/parser/agent-scope.js';
// runner-core's SOURCE, for the reason tests/use-step-parity.test.ts gives.
import { agentScopeOf as coreScope } from '../runner-core/src/agent-scope.ts';
import { agentScopesForBatch } from '../src/agent/host.js';
import { agentWireScopeOf } from '../src/agent/wire-scope.js';
import { parseTestContent } from '../src/parser/markdown.js';

/**
 * Which steps run as agent steps (docs/specs/SPEC-use-agent.md §5.6, §5.7):
 * each row of the §5.6 table, the block rules, the lexical rule, and the two
 * copies of `agentScopeOf` agreeing on one corpus.
 */

const doc = (...lines: string[]): string => lines.join('\n');
/** Native fixture paths (CLAUDE.md: never a hard-coded drive). */
const TEST_FILE = path.resolve(path.sep, 'proj', 't.md');
const SKILL_FILE = path.resolve(path.sep, 'proj', 'skills', 'login.md');

const linesOf = (text: string): number[] => cliScope(text).steps.map((s) => s.line);

const PREFIX = doc(
  '# T',
  '## Steps',
  '1. Navigate to the Orders page',
  '2. [use agent] Export the March orders and store the path in export_file',
  '3. Verify the page heading says Orders',
);

const SECTION = doc(
  '# T',
  '## Steps',
  '1. Sign in',
  '2. Export the March ledger',
  '3. [tool: csv_row_count file="{{ledger_file}}" out.rows="ledger_rows"]',
  '',
  '### Export the March ledger',
  '1. [use agent]',
  '2. Open the export wizard from the Ledger page',
  '3. [no-agent] Verify the wizard is closed',
  '4. Set {{format}} to "csv"',
  '',
  '### Sign in',
  '1. Enter {{user}} in the Email field',
  '2. Click Sign in',
);

const MAIN_FLOW = doc(
  '# T',
  '## Steps',
  '1. [use agent]',
  '2. Close the "What\'s new" panel if it is showing',
  '3. Do the thing',
  '4. If the banner is shown, then click Dismiss',
  '',
  '### Do the thing',
  '1. Click Save',
);

const FILE = doc(
  '---',
  'agent: on',
  '---',
  '# Month-end',
  '## Steps',
  '1. Navigate to the Orders page',
  '2. [tool: xlsx_row_count file="{{x}}" out.rows="rows"]',
  '3. [no-agent] Verify the Orders page shows {{rows}} orders',
  '4. [use ai] Make up a name [store as: name]',
  '5. [use computer]',
  '6. Helper',
  '',
  '### Helper',
  '1. Click Help',
);

const MISPLACED = doc('# T', '## Steps', '1. Click Save', '2. [use agent]', '3. Click Close');
const STRAY = doc('# T', '## Steps', '1. [no-agent] Click Save', '2. Click Close');

describe('agentScopeOf — the §5.6 table', () => {
  it('a [use agent] <goal> step is that step only', () => {
    const scope = cliScope(PREFIX);
    expect(scope.steps).toEqual([{ line: 4, reason: 'prefix' }]);
    expect(scope.file).toBe(false);
  });

  it('a section opening with a bare [use agent] makes the rest of its body agent steps', () => {
    const scope = cliScope(SECTION);
    // Line 9 (the plain body step) only: line 10 opted out, line 11 is a Set.
    expect(scope.steps).toEqual([{ line: 9, reason: 'section', section: 'Export the March ledger' }]);
    expect(scope.openers).toEqual([8]);
    expect(scope.optedOut).toEqual([10]);
    // The caller's main flow and the other section are not in scope.
    expect(linesOf(SECTION)).not.toContain(3);
    expect(linesOf(SECTION)).not.toContain(14);
  });

  it('the main flow opening with a bare [use agent] scopes the main flow, not its sections', () => {
    const scope = cliScope(MAIN_FLOW);
    // Line 4 (a section call) and line 6 (a control line) are claimed.
    expect(scope.steps.map((s) => [s.line, s.reason])).toEqual([[4, 'main-flow']]);
    expect(linesOf(MAIN_FLOW)).not.toContain(9);
  });

  it('agent: on scopes every block, and claimed lines keep their meaning', () => {
    const scope = cliScope(FILE);
    expect(scope.file).toBe(true);
    // Line 6 (plain) and line 14 (the section body) — not the tool, the
    // opted-out check, the [use ai], the surface switch or the section call.
    expect(scope.steps.map((s) => [s.line, s.reason])).toEqual([
      [6, 'file'],
      [14, 'file'],
    ]);
    expect(scope.optedOut).toEqual([8]);
  });
});

describe('agentScopeOf — the block rules (§5.1)', () => {
  it('a bare [use agent] that is not first in its block is reported', () => {
    expect(cliScope(MISPLACED).misplacedOpeners).toEqual([4]);
    expect(cliScope(MISPLACED).steps).toEqual([]);
  });

  it('the CLI parser refuses it by line', () => {
    expect(() => parseTestContent(MISPLACED, 'tests/t.md')).toThrow(/line 4/);
  });

  it('a [no-agent] outside any scope is a stray, not an opt-out', () => {
    expect(cliScope(STRAY).strayNoAgent).toEqual([3]);
    expect(cliScope(STRAY).optedOut).toEqual([]);
  });
});

describe('src/parser/agent-scope.ts and runner-core/src/agent-scope.ts agree', () => {
  for (const [name, text] of Object.entries({ PREFIX, SECTION, MAIN_FLOW, FILE, MISPLACED, STRAY })) {
    it(name, () => {
      expect(coreScope(text)).toEqual(cliScope(text));
    });
  }
});

describe('the server reads the same scope from the wire (§5.7)', () => {
  it('a root step listed in agent.steps is an agent step, a claimed one is not', () => {
    const scopes = agentScopesForBatch({
      steps: ['Close the panel', 'Do the thing', 'Set {{x}} to "y"'],
      origins: null,
      frames: {},
      wire: { steps: [0, 2] },
    });
    expect(scopes.scope.map((s) => s?.reason ?? null)).toEqual(['main-flow', null, null]);
  });

  it('a section body sent in `sections` carries its own scope', () => {
    const scopes = agentScopesForBatch({
      steps: ['Open the wizard', 'Click Save'],
      origins: [
        { inputIndex: 0, frameId: 's1', skillLine: 9 },
        { inputIndex: 1, frameId: '' },
      ],
      frames: { s1: { id: 's1', parentId: null, kind: 'section', uri: TEST_FILE, invocationLine: 4, skillName: 'Export' } },
      sections: { export: { name: 'Export', steps: ['[use agent]', 'Open the wizard'] } },
      testFilePath: TEST_FILE,
    });
    expect(scopes.scope[0]).toEqual({ reason: 'section', section: 'Export' });
    expect(scopes.scope[1]).toBeNull();
  });

  it('a skill file decides its own scope; the caller\'s agent: on does not carry in', () => {
    const skill = doc('---', 'type: skill', '---', '# Login', '## Steps', '1. Enter the user', '2. Click Sign in');
    const scopes = agentScopesForBatch({
      steps: ['Enter the user', 'Click Sign in'],
      origins: [
        { inputIndex: 0, frameId: 'k1', skillFilePath: SKILL_FILE, skillLine: 6 },
        { inputIndex: 0, frameId: 'k1', skillFilePath: SKILL_FILE, skillLine: 7 },
      ],
      frames: { k1: { id: 'k1', parentId: null, kind: 'skill', uri: SKILL_FILE, invocationLine: 3 } },
      wire: { file: true },
      testFilePath: TEST_FILE,
      readFile: () => skill,
    });
    expect(scopes.scope).toEqual([null, null]);
  });

  it('the wire scope built from a file lists the main flow\'s scoped positions', () => {
    // MAIN_FLOW's main-flow steps sit on lines 3, 4, 5, 6.
    expect(agentWireScopeOf(MAIN_FLOW, 't.md', [3, 4, 5, 6])).toEqual({ steps: [1] });
    // FILE's line 8 is a [no-agent] step in scope: its position is sent too,
    // so the report's opted-out marker agrees with the editor's (§8.6).
    expect(agentWireScopeOf(FILE, 't.md', [6, 7, 8, 9, 10, 11])).toEqual({ file: true, optedOut: [2] });
    expect(agentWireScopeOf(PREFIX, 't.md', [3, 4, 5])).toBeUndefined();
  });

  it('Run From Here below the bare line keeps the scope: positions come from lines', () => {
    // Only lines 4..6 sent; line 4 is still an agent step.
    expect(agentWireScopeOf(MAIN_FLOW, 't.md', [4, 5, 6])).toEqual({ steps: [0] });
  });
});

describe('where [no-agent] may go (§5.1, §16.1)', () => {
  const MISUSE = doc(
    '# T',
    '## Steps',
    '1. [no-agent] [no-hooks] Click Save',
    '2. [no-agent] [use agent] Export the ledger',
    '3. [no-agent] Set {{x}} to "y"',
    '4. [no-hooks] [no-agent] Click Close',
  );

  it('before [no-hooks], on [use agent], or on a claimed line, it is misused', () => {
    expect(cliScope(MISUSE).misusedNoAgent).toEqual([
      { line: 3, why: 'order' },
      { line: 4, why: 'agent' },
      { line: 5, why: 'claimed' },
    ]);
    // After [no-hooks] on a plain step it is fine (a stray here: no scope).
    expect(cliScope(MISUSE).strayNoAgent).toEqual([6]);
    expect(coreScope(MISUSE)).toEqual(cliScope(MISUSE));
  });

  it('the CLI parser refuses a misuse by line', () => {
    expect(() => parseTestContent(MISUSE, 'tests/t.md')).toThrow(/at line 3.*goes after `\[no-hooks\]`/);
  });

  it('a marker-only [no-hooks] item above a bare [use agent] does not make it misplaced, on either side', () => {
    const text = doc('# T', '## Steps', '1. [no-hooks]', '2. [use agent]', '3. Click Save');
    expect(coreScope(text)).toEqual(cliScope(text));
    expect(cliScope(text).misplacedOpeners).toEqual([]);
  });
});

describe('a control line\'s tail is part of the line (§5.6)', () => {
  it('is not an agent step under agent: on', () => {
    const scopes = agentScopesForBatch({
      steps: ['If the banner shows, then click Dismiss', 'click Dismiss', 'Close the panel'],
      origins: [
        { inputIndex: 0, frameId: '' },
        { inputIndex: 0, frameId: '' },
        { inputIndex: 1, frameId: '' },
      ],
      frames: {},
      controls: [{ bodyStart: 1, bodyEnd: 1 }, null, null],
      wire: { file: true },
    });
    expect(scopes.scope.map((s) => s?.reason ?? null)).toEqual([null, null, 'file']);
  });

  it('an opted-out step sent on the wire is in scope, for its marker', () => {
    const scopes = agentScopesForBatch({
      steps: ['Click Save'],
      origins: null,
      frames: {},
      wire: { optedOut: [0] },
    });
    expect(scopes.inScope).toEqual([true]);
    expect(scopes.scope).toEqual([null]);
  });
});
