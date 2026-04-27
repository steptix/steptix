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

  const csp = [
    `default-src 'none'`,
    `script-src ${webview.cspSource} 'unsafe-inline' 'unsafe-eval'`,
    `style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src ${webview.cspSource} https://fonts.gstatic.com data:`,
    `img-src ${webview.cspSource} data: https:`,
    `worker-src ${webview.cspSource} blob:`,
    `connect-src ${webview.cspSource} https: http: data:`,
  ].join('; ');

  // Inject the meta CSP and the webview's resource root.
  const metaTag = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  html = html.replace(/<head>/i, `<head>\n  ${metaTag}`);

  return html;
}
