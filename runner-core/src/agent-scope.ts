/**
 * Which steps of a file run as agent steps (docs/specs/SPEC-use-agent.md §5.6,
 * §5.7): `agentScopeOf(text)`.
 *
 * The answer is read from the file's TEXT, never from what a batch happens to
 * hold, so every way of running a step — Run, Run From Here below the bare
 * `[use agent]`, a section line run on its own, Continue after a pause — gets
 * the same answer for the same line. The editor's marks come from here too.
 *
 * Mirrored in `src/parser/agent-scope.ts` for the CLI and MCP, which read the
 * file themselves. `tests/agent-scope.test.ts` keeps the two equal.
 */

import { extractSections, extractSteps } from './step-lines.js';
import { parseFrontmatter } from './frontmatter.js';
import { hasNoAgentMarker, isUseStepClaim, parseUseAgentStep } from './use-step.js';
import { isFlowControlLine, parseControlLine } from './control-line.js';
import { matchText, NO_HOOKS_MARKER } from './section-match.js';

/** Why a step runs as an agent step — the report's badge tooltip (§8.2). */
export type AgentScopeReason = 'prefix' | 'section' | 'main-flow' | 'file';

export interface AgentScopeStep {
  /** 1-based line in the file. */
  line: number;
  reason: AgentScopeReason;
  /** The section's name, for `section`. */
  section?: string;
}

export interface AgentScope {
  /** The frontmatter says `agent: on`. */
  file: boolean;
  /** Every line that runs as an agent step, in document order. */
  steps: AgentScopeStep[];
  /** Bare `[use agent]` lines that open their block's scope. */
  openers: number[];
  /** `[no-agent]` steps inside a scope: the report's *opted out* marker. */
  optedOut: number[];
  /** `[no-agent]` steps outside every scope: a no-op, warned about. */
  strayNoAgent: number[];
  /** Bare `[use agent]` lines that are not the first step of their block:
   *  a parse error (§5.1). */
  misplacedOpeners: number[];
  /** `[no-agent]` where it cannot go (§5.1): a parse error. */
  misusedNoAgent: Array<{ line: number; why: NoAgentMisuse }>;
}

/**
 * Where `[no-agent]` cannot go:
 *  - `order`: before `[no-hooks]`. Every other grammar reads `[no-hooks]` only
 *    at the very start of a line, so the marker would hide it.
 *  - `agent`: on a `[use agent]` line, which it would contradict.
 *  - `claimed`: on a line the parser claims (`Set`, `[tool:]`, a control
 *    line, a section call…), which never was an agent step — and which those
 *    grammars would no longer recognise with the marker in front.
 */
export type NoAgentMisuse = 'order' | 'agent' | 'claimed';

/** The parse error for a misplaced `[no-agent]`, written once so the editor
 *  and the CLI say the same thing. */
export function noAgentMisuseError(why: NoAgentMisuse, where = ''): string {
  switch (why) {
    case 'order':
      return `\`[no-agent]\`${where} goes after \`[no-hooks]\`: write \`[no-hooks] [no-agent] …\`.`;
    case 'agent':
      return `\`[no-agent]\`${where} cannot mark a \`[use agent]\` step: remove one of the two.`;
    case 'claimed':
      return (
        `\`[no-agent]\`${where} marks a plain step only. This line is never an agent step ` +
        '(a `Set`, a directive, a control line or a section call), so remove the marker.'
      );
  }
}

/** One block: the main flow, or one section's body. */
export interface AgentScopeBlock {
  /** Null for the main flow. */
  section: string | null;
  steps: { line: number; text: string }[];
}

/** The parse error for a bare `[use agent]` that is not first in its block,
 *  written once so the editor and the CLI say the same thing. */
export function misplacedAgentOpenerError(where = ''): string {
  return (
    `A bare \`[use agent]\`${where} must be the first step of its block (the main ` +
    'flow or a `### Section` body): it makes the steps BELOW it agent steps. ' +
    'Move it to the top of the block, or write the goal after it on this line.'
  );
}

/**
 * The rule, over blocks. `isClaimed` says whether a line is one the parser
 * already claims (`Set`, `[tool:]`, a control line, a section call, …), which
 * never becomes an agent step. Shared in shape with the `src/` copy; only the
 * grammar it is handed differs.
 */
export function agentScopeOfBlocks(
  fileAgent: boolean,
  blocks: readonly AgentScopeBlock[],
  isClaimed: (text: string) => boolean,
): AgentScope {
  const out: AgentScope = {
    file: fileAgent,
    steps: [],
    openers: [],
    optedOut: [],
    strayNoAgent: [],
    misplacedOpeners: [],
    misusedNoAgent: [],
  };
  for (const block of blocks) {
    const first = block.steps[0];
    const opened = first !== undefined && parseUseAgentStep(first.text)?.bare === true;
    const scoped = fileAgent || opened;
    // The block's opener is the more specific reason, so it wins over the
    // file's: the tooltip then names the section the author can see.
    const reason: AgentScopeReason = opened
      ? block.section === null
        ? 'main-flow'
        : 'section'
      : 'file';
    block.steps.forEach((step, index) => {
      // `[no-agent]` first: a line it is misused on is reported, and is not
      // also counted as an opener, an agent step or an opt-out.
      if (hasNoAgentMarker(step.text)) {
        const why: NoAgentMisuse | null = /^\s*\[no-agent\]\s*\[no-hooks\]/i.test(step.text)
          ? 'order'
          : parseUseAgentStep(step.text) !== null
            ? 'agent'
            : isClaimed(step.text)
              ? 'claimed'
              : null;
        if (why !== null) out.misusedNoAgent.push({ line: step.line, why });
        else (scoped ? out.optedOut : out.strayNoAgent).push(step.line);
        return;
      }
      const agent = parseUseAgentStep(step.text);
      if (agent?.bare) {
        if (index === 0) out.openers.push(step.line);
        else out.misplacedOpeners.push(step.line);
        return;
      }
      if (agent) {
        out.steps.push({ line: step.line, reason: 'prefix' });
        return;
      }
      if (!scoped || isClaimed(step.text)) return;
      out.steps.push({
        line: step.line,
        reason,
        ...(reason === 'section' && block.section !== null && { section: block.section }),
      });
    });
  }
  out.steps.sort((a, b) => a.line - b.line);
  return out;
}

/** The leading markers, stripped before a line is classified. */
const MARKERS_RE = /^(?:\[no-(?:hooks|agent)\]\s*)+/i;
/** `Set {{x}} to` — the `Set` grammar's claim (src/parser/set-step.ts). */
const SET_CLAIM_RE = /^set\s+\{\{\s*\w+\s*\}\}\s+to\b/i;
/** The bracket directives that claim a whole step. */
const BRACKET_CLAIM_RE = /^\[(?:skill|tool|input)(?=[ \t:])|^\[interactive[ \t]*\]/i;

/** The claimed-line test for runner-core's grammar. */
export function isClaimedStepLine(text: string, sectionKeys: ReadonlySet<string>): boolean {
  const s = text.trim().replace(MARKERS_RE, '').trim();
  if (s === '') return true;
  if (SET_CLAIM_RE.test(s)) return true;
  if (BRACKET_CLAIM_RE.test(s)) return true;
  if (isUseStepClaim(s)) return true;
  if (isFlowControlLine(s) || parseControlLine(s) !== null) return true;
  return sectionKeys.has(matchText(s));
}

/** Which lines of `text` run as agent steps (§5.6, §5.7). */
export function agentScopeOf(text: string): AgentScope {
  const sections = extractSections(text);
  const blocks: AgentScopeBlock[] = [
    {
      section: null,
      // `extractSteps` keeps a marker-only `1. [no-hooks]` item, which the
      // CLI's scan culls; culled here too, so a bare `[use agent]` below one
      // is an opener on both sides.
      steps: extractSteps(text)
        .filter((s) => s.instruction.replace(NO_HOOKS_MARKER, '').trim() !== '')
        .map((s) => ({ line: s.line, text: s.instruction })),
    },
    ...sections.map((s) => ({
      section: s.name,
      steps: s.steps.map((b) => ({ line: b.line, text: b.instruction })),
    })),
  ];
  const keys = new Set(sections.map((s) => matchText(s.name)));
  return agentScopeOfBlocks(
    parseFrontmatter(text).agent === true,
    blocks,
    (line) => isClaimedStepLine(line, keys),
  );
}
