import * as vscode from 'vscode';

/**
 * Resolve the workspace folder that contains the given document URI.
 * Returns null when the document lives outside any workspace folder
 * (e.g. file opened ad-hoc with no folder open) — callers must surface TB030.
 */
export function workspaceFolderFor(uri: vscode.Uri): vscode.WorkspaceFolder | null {
  return vscode.workspace.getWorkspaceFolder(uri) ?? null;
}
