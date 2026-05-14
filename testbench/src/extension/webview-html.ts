import * as vscode from 'vscode';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Build the HTML for a webview panel: read Vite's emitted index.html, rewrite
 * asset URLs to webview URIs, and inject a CSP that VS Code requires.
 *
 * The CSP allows inline scripts/styles (Monaco needs them) and webview-asset-
 * relative loads. Workers come from the extension bundle; we allow `blob:`
 * because Monaco's worker plumbing constructs them at runtime.
 */
export async function buildWebviewHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
): Promise<string> {
  const distDir = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
  const indexPath = path.join(distDir.fsPath, 'index.html');
  let html = await fsp.readFile(indexPath, 'utf8');

  // Vite emits `./assets/...` references with `base: './'`. Rewrite each to
  // a webview URI so VS Code allows the resource through.
  html = html.replace(
    /(src|href)="\.\/(.+?)"/g,
    (_match, attr, rel) => {
      const onDisk = vscode.Uri.joinPath(distDir, rel);
      const uri = webview.asWebviewUri(onDisk).toString();
      return `${attr}="${uri}"`;
    },
  );

  // Strip Vite's `crossorigin` attribute. VS Code's webview-resource URIs do
  // not advertise CORS headers, so `crossorigin` on a <script> or <link> tag
  // makes the browser refuse to load the resource and the webview renders
  // blank with no obvious error.
  html = html.replace(/\s+crossorigin(="[^"]*")?/g, '');

  const csp = [
    `default-src 'none'`,
    `script-src ${webview.cspSource} 'unsafe-inline' 'unsafe-eval' blob:`,
    `script-src-elem ${webview.cspSource} 'unsafe-inline'`,
    `style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
    `style-src-elem ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src ${webview.cspSource} https://fonts.gstatic.com data:`,
    `img-src ${webview.cspSource} data: https:`,
    `worker-src ${webview.cspSource} blob: data:`,
    `child-src ${webview.cspSource} blob: data:`,
    `connect-src ${webview.cspSource} https: http: ws: wss: data:`,
  ].join('; ');

  // Inject the meta CSP and the webview's resource root.
  const metaTag = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  html = html.replace(/<head>/i, `<head>\n  ${metaTag}`);

  // Inject a top-level error catcher and a visible loading message. If the
  // webview ends up blank, the loading text stays — tells us HTML loaded but
  // JS didn't run / didn't mount React. Caught errors are appended to the
  // page in plain text and posted to the host.
  //
  // CRITICAL: `acquireVsCodeApi()` may only be called once per webview. We
  // call it here and stash the handle on `window.__tbVsCodeApi` so the React
  // bundle can re-use it instead of attempting another (throwing) call.
  // Boot-time diagnostic shell. Stays hidden once React mounts content into
  // #root — without this, the loading message sits on top of the React UI
  // (min-height 100vh pushes the app off-screen) and users mistake the
  // working-but-hidden app for a load failure.
  const diagnosticHtml = `
<div id="testbench-loading" style="font-family: -apple-system, Segoe UI, sans-serif; padding: 24px; color: #ddd; background: #1e1e1e; box-sizing: border-box;">
  <h2 style="color: #4ec9b0; margin: 0 0 8px;">TestBench webview loaded</h2>
  <p style="margin: 0;">Waiting for the React app to mount&hellip;</p>
  <pre id="testbench-errors" style="color: #f48771; white-space: pre-wrap; font-family: Consolas, monospace; font-size: 12px; margin-top: 16px;"></pre>
</div>
<script>
  (function() {
    const loading = document.getElementById('testbench-loading');
    const errBox = document.getElementById('testbench-errors');
    const vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
    if (vscode) window.__tbVsCodeApi = vscode;
    function record(label, detail) {
      const line = '[' + label + '] ' + detail;
      if (errBox) errBox.textContent += line + '\\n';
      try { if (vscode) vscode.postMessage({ type: 'webviewError', label: label, detail: detail }); } catch (e) {}
    }
    window.addEventListener('error', function(e) {
      record('error', (e.message || '') + '  @ ' + (e.filename || '') + ':' + (e.lineno || '?'));
    });
    window.addEventListener('unhandledrejection', function(e) {
      record('unhandledrejection', String((e.reason && (e.reason.message || e.reason)) || e));
    });
    record('boot', 'inline diagnostic script ran');

    // Hide the loading shell once React mounts content into #root. Watch
    // for the first child being added — that's the React tree taking over.
    // If a runtime error stops React from mounting (errBox has lines), the
    // shell stays visible so the diagnostics remain on-screen.
    const root = document.getElementById('root');
    if (root && window.MutationObserver) {
      const observer = new MutationObserver(function() {
        if (root.childNodes.length > 0 && loading && (!errBox || errBox.textContent.trim().split('\\n').filter(Boolean).length <= 1)) {
          loading.style.display = 'none';
          observer.disconnect();
        }
      });
      observer.observe(root, { childList: true });
    }
  })();
</script>`;
  html = html.replace(/<div id="root"><\/div>/i, `${diagnosticHtml}\n<div id="root"></div>`);

  return html;
}
