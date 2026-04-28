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
    const out = getOutputChannel();
    const ts = () => new Date().toISOString().slice(11, 23);
    out.appendLine(`[${ts()}] resolveCustomTextEditor: ${document.uri.fsPath}`);

    // Source Control diffs and similar read-only views use schemes like
    // `git`, `gitlens`, `vscode-scm`, `diff`. The custom editor must stay
    // out — close the panel async so VS Code can fall back to the default
    // diff editor. Synchronous dispose during resolveCustomTextEditor
    // races claimWebview/setInput; the setTimeout sidesteps that.
    if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
      out.appendLine(`[${ts()}]   non-file scheme "${document.uri.scheme}" — yielding to default editor`);
      panel.webview.options = { enableScripts: false };
      panel.webview.html = '';
      setTimeout(() => {
        try { panel.dispose(); } catch { /* already gone */ }
      }, 0);
      return;
    }

    const claim = shouldClaimDocument(document);
    out.appendLine(`[${ts()}]   shouldClaimDocument=${claim} (testbench.openMarkdownAsTest=${vscode.workspace.getConfiguration('testbench').get('openMarkdownAsTest')})`);

    // For non-test markdown, render a redirect page rather than disposing the
    // panel. Disposing inside resolveCustomTextEditor races with VS Code's
    // internal claimWebview/setInput flow and triggers OverlayWebview errors.
    // The redirect button calls vscode.openWith on click — the user's one
    // click is the price of staying out of VS Code's lifecycle.
    if (!claim) {
      panel.webview.options = { enableScripts: true };
      panel.webview.html = buildNonTestRedirectHtml();
      panel.webview.onDidReceiveMessage(async (raw: unknown) => {
        if (raw && typeof raw === 'object' && (raw as { type?: string }).type === 'openAsText') {
          await openAsPlainMarkdown(document.uri);
        }
      });
      return;
    }

    const folder = workspaceFolderFor(document.uri);
    out.appendLine(`[${ts()}]   workspaceFolder=${folder?.uri.fsPath ?? '(none)'}`);
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

    const controller = new RunController({
      document,
      webview: panel.webview,
      workspaceFolder: folder,
    });
    this.controllers.set(document.uri, controller);

    // CRITICAL: attach the message listener BEFORE setting webview.html.
    // Setting .html starts the webview's script execution, which can post
    // `ready` immediately. VS Code drops messages whose listener isn't
    // attached yet — that races our init handshake.
    const sub = panel.webview.onDidReceiveMessage((raw: unknown) => {
      // Diagnostic channel: the inline boot script in webview-html posts
      // `webviewError` and `boot` events directly to the host so we can see
      // CSP/script-load failures in the TestBench output channel.
      if (raw && typeof raw === 'object' && (raw as { type?: string }).type === 'webviewError') {
        const r = raw as { label?: string; detail?: string };
        getOutputChannel().appendLine(`[webview ${r.label}] ${r.detail}`);
        return;
      }
      if (!isWebviewMsg(raw)) {
        getOutputChannel().appendLine(`ignored unknown webview message: ${JSON.stringify(raw)}`);
        return;
      }
      void this.handleWebviewMessage(controller, document, raw);
    });

    // Now that the message listener is attached, hand the webview its HTML.
    panel.webview.html = await buildWebviewHtml(this.context, panel.webview);

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
      // Best-effort: tell the server to drop the session + close its browser.
      // Errors here don't matter — the user closed the tab; the server will
      // garbage-collect on its own schedule too.
      void controller.closeSession().catch(() => {});
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
        getOutputChannel().appendLine(
          `[webview ready] sending init: ${document.getText().length} chars, wordWrap=${wordWrap}`,
        );
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
      case 'restartSession':
        await controller.closeSession();
        vscode.window.setStatusBarMessage(
          'TestBench: session closed — next F5 starts a fresh browser',
          3000,
        );
        break;
      case 'promptResponse':
        controller.resolvePrompt(msg.text);
        break;
      case 'promptCancel':
        controller.cancelPrompt();
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

function buildNonTestRedirectHtml(): string {
  // Shown when a .md without a "## Steps" heading lands on the TestBench
  // editor. Clicking the button posts back to the host which re-opens the
  // file in the default text editor.
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>TestBench</title>
<style>
  body{font-family:-apple-system,Segoe UI,sans-serif;padding:32px;color:#ddd;background:#1e1e1e;min-height:100vh;box-sizing:border-box;margin:0;}
  h2{color:#4ec9b0;margin-top:0;}
  p{line-height:1.55;}
  button{margin-top:16px;padding:8px 14px;background:#0e639c;color:#fff;border:0;border-radius:4px;font-size:13px;cursor:pointer;}
  button:hover{background:#1177bb;}
  code{background:#252526;padding:2px 6px;border-radius:3px;}
</style>
</head><body>
<h2>Not a TestBench test file</h2>
<p>This Markdown file has no <code>## Steps</code> heading, so there's nothing for TestBench to run.</p>
<button id="open-text">Open as Plain Markdown</button>
<script>
  const vscode = acquireVsCodeApi();
  document.getElementById('open-text').addEventListener('click', () => {
    vscode.postMessage({ type: 'openAsText' });
  });
</script>
</body></html>`;
}
