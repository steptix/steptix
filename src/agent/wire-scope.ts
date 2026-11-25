/**
 * `StepRequest.agent` for a batch read from a file (docs/specs/SPEC-use-agent.md
 * §5.7): `file` when the frontmatter says `agent: on`; `steps` the positions
 * in the batch whose line is an agent step because its block opens with a bare
 * `[use agent]` — a section line sent on its own included, since it reaches
 * the server as a root step; and `optedOut` the positions of `[no-agent]`
 * steps in a scope (§8.6). A prefixed step needs none of them.
 *
 * The extension builds the same field from runner-core's `agentScopeOf`; this
 * is the `src/` side, for MCP's `run_test_file` and anything else that reads a
 * file itself.
 */

import { agentScopeOf } from '../parser/agent-scope.js';

export function agentWireScopeOf(
  text: string,
  filePath: string,
  /** The batch's `sourceLines`: the file line of each position in `steps`. */
  sourceLines: readonly number[],
): { file?: boolean; steps?: number[]; optedOut?: number[] } | undefined {
  let scope;
  try {
    scope = agentScopeOf(text, filePath);
  } catch {
    return undefined;
  }
  const byScope = new Set(scope.steps.filter((s) => s.reason !== 'prefix' && s.reason !== 'file').map((s) => s.line));
  const opted = new Set(scope.optedOut);
  const steps = sourceLines.flatMap((line, position) => (byScope.has(line) ? [position] : []));
  // `[no-agent]` steps in a scope, so the report's *opted out* marker agrees
  // with the editor's (§8.6).
  const optedOut = sourceLines.flatMap((line, position) => (opted.has(line) ? [position] : []));
  if (!scope.file && steps.length === 0 && optedOut.length === 0) return undefined;
  return {
    ...(scope.file && { file: true }),
    ...(steps.length > 0 && { steps }),
    ...(optedOut.length > 0 && { optedOut }),
  };
}
