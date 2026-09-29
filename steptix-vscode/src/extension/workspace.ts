import * as vscode from 'vscode';
import type { FrameInfo } from 'steptix-runner-core';

/**
 * Resolve the workspace folder that contains the given document URI.
 * Returns null when the document lives outside any workspace folder
 * (e.g. file opened ad-hoc with no folder open) — callers must surface STX030.
 */
export function workspaceFolderFor(uri: vscode.Uri): vscode.WorkspaceFolder | null {
  return vscode.workspace.getWorkspaceFolder(uri) ?? null;
}

/**
 * Which FILE a step event's `line` belongs to.
 *
 * A run that descends into a `[skill: ...]` reports its body steps with lines
 * in the SKILL's file, not the test's. Anything that turns one of those lines
 * into a location — a gutter decoration, a Test Explorer failure peek — has to
 * resolve the frame first, or it anchors a skill's line number onto the test
 * file and points at whatever happens to sit there.
 *
 * `frame.uri` is a plain absolute filesystem path. The protocol's own comment
 * called it "file:// URI form", which is wrong: every producer
 * (`ExpandedFrame.uri` from `skill.filePath` / `ctx.sectionsFilePath`, and the
 * synthesised test frame from `request.testFilePath`) passes an fsPath, and
 * there is no `file://` anywhere in the server's frame code. Hence
 * `Uri.file`, not `Uri.parse` — `Uri.parse` would silently read `C:` as a
 * scheme on Windows.
 *
 * No frame (older servers, or a top-level step) means the test file itself.
 */
export function frameTargetUri(testUri: vscode.Uri, frame: FrameInfo | undefined): vscode.Uri {
  if (!frame) return testUri;
  return vscode.Uri.file(frame.uri);
}
