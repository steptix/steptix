import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  classifyCaptureSource,
  collectVariables,
  maskIfSecretAuthoredInline,
  maskIfSecretInline,
  maskRecordSecretsInline,
} from "../src/webview/lib/variables-panel.js";

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

// ---------------------------------------------------------------------------
// maskIfSecretInline — the panel's copy of runner-core's maskIfSecret
// ---------------------------------------------------------------------------
//
// The panel and the Variables view render the same scope through two
// implementations (the webview bundle imports nothing from runner-core), so
// the cases below are the ones repl.test.js pins on the other side. One of
// them showing a password the other masks is the whole bug.

test("maskIfSecretInline: the secret words, as substrings", () => {
  assert.equal(maskIfSecretInline("password", "hunter2"), "*******");
  assert.equal(maskIfSecretInline("GITHUB_PASSWORD", "hunter2"), "*******");
  assert.equal(maskIfSecretInline("api_key", "abc"), "***");
  assert.equal(maskIfSecretInline("apiKey", "abc"), "***");
  assert.equal(maskIfSecretInline("MACHINE_KEY", "abc"), "***");
  assert.equal(maskIfSecretInline("privateKey", "abc"), "***");
  assert.equal(maskIfSecretInline("payment.password", "abc"), "***");
});

// A flat name takes the server's `isSecretName` exactly — a SUBSTRING. Word
// boundaries were tried and leaked: `mypassword` and `apitoken` are one word
// to a splitter, so the panel showed values the report starred.
test("maskIfSecretInline: a flat name masks on a substring, as the report does", () => {
  for (const name of [
    "mypassword",
    "newpassword",
    "password2",
    "mytoken",
    "apitoken",
    "mysecret",
    "secret1",
    "MACHINE_KEY",
  ]) {
    assert.equal(maskIfSecretInline(name, "hunter2"), "*".repeat(7), name);
  }
});

// `pwd`/`otp`/`credential` are COLUMN words, not flat ones: the server prints
// a flat `pwd` in the report, the run log and the `## Values` block, so the
// panel prints it too.
test("maskIfSecretInline: pwd/otp/credential are column words, not flat ones", () => {
  for (const name of ["passwd", "pwd", "user_otp", "credential", "api_credentials"]) {
    assert.equal(maskIfSecretInline(name, "abc"), "abc", `flat ${name}`);
    assert.equal(maskIfSecretInline(`payment.${name}`, "abc"), "***", `column ${name}`);
  }
});

// The price of the server's breadth, stated rather than worked around: a FLAT
// `keyword` masks because the report masks it. The narrow rule applies where
// the name came off a page — `payment.keyword` below.
test("maskIfSecretInline: a flat name that merely contains one masks too", () => {
  assert.equal(maskIfSecretInline("keyword", "search"), "******");
  assert.equal(maskIfSecretInline("monkey", "george"), "******");
  assert.equal(maskIfSecretInline("username", "alice"), "alice");
  assert.equal(maskIfSecretInline("payment.payee", "Origin Energy"), "Origin Energy");
  assert.equal(maskIfSecretInline("payment.keyword", "search"), "search");
});

test("maskIfSecretInline: empty secret values say so, and long ones cap at 8", () => {
  assert.equal(maskIfSecretInline("password", ""), "(empty)");
  assert.equal(maskIfSecretInline("password", "a".repeat(50)), "*".repeat(8));
});

// A dotted name is `root.property`, and the property came off a page rather
// than out of the author's head — so the narrow record-column rule decides it
// (SPEC-structured-table-reads.md §7.6). The panel used to apply the broad
// word list to both halves and hid `payment.sort_key`, which the report
// prints.
test("maskIfSecretInline: a dotted property takes the record-column rule", () => {
  assert.equal(maskIfSecretInline("payment.sort_key", "abc"), "abc");
  assert.equal(maskIfSecretInline("payment.key", "K-1"), "K-1");
  assert.equal(maskIfSecretInline("payment.keys", "a,b"), "a,b");
  assert.equal(maskIfSecretInline("payment.apikey", "abc"), "abc");
  assert.equal(maskIfSecretInline("payment.api_key", "abc"), "***");
  assert.equal(maskIfSecretInline("payment.pwd", "abc"), "***");
  assert.equal(maskIfSecretInline("payment.otp", "abc"), "***");
});

test("maskIfSecretInline: the ROOT is still the author's word", () => {
  // A record the author stored as `token` says what it is by its name, so the
  // whole thing is hidden whatever its columns are called.
  assert.equal(maskIfSecretInline("token.payee", "Origin Energy"), "*".repeat(8));
  assert.equal(maskIfSecretInline("sort_key", "abc"), "***", "a FLAT name keeps the broad rule");
});

// ---------------------------------------------------------------------------
// What the run says about its own map: `bindings` and `unmask`
// ---------------------------------------------------------------------------
//
// The rule above is the reading for a name a `For each` pass bound, and the
// panel applied it to every dotted name because nothing on the wire said which
// ones a pass bound. So a data file's own `user.apikey` column heading —
// author-chosen end to end, and starred by the report — rendered
// `uk_live_1234` in the panel beside it. `frame:scope` now carries the list
// (`FrameScopeEvent.bindings`), and the run's `## Config: unmask:` names with
// it. The corpus that holds this mirror to runner-core's lives in
// `record-secret-parity.test.js`; these are the panel's own edges.

test("maskIfSecretInline: a dotted name nobody bound takes the flat author rule", () => {
  assert.equal(maskIfSecretInline("user.apikey", "uk_live_1234", { bindings: [] }), "*".repeat(8));
  assert.equal(maskIfSecretInline("payment.keyword", "search", { bindings: [] }), "******");
});

test("maskIfSecretInline: a dotted name a pass bound keeps the two-segment rule", () => {
  const bindings = ["payment.keyword", "payment.password"];
  assert.equal(maskIfSecretInline("payment.keyword", "AU", { bindings }), "AU");
  assert.equal(maskIfSecretInline("payment.password", "hunter2", { bindings }), "*".repeat(7));
  // The other name in the same map is still decided on its own terms.
  assert.equal(maskIfSecretInline("user.apikey", "uk_live_1234", { bindings }), "*".repeat(8));
});

test("maskIfSecretInline: no opts at all is exactly what it was", () => {
  // An older server sends neither field, and the panel's default `{}` has to
  // be indistinguishable from the two-argument call it replaced.
  assert.equal(maskIfSecretInline("user.apikey", "uk_live_1234"), "uk_live_1234");
  assert.equal(maskIfSecretInline("user.apikey", "uk_live_1234", {}), "uk_live_1234");
  assert.equal(maskIfSecretInline("payment.keyword", "search", {}), "search");
});

test("maskIfSecretInline: an unmasked name is shown, empty-value guard included", () => {
  assert.equal(maskIfSecretInline("keyword", "search", { unmask: ["keyword"] }), "search");
  // The hatch is read BEFORE the falsy guard, so an unmasked empty value is
  // the empty string rather than the panel's `(empty)` marker — the author
  // said this name is not a secret, and `(empty)` is a mask word.
  assert.equal(maskIfSecretInline("keyword", "", { unmask: ["keyword"] }), "");
  assert.equal(maskIfSecretInline("keyword", "", {}), "(empty)");
});

test("maskIfSecretInline: a non-string value survives both new paths", () => {
  // The panel renders whatever React state holds, and `String(value)` on every
  // path is what has always kept a number or an undefined from throwing here.
  assert.equal(maskIfSecretInline("keyword", 42, { unmask: ["keyword"] }), "42");
  assert.equal(maskIfSecretInline("user.apikey", 1234567890, { bindings: [] }), "*".repeat(8));
});

// ---------------------------------------------------------------------------
// maskRecordSecretsInline
// ---------------------------------------------------------------------------
//
// A `readTable` capture is a whole table under ONE ordinary name
// (`payments`), and one pass's record under another (`payment`), so no name
// rule can catch either. `frame:scope` carries raw values by design, so this
// render is the only guard — and the panel showed both in full beside a
// `payment.password` row rendered `********`, which reads as "masked".

test("maskRecordSecretsInline: a list of records loses its secret columns", () => {
  const capture = JSON.stringify([
    { _row: "1", payee: "Origin Energy", password: "hunter2-not-real" },
    { _row: "2", payee: "Alinta", password: "swordfish" },
  ]);
  const masked = maskRecordSecretsInline(capture);
  assert.ok(!masked.includes("hunter2-not-real"), masked);
  assert.ok(!masked.includes("swordfish"), masked);
  assert.deepEqual(JSON.parse(masked), [
    { _row: "1", payee: "Origin Energy", password: "*".repeat(8) },
    { _row: "2", payee: "Alinta", password: "*".repeat(8) },
  ]);
});

test("maskRecordSecretsInline: one record, and the readable columns survive", () => {
  const masked = maskRecordSecretsInline(JSON.stringify({ payee: "Alinta", api_key: "pk-live-1" }));
  assert.deepEqual(JSON.parse(masked), { payee: "Alinta", api_key: "*".repeat(8) });
});

// A number or a boolean under a `password` key is still a credential: the
// panel rendered `{"password":123}` in the clear while starring
// `{"password":"123"}`.
test("maskRecordSecretsInline: a non-string cell under a secret key masks too", () => {
  assert.deepEqual(JSON.parse(maskRecordSecretsInline(JSON.stringify({ password: 123 }))), {
    password: "***",
  });
  assert.deepEqual(JSON.parse(maskRecordSecretsInline(JSON.stringify([{ password: true }]))), [
    { password: "****" },
  ]);
  assert.deepEqual(JSON.parse(maskRecordSecretsInline(JSON.stringify([{ api_key: 4321 }]))), [
    { api_key: "****" },
  ]);
});

// …and the limit: a null says there is no value, and a nested object would
// have to be walked, which neither mirror does.
test("maskRecordSecretsInline: null and nested objects are left alone", () => {
  for (const value of [
    JSON.stringify([{ password: null }]),
    JSON.stringify([{ password: { pin: "1234" } }]),
    JSON.stringify([{ password: ["a", "b"] }]),
  ]) {
    assert.equal(maskRecordSecretsInline(value), value, value);
  }
});

test("maskRecordSecretsInline: anything that is not a record list is untouched", () => {
  for (const value of ["Origin Energy", "", "[not json", "{oops}", '[ "a", "b" ]', "42"]) {
    assert.equal(maskRecordSecretsInline(value), value, JSON.stringify(value));
  }
  const spaced = '[\n  { "payee": "Alinta" }\n]';
  assert.equal(maskRecordSecretsInline(spaced), spaced, "a value nothing was masked in is not reformatted");
});

test("maskIfSecretInline: a capture under a plain name is masked INSIDE", () => {
  const capture = JSON.stringify([{ payee: "Alinta", password: "hunter2-not-real" }]);
  const shown = maskIfSecretInline("payments", capture);
  assert.ok(!shown.includes("hunter2-not-real"), shown);
  assert.ok(shown.includes("Alinta"), "the readable columns survive");
  const record = JSON.stringify({ payee: "Alinta", password: "hunter2-not-real" });
  assert.ok(!maskIfSecretInline("payment", record).includes("hunter2-not-real"));
});

test("maskIfSecretInline: a secret-named capture is still masked whole", () => {
  const capture = JSON.stringify([{ payee: "Alinta", password: "hunter2" }]);
  assert.equal(maskIfSecretInline("tokens", capture), "*".repeat(8));
});

// The skill-rerun scope editor decides read-only from exactly this: a value we
// have to mask cannot be an editable input, because the mask is what the edit
// would send back (testbench-runner.jsx, `display !== value`).
test("maskIfSecretInline: a masked row is one whose render differs from its value", () => {
  const capture = JSON.stringify([{ payee: "Alinta", password: "hunter2-not-real" }]);
  assert.notEqual(maskIfSecretInline("payments", capture), capture, "must be read-only");
  assert.notEqual(maskIfSecretInline("MACHINE_KEY", "abc"), "abc", "must be read-only");
  assert.equal(maskIfSecretInline("payee", "Alinta"), "Alinta", "stays editable");
});

// ---------------------------------------------------------------------------
// The whole dotted name, read as one credential key
// ---------------------------------------------------------------------------
//
// The third clause of the server's `isSecretParameterName`, which both client
// mirrors were missing: `api.key` is one word split by a dot, and neither half
// says secret. Measured before the fix: the panel rendered `uk_live_1234`
// while the report beside it said `***`.
test("maskIfSecretInline: a dotted name that reads as one credential key masks", () => {
  for (const name of ["api.key", "private.key", "service.access.key", "auth.keys"]) {
    assert.equal(maskIfSecretInline(name, "uk_live_1234"), "*".repeat(8), name);
  }
});

test("maskIfSecretInline: …and the RECORD rule reads it, so it stays whole-word", () => {
  for (const name of ["row.keyword", "payment.sort_key", "order.monkey"]) {
    assert.equal(maskIfSecretInline(name, "search"), "search", name);
  }
});

test("maskRecordSecretsInline: a leading BOM does not smuggle a record past the sniff", () => {
  // U+FEFF is whitespace to JS, so `/^\s*[[{]/` said yes and `JSON.parse` then
  // threw — and the catch returns the value untouched, which is the one
  // outcome this function exists to prevent.
  assert.equal(maskRecordSecretsInline('\uFEFF[{"password":"hunter2"}]'), '[{"password":"*******"}]');
  assert.equal(maskRecordSecretsInline("\uFEFFOrigin Energy"), "\uFEFFOrigin Energy");
  assert.equal(maskRecordSecretsInline("\uFEFF[not json"), "\uFEFF[not json");
  const readable = '\uFEFF[{"payee":"Alinta"}]';
  assert.equal(maskRecordSecretsInline(readable), readable);
});

// ---------------------------------------------------------------------------
// maskIfSecretAuthoredInline — the author rule on the WHOLE key
// ---------------------------------------------------------------------------
//
// The panel's copy of runner-core's `maskIfSecretAuthored`, which mirrors the
// server's `redactAuthoredMap`. The capture banner (`✎ name ← value`) is the
// one surface here whose names are author-chosen end to end, and the
// two-segment rule answered no about `user.apikey` — so the banner printed
// `uk_live_1234` beside a report that said `***`.
test("maskIfSecretAuthoredInline: the whole dotted key takes the flat author rule", () => {
  for (const name of ["user.apikey", "user.apitoken", "row.mypassword", "login.passkey", "api.key"]) {
    assert.equal(maskIfSecretAuthoredInline(name, "uk_live_1234"), "*".repeat(8), name);
  }
  // The difference from the scope rule, stated: these four are exactly what
  // made the banner and the report disagree. (`api.key` is not among them —
  // the whole-name clause catches it under either rule.)
  for (const name of ["user.apikey", "user.apitoken", "row.mypassword", "login.passkey"]) {
    assert.equal(maskIfSecretInline(name, "uk_live_1234"), "uk_live_1234", `${name} as a scope entry`);
  }
});

test("maskIfSecretAuthoredInline: a flat name answers exactly as maskIfSecretInline does", () => {
  for (const [name, value] of [
    ["password", "hunter2"],
    ["MACHINE_KEY", "abc"],
    ["keyword", "search"],
    ["username", "alice"],
    ["payee", "Origin Energy"],
    ["password", ""],
  ]) {
    assert.equal(maskIfSecretAuthoredInline(name, value), maskIfSecretInline(name, value), name);
  }
});

test("maskIfSecretAuthoredInline: a value whose NAME says nothing is still scanned", () => {
  const capture = JSON.stringify([{ payee: "Alinta", password: "hunter2-not-real" }]);
  const shown = maskIfSecretAuthoredInline("payments", capture);
  assert.ok(!shown.includes("hunter2-not-real"), shown);
  assert.ok(shown.includes("Alinta"), shown);
});
