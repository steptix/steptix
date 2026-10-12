/**
 * The webview imports runner-core, and the import survives Vite.
 *
 * The webview used to keep hand copies of runner-core's step-line grammar,
 * because importing runner-core broke the Vite build. The copies drifted —
 * an indented step showed in the gutter and never ran (steptix/steptix#49) —
 * so now the webview imports `steptix-runner-core/dist/step-lines.js` and
 * vite.config.webview.js widens the CommonJS transform to cover it.
 *
 * Node resolving the import (every other webview test) proves nothing about
 * Vite, which is where it broke. So this builds the two webview modules that
 * import runner-core with Vite, the CommonJS setting read from the real
 * config, and calls the bundled functions. It also builds once WITHOUT that
 * setting and expects the failure, so the test is known to be able to fail.
 */

import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, loadConfigFromFile } from "vite";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRIES = {
  stepLines: path.join(PKG, "src", "webview", "lib", "step-lines-inline.js"),
  variablesPanel: path.join(PKG, "src", "webview", "lib", "variables-panel.js"),
};

const scratch = await mkdtemp(path.join(os.tmpdir(), "steptix-webview-smoke-"));
after(() => rm(scratch, { recursive: true, force: true, maxRetries: 5 }));

const loaded = await loadConfigFromFile(
  { command: "build", mode: "production" },
  path.join(PKG, "vite.config.webview.js"),
  PKG,
  "silent",
);
const commonjsOptions = loaded?.config.build?.commonjsOptions;

/** Bundle the entries to `outDir` as ES modules, the way the page gets them. */
function bundle(outDir, options) {
  return build({
    configFile: false,
    logLevel: "silent",
    root: PKG,
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      ...(options && { commonjsOptions: options }),
      lib: { entry: ENTRIES, formats: ["es"], fileName: (_format, name) => `${name}.mjs` },
    },
  });
}

/** steptix/steptix#49's shape: two indented steps, then two at the margin. */
const INDENTED = [
  "# T", //                                   1
  "## Steps", //                              2
  "  1. Open the start page", //              3
  "  2. Read the order number [store as: order_id]", // 4
  "3. Click Next", //                         5
  "   1. Nested under step 3, not a step [output: nested]", // 6
  "4. Click Save", //                         7
].join("\n");

test("the webview config widens the CommonJS transform to runner-core's dist", () => {
  assert.ok(commonjsOptions, "vite.config.webview.js sets no build.commonjsOptions");
  const include = [commonjsOptions.include].flat();
  const runnerCoreFile = path.join(PKG, "..", "runner-core", "dist", "step-lines.js");
  assert.ok(
    include.some((pattern) => pattern instanceof RegExp && pattern.test(runnerCoreFile)),
    `no include pattern matches ${runnerCoreFile}`,
  );
});

test("bundled with the webview config, runner-core's functions are defined and answer", async () => {
  const outDir = path.join(scratch, "with-config");
  await bundle(outDir, commonjsOptions);

  const stepLines = await import(pathToFileURL(path.join(outDir, "stepLines.mjs")).href);
  assert.equal(typeof stepLines.extractStepLineIds, "function");
  assert.deepEqual(stepLines.extractStepLineIds(INDENTED), [3, 4, 5, 7]);

  const panel = await import(pathToFileURL(path.join(outDir, "variablesPanel.mjs")).href);
  const rows = panel.collectVariables(INDENTED, {}, {}, {});
  // The indented step's capture is listed; the nested line's is not, because
  // nothing runs it on its own.
  assert.deepEqual(
    rows.map((r) => [r.name, r.line]),
    [["order_id", 4]],
  );
});

test("without that setting the bundle fails, which is the failure the copies hid", async () => {
  await assert.rejects(bundle(path.join(scratch, "without-config"), undefined), /not exported|extractStepLineIds/);
});
