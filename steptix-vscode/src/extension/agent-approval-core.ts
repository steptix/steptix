/**
 * The words of the agent's Allow/Deny question (docs/specs/SPEC-use-agent.md
 * §6.3), apart from the QuickPick that shows them, so the node:test suite can
 * load them without `vscode`.
 */

import type { AgentApprovalAnswer } from 'steptix-runner-core';

export interface ApprovalChoice {
  label: string;
  answer: AgentApprovalAnswer;
}

/** The four choices, in §6.3's order, the pattern named in the run-long two. */
export function approvalChoices(pattern: string): ApprovalChoice[] {
  return [
    { label: 'Allow once', answer: 'allow-once' },
    { label: `Allow "${pattern}" for the rest of this run`, answer: 'allow-run' },
    { label: 'Deny once', answer: 'deny-once' },
    { label: `Deny "${pattern}" for the rest of this run`, answer: 'deny-run' },
  ];
}

/** The title, with the seconds left. */
export function approvalTitle(secondsLeft: number): string {
  return `Steptix agent wants to run a command (${Math.max(0, secondsLeft)} s)`;
}
