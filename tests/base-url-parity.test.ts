/**
 * A test's baseUrl beginning ./ or ../ is a page beside the test
 * (src/utils/base-url.ts). The VS Code extension resolves it with runner-core's
 * copy, the CLI and the MCP server with the framework's; held together here.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveBaseUrl } from '../src/utils/base-url.js';
// runner-core's source, as control-line-parity.test.ts explains.
import { resolveBaseUrl as coreResolve } from '../runner-core/src/base-url.ts';

const testFile = path.resolve(path.sep, 'projects', 'shop', 'tests', 'login.md');

describe('resolveBaseUrl', () => {
  it('turns a path beside the test into its file URL', () => {
    expect(resolveBaseUrl('../pages/sample-page.html', testFile)).toBe(
      pathToFileURL(path.resolve(path.sep, 'projects', 'shop', 'pages', 'sample-page.html')).href,
    );
    expect(resolveBaseUrl('./here.html', testFile)).toBe(
      pathToFileURL(path.resolve(path.sep, 'projects', 'shop', 'tests', 'here.html')).href,
    );
  });

  it('leaves everything else as written', () => {
    for (const value of ['https://example.test/app', 'http://localhost:3000', 'file:///srv/page.html', 'data:text/html,<h1>x</h1>', 'pages/page.html', '$BASE_URL']) {
      expect(resolveBaseUrl(value, testFile)).toBe(value);
    }
  });

  it.runIf(process.platform === 'win32')('takes a backslash too, on Windows', () => {
    expect(resolveBaseUrl('..\\pages\\p.html', testFile)).toBe(
      pathToFileURL(path.resolve(path.sep, 'projects', 'shop', 'pages', 'p.html')).href,
    );
  });

  it("gives runner-core's copy the same answers", () => {
    for (const value of ['../pages/sample-page.html', './a.html', ' ../b.html ', 'https://example.test', 'pages/x.html', '..\\c.html']) {
      expect(coreResolve(value, testFile)).toBe(resolveBaseUrl(value, testFile));
    }
  });
});
