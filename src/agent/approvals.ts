/**
 * The Allow/Deny question and what a run remembers of its answers
 * (docs/specs/SPEC-use-agent.md §6.3).
 *
 * Only the VS Code extension can answer, for a run a person started; it sends
 * `StepRequest.canApprove: true` on every batch of such a run. Everyone else
 * — the CLI, CI, MCP, raw Sessions API callers — gets the allow list as the
 * whole answer. Computer mode never asks (the question would appear on the
 * screen the agent drives), and once a question goes unanswered the rest of
 * the run asks nothing.
 */

import type { AgentApprovalRecord } from '../report/types.js';
import { matchesPattern } from './commands.js';

export type ApprovalAnswer = 'allow-once' | 'allow-run' | 'deny-once' | 'deny-run';

/** Why a question closed without an answer (§6.3's closing table). The window
 *  that started the run closing is `stopped`: closing it ends the run's event
 *  stream, which stops the run, as Stop does. */
export type ApprovalClosed = 'timeout' | 'stopped';

export interface ApprovalQuestion {
  /** The command part being asked about. */
  command: string;
  /** Its folder, as shown. */
  folder: string;
  /** The step's line as the person knows it, e.g. `step 2 of month-end.md`. */
  stepLabel: string;
  /** The pattern a "for this run" answer covers. */
  pattern: string;
  /** Milliseconds the question waits. */
  timeoutMs: number;
}

/** Whoever can put a question to a person. Resolves with an answer or with
 *  why the question closed; never rejects. */
export interface ApprovalAsker {
  ask(question: ApprovalQuestion, signal?: AbortSignal): Promise<{ answer: ApprovalAnswer } | { closed: ApprovalClosed }>;
}

/**
 * What one run remembers (§6.3, "Remembering for the run"): the patterns
 * allowed or denied for the rest of the run, whether a question went
 * unanswered, and the records the report lists under *Approvals this run*.
 *
 * Part of a run's `AgentRunState`, so it lasts exactly as long as the run:
 * across the rows of a row loop, later agent steps and a Continue after a
 * breakpoint, and no further — a new run starts with nothing remembered.
 */
export class RunApprovals {
  readonly allowed: string[] = [];
  readonly denied: string[] = [];
  /** A question went unanswered: no more questions this run. */
  unanswered = false;
  readonly records: AgentApprovalRecord[] = [];

  /** A remembered answer that covers `part`, if any. */
  remembered(part: string): { allow: boolean; pattern: string } | undefined {
    const deny = this.denied.find((p) => matchesPattern(part, p));
    if (deny !== undefined) return { allow: false, pattern: deny };
    const allow = this.allowed.find((p) => matchesPattern(part, p));
    if (allow !== undefined) return { allow: true, pattern: allow };
    return undefined;
  }

  /** Record a "for the rest of this run" answer. */
  remember(answer: 'allow-run' | 'deny-run', pattern: string, step: number): void {
    (answer === 'allow-run' ? this.allowed : this.denied).push(pattern);
    this.records.push({ pattern, answer, step, at: new Date().toISOString() });
  }

  /** Record a question nobody answered; the rest of the run asks nothing. */
  markUnanswered(pattern: string, step: number): void {
    this.unanswered = true;
    this.records.push({ pattern, answer: 'unanswered', step, at: new Date().toISOString() });
  }
}
