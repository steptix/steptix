import * as vscode from 'vscode';
import {
  isWebviewMsg,
  type WebviewToHostMsg,
} from 'ai-ui-automation-runner-core';
import { buildWebviewHtml } from './webview-html.js';
import { openAsPlainMarkdown, shouldClaimDocument } from './editor-binding.js';
import { RunController } from './run-controller.js';
import { workspaceFolderFor } from './workspace.js';
import { getOutputChannel } from './output-channel.js';

export const VIEW_TYPE = 'testbench.editor';

/**
 * Custom text editor provider. One instance backs all TestBench editors;
 * each `resolveCustomTextEditor` call wires up a fresh webview panel and
 * its own RunController.
 */
export class TestBenchEditorProvider implements vscode.CustomTextEditorProvider {
  /** Track active controllers so commands can target the focused editor. */
  private readonly controllers = new Map<vscode.Uri, RunController>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  controllerFor(uri: vscode.Uri): RunController | undefined {
    for (const [key, value] of this.controllers) {
      if (key.toString() === uri.toString()) return value;
    }
    return undefined;
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    // Hand non-test markdown back to the default editor.
    if (!shouldClaimDocument(document)) {
      panel.dispose();
      await openAsPlainMarkdown(document.uri);
      return;
    }

    const folder = workspaceFolderFor(document.uri);
    if (!folder) {
      panel.webview.options = { enableScripts: false };
      panel.webview.html = buildNoWorkspaceHtml();
      return;
    }

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
      ],
    };
    panel.webview.html = await buildWebviewHtml(this.context, panel.webview);

    const controller = new RunController({
      document,
      webview: panel.webview,
      workspaceFolder: folder,
    });
    this.controllers.set(document.uri, controller);

    // Forward webview → host messages.
    const sub = panel.webview.onDidReceiveMessage((raw: unknown) => {
      if (!isWebviewMsg(raw)) {
        getOutputChannel().appendLine(`ignored unknown webview message: ${JSON.stringify(raw)}`);
        return;
      }
      void this.handleWebviewMessage(controller, document, raw);
    });

    // Forward external document edits → webview so the editor stays in sync.
    const docSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      void panel.webview.postMessage({
        type: 'documentChanged',
        text: e.document.getText(),
      });
    });

    // Forward setting changes (just wordWrap for now).
    const settingsSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('testbench.editor.wordWrap')) return;
      const wordWrap = vscode.workspace
        .getConfiguration('testbench')
        .get<boolean>('editor.wordWrap', true);
      void panel.webview.postMessage({ type: 'settingsChanged', wordWrap });
    });

    panel.onDidDispose(() => {
      controller.stop();
      this.controllers.delete(document.uri);
      sub.dispose();
      docSub.dispose();
      settingsSub.dispose();
    });
  }

  private async handleWebviewMessage(
    controller: RunController,
    document: vscode.TextDocument,
    msg: WebviewToHostMsg,
  ): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        const wordWrap = vscode.workspace
          .getConfiguration('testbench')
          .get<boolean>('editor.wordWrap', true);
        controller.sendInit(wordWrap);
        break;
      }
      case 'run':
        await controller.runLines(msg.lines);
        break;
      case 'runAll':
        await controller.runAll();
        break;
      case 'stop':
        controller.stop();
        break;
      case 'edit': {
        // Persist webview edits back to the TextDocument.
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length),
        );
        edit.replace(document.uri, fullRange, msg.text);
        await vscode.workspace.applyEdit(edit);
        break;
      }
    }
  }
}

function buildNoWorkspaceHtml(): string {
  // Minimal HTML for the TB030 case — webview shows it without scripts.
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>TestBench</title>
<style>body{font-family:sans-serif;padding:24px;color:#ccc;background:#1e1e1e}h2{color:#f87171}</style>
</head><body>
<h2>TB030: TestBench needs an open folder.</h2>
<p>File → Open Folder and pick the folder containing your tests.</p>
</body></html>`;
}
