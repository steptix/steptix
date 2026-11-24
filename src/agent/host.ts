/**
 * The pieces every step loop needs to host agent steps
 * (docs/specs/SPEC-use-agent.md §5.7, §6): which expanded steps are agent
 * steps, the run's state, the surface's observation, the project tools, and
 * the effective limits once a test's `## Config` has lowered them.
 *
 * Kept apart from the loops so the CLI runner and the Sessions API read one
 * rule rather than two copies of it.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import type { AgentConfig } from '../config/types.js';
import type { AgentStepScope } from '../report/types.js';
import type { ExpandedFrame, ExpandedStepOrigin } from '../skills/expander.js';
import { agentScopeOf, isClaimedStepLine } from '../parser/agent-scope.js';
import { scanStepSpans } from '../parser/markdown.js';
import { agentWireScopeOf } from './wire-scope.js';
import { hasNoAgentMarker, parseUseAgentStep, stripNoAgentMarker } from '../parser/use-step.js';
import { matchText } from '../parser/section-match.js';
import { captureAriaPageSnapshot } from '../browser/aria-snapshot.js';
import { redact } from '../utils/secrets.js';
import type { DesktopAdapter } from '../desktop/adapter.js';
import { captureView } from '../desktop/capture.js';
import type { ToolCatalogue } from '../tools/registry.js';
import type { AgentObservation, AgentToolInfo } from './context.js';
import { RunApprovals } from './approvals.js';
import { createWorkspace, removeWorkspace } from './workspace.js';
import { discoverSkills } from './skills.js';
import type { AgentRunState } from './runner.js';

/** The refusal of a runner that does not run agent steps (errands, the
 *  Electron runner): by name, rather than handing the line to the page model
 *  as prose, where it would be answered as a page step. */
export const AGENT_STEP_NOT_HERE =
  '`[use agent]` steps run in `steptix run` and from VS Code; this runner does not run ' +
  'them (docs/specs/SPEC-use-agent.md). Run the test there, or write the step without `[use agent]`.';

/** `StepRequest.agent` (§5.7): which steps of a batch are agent steps
 *  because of their file, not their own prefix. */
export interface AgentWireScope {
  /** The frontmatter says `agent: on`. */
  file?: boolean;
  /** Positions in `steps` that are agent steps because their block opens
   *  with a bare `[use agent]`. */
  steps?: number[];
  /** Positions in `steps` of `[no-agent]` steps inside a scope (§8.6). */
  optedOut?: number[];
}

/** Per expanded step: why it is an agent step by scope, or null; and whether
 *  it sits in an agent scope at all (for the *opted out* marker). */
export interface BatchAgentScopes {
  scope: (AgentStepScope | null)[];
  inScope: boolean[];
}

/**
 * Which expanded steps of a batch are agent steps BY SCOPE (§5.6, §5.7). A
 * step whose own text opens `[use agent]` is not decided here — the loop asks
 * the grammar — and neither is a claimed line, which never is one.
 *
 * - A root-frame step: the wire says (`agent.file`, or its position in
 *   `agent.steps`).
 * - A section of the test file: `agent.file`, or the section's body, sent in
 *   `sections`, opening with a bare `[use agent]`.
 * - A skill's step, or a section of a skill: the skill FILE decides,
 *   read from disk, since the expander read the same file (lexical scope).
 */
export function agentScopesForBatch(input: {
  steps: readonly string[];
  origins: readonly ExpandedStepOrigin[] | null;
  frames: Readonly<Record<string, ExpandedFrame>>;
  wire?: AgentWireScope | undefined;
  /** The expander's control records, parallel to `steps`: a control line's
   *  own tail is part of the line, not a step of the block (§5.6). */
  controls?: ReadonlyArray<{ bodyStart: number; bodyEnd: number } | null> | undefined;
  sections?: Readonly<Record<string, { name: string; steps: string[] }>> | undefined;
  testFilePath?: string | undefined;
  readFile?: (file: string) => string | undefined;
}): BatchAgentScopes {
  const readFile =
    input.readFile ??
    ((file: string): string | undefined => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return undefined;
      }
    });
  const fileScopes = new Map<string, ReturnType<typeof agentScopeOf> | null>();
  const scopeOfFile = (file: string): ReturnType<typeof agentScopeOf> | null => {
    if (!fileScopes.has(file)) {
      const text = readFile(file);
      let scope: ReturnType<typeof agentScopeOf> | null = null;
      if (text !== undefined) {
        try {
          scope = agentScopeOf(text, file);
        } catch {
          scope = null;
        }
      }
      fileScopes.set(file, scope);
    }
    return fileScopes.get(file)!;
  };
  const sameFile = (a: string | undefined, b: string | undefined): boolean =>
    a !== undefined && b !== undefined && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const wireSteps = new Set(input.wire?.steps ?? []);
  const sectionOpens = (name: string | undefined): boolean => {
    if (name === undefined || !input.sections) return false;
    const def = input.sections[matchText(name)] ?? Object.values(input.sections).find((s) => matchText(s.name) === matchText(name));
    const first = def?.steps[0];
    return first !== undefined && parseUseAgentStep(first)?.bare === true;
  };

  // A control line's tail — the step written after `then`, emitted in the
  // guard's own frame — belongs to the control line, which is claimed, so it
  // is never an agent step by scope. A tail that calls a section runs in the
  // section's frame, whose own scope decides.
  const tails = new Set<number>();
  input.controls?.forEach((record, guard) => {
    if (!record) return;
    for (let k = record.bodyStart; k <= record.bodyEnd; k++) {
      if ((input.origins?.[k]?.frameId ?? '') === (input.origins?.[guard]?.frameId ?? '')) tails.add(k);
    }
  });
  const scope: (AgentStepScope | null)[] = [];
  const inScope: boolean[] = [];
  input.steps.forEach((text, i) => {
    const origin = input.origins?.[i];
    const frame = origin && origin.frameId !== '' ? input.frames[origin.frameId] : undefined;
    let found: AgentStepScope | null = null;
    let scoped = false;
    if (!frame || frame.kind === 'test') {
      const inputIndex = origin?.inputIndex ?? i;
      if (input.wire?.optedOut?.includes(inputIndex)) scoped = true;
      if (wireSteps.has(inputIndex)) {
        scoped = true;
        found = { reason: 'main-flow' };
      } else if (input.wire?.file) {
        scoped = true;
        found = { reason: 'file' };
      }
    } else if (frame.kind === 'section' && sameFile(frame.uri, input.testFilePath)) {
      if (sectionOpens(frame.skillName)) {
        scoped = true;
        found = { reason: 'section', ...(frame.skillName !== undefined && { section: frame.skillName }) };
      } else if (input.wire?.file) {
        scoped = true;
        found = { reason: 'file' };
      }
    } else if (origin?.skillLine !== undefined) {
      const fileScope = scopeOfFile(frame.uri);
      const hit = fileScope?.steps.find((s) => s.line === origin.skillLine);
      if (hit && hit.reason !== 'prefix') {
        scoped = true;
        found = { reason: hit.reason, ...(hit.section !== undefined && { section: hit.section }) };
      } else if (fileScope?.optedOut.includes(origin.skillLine)) {
        scoped = true;
      }
    }
    // A claimed line, a bare opener and a `[no-agent]` step are never agent
    // steps by scope; the last still counts as in scope, for its marker.
    if (found && (tails.has(i) || isClaimedStepLine(text, new Set()) || parseUseAgentStep(text) !== null || hasNoAgentMarker(text))) {
      found = null;
    }
    scope.push(found);
    inScope.push(scoped);
  });
  return { scope, inScope };
}

/**
 * {@link agentScopesForBatch} for a test the CLI parsed itself: the wire scope
 * is built from the file's text, as the extension builds it from the buffer.
 */
export function agentScopesForParsedTest(test: {
  filePath: string;
  steps: readonly string[];
  expansion?:
    | {
        origins: readonly ExpandedStepOrigin[];
        frames: Readonly<Record<string, ExpandedFrame>>;
        controls?: ReadonlyArray<{ bodyStart: number; bodyEnd: number } | null>;
      }
    | undefined;
  sections: Readonly<Record<string, { name: string; steps: string[] }>>;
}): BatchAgentScopes {
  let text: string;
  try {
    text = fs.readFileSync(test.filePath, 'utf8');
  } catch {
    return { scope: test.steps.map(() => null), inScope: test.steps.map(() => false) };
  }
  let mainLines: number[] = [];
  try {
    mainLines = scanStepSpans(text, test.filePath, { quiet: true })
      .entries.filter((e) => e.sectionIndex === null)
      .map((e) => e.line);
  } catch {
    mainLines = [];
  }
  return agentScopesForBatch({
    steps: test.steps,
    origins: test.expansion?.origins ?? null,
    frames: test.expansion?.frames ?? {},
    controls: test.expansion?.controls,
    wire: agentWireScopeOf(text, test.filePath, mainLines),
    sections: test.sections,
    testFilePath: test.filePath,
  });
}

/** The goal of a step that runs as an agent step: the text after
 *  `[use agent]`, or the whole step with its markers removed. */
export function agentGoalOf(step: string): string {
  const prefixed = parseUseAgentStep(step);
  if (prefixed) return prefixed.goal;
  return stripNoAgentMarker(step).replace(/^\[no-hooks\]\s*/i, '').trim();
}

/**
 * The effective limits: the project's, with a test's `## Config` LOWERING
 * `maxTurns` and `timeout` (§10). A value that would raise one is ignored and
 * said so; anything else a test sets is not read at all.
 */
export function withTestAgentLimits(
  project: AgentConfig,
  test: { agentMaxTurns?: string | undefined; agentTimeout?: string | undefined },
): { config: AgentConfig; lowered: { maxTurns?: boolean; timeout?: boolean }; warnings: string[] } {
  const out: AgentConfig = { ...project };
  const lowered: { maxTurns?: boolean; timeout?: boolean } = {};
  const warnings: string[] = [];
  if (test.agentMaxTurns !== undefined && test.agentMaxTurns.trim() !== '') {
    const n = Number(test.agentMaxTurns.trim());
    if (!Number.isInteger(n) || n < 1) warnings.push(`agentMaxTurns: "${test.agentMaxTurns}" is not a whole number of turns; ignored.`);
    else if (n > project.maxTurns) warnings.push(`agentMaxTurns: ${n} is above the project's agent.maxTurns (${project.maxTurns}); a test may only lower it.`);
    else if (n < project.maxTurns) {
      out.maxTurns = n;
      lowered.maxTurns = true;
    }
  }
  if (test.agentTimeout !== undefined && test.agentTimeout.trim() !== '') {
    const ms = parseDurationMs(test.agentTimeout.trim());
    if (ms === null) warnings.push(`agentTimeout: "${test.agentTimeout}" is not a duration (say 90s or 5m); ignored.`);
    else if (ms > project.timeout) warnings.push(`agentTimeout: ${test.agentTimeout} is above the project's agent.timeout (${project.timeout} ms); a test may only lower it.`);
    else if (ms < project.timeout) {
      out.timeout = ms;
      lowered.timeout = true;
    }
  }
  return { config: out, lowered, warnings };
}

/** `90s`, `5m`, `600000` (milliseconds) → milliseconds, or null. */
export function parseDurationMs(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'ms').toLowerCase();
  const ms = unit === 'm' ? n * 60_000 : unit === 's' ? n * 1000 : n;
  return ms > 0 ? Math.round(ms) : null;
}

/** A new run's agent state (§6.2, §6.3, §7). The workspace and the skills
 *  are made at its first agent step, by {@link ensureAgentRun}. */
export function newAgentRun(projectRoot: string, prefix: string): AgentRunState {
  // A random suffix, so two runs in one project that start in the same
  // millisecond never share a workspace or a staging folder.
  const runId = `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    runId,
    projectRoot,
    approvals: new RunApprovals(),
    stagingDir: path.join(projectRoot, '.steptix', 'agent-report', runId.replace(/[^A-Za-z0-9._-]/g, '_')),
  };
}

/** Make the workspace (when files and commands are on) and find the skills,
 *  once per run, at its first agent step. Returns the skill warnings the
 *  first time, for the loop to log. */
export function ensureAgentRun(run: AgentRunState, config: AgentConfig): string[] {
  if (config.shell && !run.workspace) {
    run.workspace = createWorkspace({
      projectRoot: run.projectRoot,
      runId: run.runId,
      folders: config.folders,
      skillsDir: config.skillsDir,
    });
  }
  if (!run.skills) {
    const found = discoverSkills(path.resolve(run.projectRoot, config.skillsDir));
    run.skills = { list: found.skills, warnings: found.warnings };
    return found.warnings;
  }
  return [];
}

/** End a run's agent state: remove the workspace unless it is to be kept
 *  (§6.2). The staged report copies are not touched here — the CLI ends its
 *  run before it writes the report — and `placeAgentFiles` removes each
 *  step's once it has copied them beside the report. */
export function endAgentRun(run: AgentRunState | undefined, config: AgentConfig | undefined): void {
  if (!run?.workspace) return;
  if (config?.keepWorkspace) return;
  removeWorkspace(run.workspace);
}

/** The browser surface's observation: the page snapshot, masked. */
export async function observePage(page: Page | undefined, secrets: readonly string[], charLimit?: number): Promise<AgentObservation> {
  if (!page) return { kind: 'none', note: 'No page is open.' };
  // Read-only: the agent plans from this view, and the ordinary step it asks
  // for takes its own snapshot, so the refs that step acts on stay its own.
  const snapshot = await captureAriaPageSnapshot(page, {
    secrets: [...secrets],
    updateRegistry: false,
    ...(charLimit !== undefined && { domSnapshotCharLimit: charLimit }),
  });
  let title: string | undefined;
  try {
    title = await page.title();
  } catch {
    title = undefined;
  }
  return {
    kind: 'dom',
    url: page.url(),
    ...(title !== undefined && { title }),
    snapshot: redact(snapshot, [...secrets]),
  };
}

/** The computer surface's observation: a screenshot of the whole screen. */
export async function observeScreen(adapter: DesktopAdapter, maxImageWidth: number): Promise<AgentObservation> {
  const view = await captureView(adapter, { maxImageWidth });
  return { kind: 'screen', imageDataUrl: `data:image/png;base64,${view.pngBase64}` };
}

/** The project tools as the agent's catalogue lists them. */
export async function toolInfosOf(catalogue: ToolCatalogue): Promise<AgentToolInfo[]> {
  const out: AgentToolInfo[] = [];
  for (const name of catalogue.names()) {
    try {
      const t = (await catalogue.resolve(name)).definition;
      out.push({
        name: t.name,
        ...(t.description !== undefined && { description: t.description }),
        params: Object.entries(t.parameters ?? {}).map(([p, def]) => ({
          name: p,
          ...(def.description !== undefined && { description: def.description }),
          required: def.default === undefined,
        })),
      });
    } catch {
      out.push({ name });
    }
  }
  return out;
}
