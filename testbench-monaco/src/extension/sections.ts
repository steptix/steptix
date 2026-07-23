/**
 * Inline-section detection for testbench-monaco.
 *
 * This variant has no sections support — it sends no definitions to the
 * server and cannot expand a bare-name call. So instead of mis-running a
 * sectioned file (shipping the call step to the AI as a literal instruction
 * while the body never runs), it REFUSES one. This is the predicate behind
 * that refusal.
 *
 * A one-line wrapper, but in its own vscode-free module so it is unit-testable
 * under `node --test` — the run-controller imports `vscode`, so anything
 * reachable from there is integration-only.
 *
 * See testbench-native/stories/specs/inline-sections-runtime.md §8.
 */
import { extractSections } from 'ai-ui-automation-runner-core';

/**
 * Whether `text` defines any inline section (`### Name` inside `## Steps`).
 *
 * Uses the shared `extractSections`, so it agrees exactly with what the CLI
 * and testbench-native treat as a section — the refusal fires on precisely
 * the files those two would expand, and never on a plain `###` subheading
 * outside the Steps span. Empty-name (`###`-only) and duplicate-name files
 * count too: `extractSections` surfaces them, and they are unrunnable
 * everywhere.
 */
export function usesInlineSections(text: string): boolean {
  return extractSections(text).length > 0;
}
