/**
 * A test's `## Config` baseUrl, made something a browser can open.
 *
 * A baseUrl that begins with `./` or `../` is a path relative to the test
 * file, for a page that lives in the project beside its tests: the sample
 * project's own page (docs/specs/SPEC-install.md §7.3), which has to work
 * wherever the project was created, with no network. It becomes the file's
 * `file://` URL. Anything else is passed on exactly as written, as before.
 *
 * runner-core/src/base-url.ts is a deliberate copy for the VS Code
 * extension, which cannot import the framework;
 * tests/base-url-parity.test.ts holds the two together.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function resolveBaseUrl(value: string, testFile: string): string {
  const trimmed = value.trim();
  if (!/^\.\.?[\\/]/.test(trimmed)) return value;
  return pathToFileURL(path.resolve(path.dirname(testFile), trimmed)).href;
}
