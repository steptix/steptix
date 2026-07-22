import { test } from "node:test";
import { strict as assert } from "node:assert";
import { collectVariables, classifyCaptureSource } from "../src/webview/lib/variables-panel.js";

test("collectVariables: empty text + no values → empty list", () => {
  assert.deepEqual(collectVariables("", {}, {}), []);
});

test("collectVariables: surfaces declared parameters with their resolved values", () => {
  const text = ["## Parameters", "- username: $USERNAME", "## Steps", "1. open"].join("\n");
  const got = collectVariables(text, { username: "alice" }, {});
  assert.deepEqual(got, [
    { name: "username", source: "param", value: "alice" },
  ]);
});

test("collectVariables: declared parameters with no value show empty string", () => {
  const text = ["## Parameters", "- region: $REGION", "## Steps", "1. open"].join("\n");
  const got = collectVariables(text, { region: "" }, {});
  assert.equal(got[0].name, "region");
  assert.equal(got[0].value, "");
});

test("collectVariables: surfaces [input: var] from steps with no value yet", () => {
  const text = ["## Steps", "1. [input: code] paste OTP"].join("\n");
  const got = collectVariables(text, {}, {});
  assert.deepEqual(got, [
    { name: "code", source: "input", line: 2, value: undefined },
  ]);
});

test("collectVariables: surfaces [output: var] from steps with no value yet", () => {
  const text = ["## Steps", "1. [output: orderId] grab the order ID"].join("\n");
  const got = collectVariables(text, {}, {});
  assert.deepEqual(got, [
    { name: "orderId", source: "output", line: 2, value: undefined },
  ]);
});

test("collectVariables: runtime values fill in for outputs/inputs after a run", () => {
  const text = ["## Steps", "1. [input: pin] PIN", "2. [output: orderId] grab"].join("\n");
  const got = collectVariables(text, {}, { pin: "1234", orderId: "ORD-9" });
  assert.equal(got.find((v) => v.name === "pin").value, "1234");
  assert.equal(got.find((v) => v.name === "orderId").value, "ORD-9");
});

test("collectVariables: runtime values override resolved parameter values", () => {
  // Useful if a later [output:] reuses a name declared as a parameter.
  const text = ["## Parameters", "- token: $TOKEN", "## Steps", "1. open"].join("\n");
  const got = collectVariables(text, { token: "static" }, { token: "live-value" });
  assert.equal(got.find((v) => v.name === "token").value, "live-value");
});

test("collectVariables: parameters come before steps-declared vars in the output", () => {
  const text = [
    "## Parameters",
    "- a: $A",
    "## Steps",
    "1. [output: b] something",
    "2. [input: c] something",
  ].join("\n");
  const got = collectVariables(text, { a: "A_VAL" }, {});
  assert.deepEqual(got.map((v) => v.name), ["a", "b", "c"]);
});

test("collectVariables: deduplicates if same name appears in multiple sources (param wins)", () => {
  const text = [
    "## Parameters",
    "- shared: $X",
    "## Steps",
    "1. [output: shared] also captured",
  ].join("\n");
  const got = collectVariables(text, { shared: "from-param" }, {});
  assert.equal(got.length, 1);
  assert.equal(got[0].source, "param");
});

test("collectVariables: ignores [input:]/[output:] markers outside ## Steps section", () => {
  const text = [
    "# Notes",
    "1. [output: foo] in prose, not a step",
    "## Steps",
    "1. real",
  ].join("\n");
  const got = collectVariables(text, {}, {});
  assert.deepEqual(got, []);
});

test("collectVariables: case-insensitive [INPUT:] / [OUTPUT:] markers", () => {
  const text = ["## Steps", "1. [INPUT: x] hi", "2. [Output: y] bye"].join("\n");
  const got = collectVariables(text, {}, {});
  assert.deepEqual(got.map((v) => v.name), ["x", "y"]);
});

test("collectVariables: [skill: foo out.x=\"alias\"] surfaces alias as an output", () => {
  // Real-world shape from skill-demo.md — caller exposes the skill's
  // captured value under a friendlier name and references it
  // downstream as `{{target_url}}`. Without surfacing the alias the
  // panel hides the value the user can actually see at runtime.
  const text = [
    "## Steps",
    "1. [skill: duckduckgo_search query=\"OpenAI GPT-5\" out.first_result_url=\"target_url\"]",
    "2. Navigate to {{target_url}}",
  ].join("\n");
  const got = collectVariables(text, {}, { target_url: "https://example.com" });
  const target = got.find((v) => v.name === "target_url");
  assert.ok(target, `target_url not found in ${JSON.stringify(got)}`);
  assert.equal(target.source, "output");
  assert.equal(target.value, "https://example.com");
});

test("collectVariables: multiple out.X=\"Y\" aliases on a single skill call", () => {
  const text = [
    "## Steps",
    "1. [skill: foo out.a=\"first\" out.b=\"second\"]",
  ].join("\n");
  const got = collectVariables(text, {}, { first: "F", second: "S" });
  const names = got.map((v) => v.name);
  assert.ok(names.includes("first"), `missing first: ${names}`);
  assert.ok(names.includes("second"), `missing second: ${names}`);
  assert.equal(got.find((v) => v.name === "first").value, "F");
  assert.equal(got.find((v) => v.name === "second").value, "S");
});

// ── Output-source tagging (spec test plan item 11) ────────────────────

test("classifyCaptureSource: 'toolOutput' passes through", () => {
  assert.equal(classifyCaptureSource("toolOutput"), "toolOutput");
});

test("classifyCaptureSource: 'capture' passes through", () => {
  assert.equal(classifyCaptureSource("capture"), "capture");
});

test("classifyCaptureSource: absent source defaults to 'capture' (back-compat)", () => {
  assert.equal(classifyCaptureSource(undefined), "capture");
});

test("classifyCaptureSource: unrecognised source defaults to 'capture'", () => {
  // A future/garbage value must not leak through as a non-capture label.
  assert.equal(classifyCaptureSource("parameter"), "capture");
  assert.equal(classifyCaptureSource("bogus"), "capture");
  assert.equal(classifyCaptureSource(null), "capture");
});

test("collectVariables: capture-sourced [output:] row is annotated captureSource='capture'", () => {
  const text = ["## Steps", "1. [output: pageTitle] grab the title"].join("\n");
  const got = collectVariables(
    text,
    {},
    { pageTitle: "Welcome" },
    { pageTitle: "capture" },
  );
  const row = got.find((v) => v.name === "pageTitle");
  assert.equal(row.value, "Welcome");
  assert.equal(row.captureSource, "capture");
});

test("collectVariables: toolOutput-sourced row is annotated captureSource='toolOutput'", () => {
  // Skill aliases its captured value into the caller's scope; the
  // streaming capture event carried source: 'toolOutput'.
  const text = [
    "## Steps",
    '1. [skill: search query="x" out.first_result_url="target_url"]',
  ].join("\n");
  const got = collectVariables(
    text,
    {},
    { target_url: "https://example.com" },
    { target_url: "toolOutput" },
  );
  const row = got.find((v) => v.name === "target_url");
  assert.equal(row.source, "output");
  assert.equal(row.captureSource, "toolOutput");
});

test("collectVariables: a row with no matching runtimeSources entry has no captureSource", () => {
  const text = ["## Steps", "1. [output: pageTitle] grab"].join("\n");
  const got = collectVariables(text, {}, { pageTitle: "T" }, {});
  assert.equal(got.find((v) => v.name === "pageTitle").captureSource, undefined);
});

test("collectVariables: absent source map renders captures normally (no crash, no badge)", () => {
  // Legacy server: capture event omitted `source`, so the webview never
  // populated runtimeSources for this name. Row must still render with a
  // value and simply carry no captureSource (the React layer shows no
  // tool badge).
  const text = ["## Steps", "1. [output: legacyVar] grab"].join("\n");
  const got = collectVariables(text, {}, { legacyVar: "v" });
  const row = got.find((v) => v.name === "legacyVar");
  assert.equal(row.value, "v");
  assert.equal(row.captureSource, undefined);
});

test("collectVariables: distinguishes parameter, page capture, and tool output in one file", () => {
  const text = [
    "## Parameters",
    "- user: $USER",
    "## Steps",
    "1. [output: pageTitle] grab the title",
    '2. [skill: search query="x" out.url="resultUrl"]',
  ].join("\n");
  const got = collectVariables(
    text,
    { user: "alice" },
    { pageTitle: "Home", resultUrl: "https://example.com" },
    { pageTitle: "capture", resultUrl: "toolOutput" },
  );
  const byName = Object.fromEntries(got.map((v) => [v.name, v]));
  // Parameter: no captureSource (arrives via parametersResolved path).
  assert.equal(byName.user.source, "param");
  assert.equal(byName.user.captureSource, undefined);
  // Page capture.
  assert.equal(byName.pageTitle.captureSource, "capture");
  // Tool output — the visually distinct one.
  assert.equal(byName.resultUrl.captureSource, "toolOutput");
});

/**
 * Inline sections: body-line rows must survive.
 *
 * `collectVariables` scans every numbered line in the `## Steps` span via its
 * own private `findStepsSpan`, so an `[input:]` or `[output:]` inside a
 * section body is picked up today. Contract §5 lists this under "main + body,
 * preserve rows": the requirement is only that a section-aware span must not
 * start dropping them. Without this pin, a later change that reuses
 * runner-core's main-flow-only step model here would silently empty the
 * variables panel for every sectioned test.
 */
test("collectVariables: picks up [input:] and [output:] inside a section body", () => {
  const text = [
    "## Steps",
    "1. Login",
    "",
    "### Login",
    "1. [input: username] Who is signing in?",
    "2. Type it",
    "3. [output: sessionId]",
  ].join("\n");

  const got = collectVariables(text, {}, { username: "alice" });
  const byName = Object.fromEntries(got.map((v) => [v.name, v]));

  assert.ok(byName.username, "body [input:] row was dropped");
  assert.equal(byName.username.line, 5);
  assert.ok(byName.sessionId, "body [output:] row was dropped");
  assert.equal(byName.sessionId.line, 7);
});

test("collectVariables: a section heading does not truncate the scan", () => {
  // The span must still run to the next depth<=2 heading, not stop at `###`.
  const text = [
    "## Steps",
    "1. [input: first]",
    "",
    "### S",
    "1. [input: second]",
    "",
    "## Outputs",
    "- x",
  ].join("\n");

  const names = collectVariables(text, {}, {}).map((v) => v.name);
  assert.deepEqual(names, ["first", "second"]);
});
