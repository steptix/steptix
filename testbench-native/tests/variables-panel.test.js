import { test } from "node:test";
import { strict as assert } from "node:assert";
import { collectVariables } from "../src/webview/lib/variables-panel.js";

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
