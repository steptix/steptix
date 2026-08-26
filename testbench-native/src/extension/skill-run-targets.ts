/**
 * The skill-file session picker's enumeration
 * (stories/specs/run-and-compile-a-skill-step.md §3.2).
 *
 * In a SKILL file, Run Step Here / Compile This Step never act directly:
 * they open a picker of the sessions the step could run in — tests paused or
 * stopped inside this skill first, then other open sessions of tests that
 * call it, then a fresh standalone session. This module decides the rows;
 * the command layer owns the QuickPick and the routing.
 *
 * Pure and vscode-free for the reason `sections.ts` is: it is the only part
 * of the picker that can be unit-tested without a VS Code host, and
 * `run-controller.ts` uses parameter properties Node's type-stripping test
 * runner cannot parse, so nothing importable from there is testable under
 * `node --test`. Controllers arrive as plain rows carrying an opaque `id`
 * the command layer maps back.
 */

import * as path from 'node:path';
import { extractSteps, parseFrontmatter } from 'ai-ui-automation-runner-core';
// `.ts` specifier so this module stays loadable under `node --test`'s
// type-stripping (the same reason renumber-core imports step-region-core.ts).
import { canonicalSkillName, parseInvocationLine } from './invocation-target-core.ts';

/** Case-folded absolute-path identity. TestBench paths arrive in both drive
 *  cases on win32 (`uri.fsPath` lower-cases the drive; server echoes may
 *  not), and a path miss here silently drops a picker row. */
export function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/**
 * Is this document a SKILL — the fork that sends its step commands through
 * the picker?
 *
 * Frontmatter `type: skill` (case-insensitive) is the declared form. The
 * skills-directory containment check is the safety net: the server's
 * `loadSkill` never reads frontmatter — a frontmatterless file in `skills/`
 * is fully invocable — and detection by frontmatter alone would silently
 * leave its step commands on standalone behaviour with no hint the picker
 * exists.
 */
export function isSkillDocument(
  text: string,
  fsPath: string,
  skillsDir: string | null,
): boolean {
  const declared = parseFrontmatter(text).type;
  if (typeof declared === 'string' && declared.trim().toLowerCase() === 'skill') return true;
  if (skillsDir === null) return false;
  const rel = path.relative(path.resolve(skillsDir), path.resolve(fsPath));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The step lines of `documentText` that invoke the skill at `skillFsPath`,
 * resolved the way go-to-definition resolves them: `parseInvocationLine` +
 * `canonicalSkillName` + `<skillsDir>/<name>.md`. Each line is a distinct
 * picker row — the call line decides the input parameters, so it is part of
 * the target.
 *
 * Locating the call is `parseInvocationLine`'s job, not a regex of our own.
 * This started as one and was measured wrong twice: an `^`-anchored version
 * missed every LABELLED call (`Sign in [skill: login]`, which the runtime
 * executes, keeping the prefix as the step's label), and a colon-requiring
 * one missed `[skill login]` once the separator became optional. Both would
 * silently drop a test from the picker — the failure mode is invisible,
 * because a missing row looks exactly like a test that does not call this
 * skill. The shared parser also declines what the runtime declines: a
 * markdown link (`[skill guide](./g.md)`) and prose (`[skill level: expert]`).
 */
export function skillCallLines(
  documentText: string,
  skillFsPath: string,
  skillsDir: string | null,
): number[] {
  if (skillsDir === null) return [];
  const lines: number[] = [];
  const want = process.platform === 'win32'
    ? path.resolve(skillFsPath).toLowerCase()
    : path.resolve(skillFsPath);
  for (const step of extractSteps(documentText)) {
    const parsed = parseInvocationLine(step.instruction);
    if (!parsed || parsed.kind !== 'skill') continue;
    const name = canonicalSkillName(parsed.name);
    if (name === null) continue;
    const target = path.resolve(path.join(skillsDir, `${name}.md`));
    if ((process.platform === 'win32' ? target.toLowerCase() : target) === want) {
      lines.push(step.line);
    }
  }
  return lines;
}

/** One controller, as plain data. `id` is opaque to this module. */
export interface SessionCandidate {
  id: string;
  testFsPath: string;
  /** Read lazily — only the "open sessions of callers" rows are scanned. */
  documentText: () => string;
  /** Controllers are never deleted from the registry, so one can outlive its
   *  editor with a stale buffer — a closed document is not a candidate. */
  documentClosed: boolean;
  /** A session mid-run cannot accept an injected step. */
  isRunning: boolean;
  /**
   * The test is parked at a breakpoint (or paused on error) and waiting for
   * Continue. NOT a candidate: an injected run clears the resume marker and
   * supersedes the retained compiler, so picking one silently strands a run
   * the author is in the middle of — with entries they already paid for.
   */
  parkedAtPause: boolean;
  /** A steps stream has answered since the last close/recycle — worth
   *  listing. The post-pick liveness pre-flight is the truth. */
  sessionProbablyOpen: boolean;
  /** The parked paused-on-error skill failure, when one is held. */
  pausedInSkill: { skillFsPath: string; skillLine: number; callLine: number } | null;
}

/** The registry-level Stop-debug context, pre-flattened to fsPaths. */
export interface StopAnchor {
  /** Matches a candidate's `id`. */
  id: string;
  skillFsPath: string;
  callLine: number;
}

export type SkillRunTarget =
  | {
      kind: 'paused' | 'stopped' | 'open';
      id: string;
      callLine: number;
      label: string;
      description: string;
    }
  | { kind: 'standalone'; label: string; description: string };

/**
 * The picker's rows, in presentation order: ⏸ paused-in-this-skill, ⏹ the
 * Stop-debug anchor, ▶ other open sessions of callers (one row per call
 * line), and the standalone session always last — the picker can never be
 * empty. Nothing is ever chosen silently; anchored rows merely sort first.
 */
export function collectSkillRunTargets(input: {
  skillFsPath: string;
  /** 1-based line of the step being run/compiled — labels "at this step". */
  clickedLine: number;
  candidates: SessionCandidate[];
  stopAnchor: StopAnchor | null;
  /** The project's skills dir for a given test file, for the caller scan. */
  skillsDirFor: (testFsPath: string) => string | null;
}): SkillRunTarget[] {
  const { skillFsPath, clickedLine, candidates, stopAnchor, skillsDirFor } = input;
  const skillName = path.basename(skillFsPath, path.extname(skillFsPath));
  const eligible = candidates.filter(
    (c) => !c.documentClosed && !c.isRunning && !c.parkedAtPause,
  );
  const rows: SkillRunTarget[] = [];
  const rowed = new Set<string>();

  for (const c of eligible) {
    if (!c.pausedInSkill || !samePath(c.pausedInSkill.skillFsPath, skillFsPath)) continue;
    const at =
      c.pausedInSkill.skillLine === clickedLine
        ? 'paused at this step'
        : `paused in ${skillName} (line ${c.pausedInSkill.skillLine})`;
    rows.push({
      kind: 'paused',
      id: c.id,
      callLine: c.pausedInSkill.callLine,
      label: `⏸ ${path.basename(c.testFsPath)}`,
      description: at,
    });
    rowed.add(c.id);
  }

  if (stopAnchor && samePath(stopAnchor.skillFsPath, skillFsPath) && !rowed.has(stopAnchor.id)) {
    const c = eligible.find((e) => e.id === stopAnchor.id);
    if (c) {
      rows.push({
        kind: 'stopped',
        id: c.id,
        callLine: stopAnchor.callLine,
        label: `⏹ ${path.basename(c.testFsPath)}`,
        description: `stopped inside ${skillName}`,
      });
      rowed.add(c.id);
    }
  }

  for (const c of eligible) {
    if (rowed.has(c.id) || !c.sessionProbablyOpen) continue;
    const calls = skillCallLines(c.documentText(), skillFsPath, skillsDirFor(c.testFsPath));
    for (const callLine of calls) {
      rows.push({
        kind: 'open',
        id: c.id,
        callLine,
        label: `▶ ${path.basename(c.testFsPath)}`,
        description:
          calls.length > 1
            ? `session open — via line ${callLine}`
            : `session open (calls ${skillName} at line ${callLine})`,
      });
    }
    if (calls.length > 0) rowed.add(c.id);
  }

  rows.push({
    kind: 'standalone',
    label: '＋ a fresh standalone session',
    description: `run ${skillName} on its own, in a new browser`,
  });
  return rows;
}
