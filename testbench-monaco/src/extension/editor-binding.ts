import * as vscode from 'vscode';
import { isTestFile } from 'ai-ui-automation-runner-core';

/**
 * Decide whether the TestBench custom editor should claim this document.
 * The customEditor contribution is registered with priority `default` for
 * `*.md`, but we let through plain markdown by reopening it in VS Code's
 * default editor when:
 *   - the user has set `testbench.openMarkdownAsTest` to false, or
 *   - the document body has no `## Steps` heading.
 */
export function shouldClaimDocument(document: vscode.TextDocument): boolean {
  // Source Control diffs and other read-only views use schemes like `git`,
  // `gitlens`, `vscode-scm`, `diff`, etc. The custom editor must stay out
  // of those — diff/compare views need the plain text editor to render
  // change decorations and inline edits.
  if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
    return false;
  }
  const settings = vscode.workspace.getConfiguration('testbench');
  if (settings.get<boolean>('openMarkdownAsTest') === false) return false;
  return isTestFile(document.getText());
}

/** Hand off to VS Code's default text editor for the same URI. */
export async function openAsPlainMarkdown(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
}
