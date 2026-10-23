/**
 * A test's `## Config` baseUrl, made something a browser can open: one that
 * begins with `./` or `../` is a path relative to the test file and becomes
 * that file's `file://` URL; anything else is passed on as written.
 *
 * A deliberate copy of `resolveBaseUrl` in the framework's
 * src/utils/base-url.ts, which says why the rule exists; runner-core cannot
 * import the framework. tests/base-url-parity.test.ts in the framework holds
 * the two together.
 */

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export function resolveBaseUrl(value: string, testFile: string): string {
  const trimmed = value.trim();
  if (!/^\.\.?[\\/]/.test(trimmed)) return value;
  return pathToFileURL(path.resolve(path.dirname(testFile), trimmed)).href;
}
