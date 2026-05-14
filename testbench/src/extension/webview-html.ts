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

  // Acquire the VS Code API exactly once and stash it on window for the
  // React bundle to re-use — `acquireVsCodeApi()` throws on a second call.
  // Also forward window-level errors to the host so a blank webview is
  // diagnosable from the extension side.
  const bootScript = `<script>
  (function() {
    try {
      const api = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
      if (api) window.__tbVsCodeApi = api;
      function post(label, detail) {
        try { if (api) api.postMessage({ type: 'webviewError', label: label, detail: detail }); } catch (e) {}
      }
      window.addEventListener('error', function(e) {
        post('error', (e.message || '') + '  @ ' + (e.filename || '') + ':' + (e.lineno || '?'));
      });
      window.addEventListener('unhandledrejection', function(e) {
        post('unhandledrejection', String((e.reason && (e.reason.message || e.reason)) || e));
      });
    } catch (e) {}
  })();
</script>`;
  html = html.replace(/<div id="root"><\/div>/i, `${bootScript}\n<div id="root"></div>`);

  return html;
}
