/**
 * The words on the editor's agent marks (docs/specs/SPEC-use-agent.md §5.6):
 * why a step runs as an agent step, in the same terms the report's badge
 * tooltip uses (§8.2), so the editor and the report never disagree.
 *
 * No `vscode` import, so the node:test suite can load it.
 */

import type { AgentScopeStep } from 'steptix-runner-core';

export function agentMarkHover(step: AgentScopeStep): string {
  switch (step.reason) {
    case 'prefix':
      return 'Runs as an agent step: it starts with [use agent].';
    case 'section':
      return `Runs as an agent step: section "${step.section ?? ''}" opens with [use agent]. Mark a step [no-agent] to run it as an ordinary step.`;
    case 'main-flow':
      return 'Runs as an agent step: the main flow opens with [use agent]. Mark a step [no-agent] to run it as an ordinary step.';
    case 'file':
      return 'Runs as an agent step: this file says agent: on. Mark a step [no-agent] to run it as an ordinary step.';
  }
}

export function agentOptedOutHover(): string {
  return '[no-agent]: this step runs as an ordinary step inside an agent scope.';
}
