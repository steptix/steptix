/**
 * Build the row data for the Variables panel from the document text + the
 * runtime values seen so far. Pure function; rendering lives in the React
 * component.
 *
 * Sources of variables, in panel order:
 *   1. Declared `## Parameters`            (source: 'param')
 *   2. `[input: var]` markers in steps     (source: 'input')
 *   3. `[output: var]` markers in steps    (source: 'output')
 *
 * Inputs:
 *   text             — full markdown source of the test file.
 *   parameterValues  — resolved `## Parameters` map (post-$VAR substitution),
 *                      typically built by parseParameters + resolveSection.
 *   runtimeValues    — values gathered during a run: [input:] answers
 *                      collected via the composer + [output:] captures
 *                      arriving as `capture` events.
 *   runtimeSources   — optional map {name → 'capture' | 'toolOutput' |
 *                      'assignment'} carrying the `source` discriminator from
 *                      each `capture` event (see runner-core CaptureEvent).
 *                      Lets the panel tell a value a skill/tool returned, or
 *                      one a `Set` step assigned, apart from one extracted
 *                      from the page. Absent / unknown names default to
 *                      `'capture'` (the conservative back-compat default for
 *                      a server that predates the field — and what makes
 *                      adding a third value safe).
 *
 * Returns: an ordered list of { name, source, value, line?, captureSource? },
 * with duplicates removed (param > input > output > set if a name appears in
 * more than one place). `captureSource` is only set on rows whose runtime
 * value arrived via a `capture` event; it is the wire `source` discriminator
 * (`'capture'` | `'toolOutput'` | `'assignment'`), classified by
 * `classifyCaptureSource`.
 */

const STEPS_HEADING_RE = /^(#{2,})\s+steps\s*$/i;
const ANY_HEADING_RE = /^(#{1,6})\s+\S/;
const STEP_LINE_RE = /^\s*\d+\.\s+\S/;
const INPUT_PATTERN = /\[input:\s*(\w+)\]/i;
const OUTPUT_PATTERN = /\[output:\s*(\w+)\]/i;
// `[skill: name ... out.foo="caller_alias"]` exposes `caller_alias` into
// the caller's scope. Authors reference it later via `{{caller_alias}}`
// but never declare it under `## Parameters` — without surfacing it from
// the invocation line, the Variables panel would silently omit a value
// that's both captured (via `capture` events) and used downstream.
const SKILL_OUT_ALIAS_RE = /\bout\.\w+\s*=\s*"([^"]+)"/g;
// `Set {{name}} to "…"` — the same anchored form the extension scanner and the
// runtime read (stories/variable-assignment.md). The row appears before a run,
// like an [output:] row does, and fills in from the `capture` event when the
// assignment happens.
// The value is a lookahead so the whole grammar is checked — a line the
// runtime refuses (`Set {{a}} to "b" trailing`, or a value containing a quote)
// must not seed a row for a file that cannot run — while the match text still
// ends at the name, matching the extension scanner's regex exactly.
const SET_STEP_RE = /^set\s+\{\{(\w+)\}\}\s+to\s+(?="[^"]*"\s*$)/i;
/** `N. ` ordinal plus any `[no-hooks]` marker — both stripped by the runtime's
 *  `extractSteps` before a step reaches `parseSetStep`, so stripping only the
 *  ordinal here made `[no-hooks] Set {{x}} to "…"` invisible to the panel. */
const STEP_PREFIX_RE = /^\s*\d+\.\s+(?:\[no-hooks\]\s*)?/i;

/**
 * Map a `capture` event's wire `source` discriminator onto the value the
 * panel renders. Closed union per the protocol: `'capture'` (extracted from
 * the page) or `'toolOutput'` (returned by a `[tool:]` / `[skill:]` call).
 *
 * Back-compat: a server that predates the field omits `source`, so an
 * `undefined` / unrecognised value collapses to `'capture'` — the
 * conservative default mandated by the spec. Never throws.
 */
export function classifyCaptureSource(source) {
  if (source === "toolOutput") return "toolOutput";
  if (source === "assignment") return "assignment";
  return "capture";
}

export function collectVariables(text, parameterValues, runtimeValues, runtimeSources) {
  const params = parameterValues || {};
  const runtime = runtimeValues || {};
  const sources = runtimeSources || {};
  const out = [];
  const seen = new Set();

  // Stamp a row with the `capture`-event source discriminator when its
  // runtime value arrived via a `capture` event. Parameters and unfilled
  // input/output rows have no capture provenance, so they stay unstamped.
  // Returns a spreadable fragment so the `captureSource` key is *omitted*
  // entirely (not set to undefined) on unstamped rows — keeps the row shape
  // minimal and stable for deepEqual-based callers/tests.
  const captureSourceFor = (name) =>
    name in sources ? { captureSource: classifyCaptureSource(sources[name]) } : {};

  // 1. Declared parameters first — preserve insertion order.
  for (const [name, declared] of Object.entries(params)) {
    out.push({
      name,
      source: "param",
      value: name in runtime ? runtime[name] : declared,
    });
    seen.add(name);
  }

  // 2/3. Walk lines inside the Steps section (only) and pick up
  // [input:] / [output:] markers in document order.
  const lines = text.split(/\r?\n/);
  const stepsSpan = findStepsSpan(lines);
  if (!stepsSpan) return out;

  for (let i = stepsSpan.start; i <= stepsSpan.end; i++) {
    const raw = lines[i] || "";
    if (!STEP_LINE_RE.test(raw)) continue;
    const inputMatch = raw.match(INPUT_PATTERN);
    if (inputMatch && !seen.has(inputMatch[1])) {
      out.push({
        name: inputMatch[1],
        source: "input",
        line: i + 1,
        value: runtime[inputMatch[1]],
        ...captureSourceFor(inputMatch[1]),
      });
      seen.add(inputMatch[1]);
    }
    const outputMatch = raw.match(OUTPUT_PATTERN);
    if (outputMatch && !seen.has(outputMatch[1])) {
      out.push({
        name: outputMatch[1],
        source: "output",
        line: i + 1,
        value: runtime[outputMatch[1]],
        ...captureSourceFor(outputMatch[1]),
      });
      seen.add(outputMatch[1]);
    }
    // `Set {{name}} to "…"`. Matched on the INSTRUCTION — the text after the
    // `N. ` ordinal — because the runtime's own reading is anchored to the
    // instruction's start. The other patterns here are unanchored and so can
    // match the raw line as it stands.
    const setMatch = raw.replace(STEP_PREFIX_RE, '').match(SET_STEP_RE);
    if (setMatch && !seen.has(setMatch[1])) {
      out.push({
        name: setMatch[1],
        source: "set",
        line: i + 1,
        value: runtime[setMatch[1]],
        ...captureSourceFor(setMatch[1]),
      });
      seen.add(setMatch[1]);
    }
    // `[skill: foo out.x="alias"]` — surface every caller alias.
    // Same semantic as a step-level [output:] from the caller's
    // perspective: the skill captures `x` and exposes it back as
    // `alias` in the caller's scope.
    SKILL_OUT_ALIAS_RE.lastIndex = 0;
    let aliasMatch;
    while ((aliasMatch = SKILL_OUT_ALIAS_RE.exec(raw)) !== null) {
      const aliasName = aliasMatch[1];
      if (!seen.has(aliasName)) {
        out.push({
          name: aliasName,
          source: "output",
          line: i + 1,
          value: runtime[aliasName],
          ...captureSourceFor(aliasName),
        });
        seen.add(aliasName);
      }
    }
  }

  return out;
}

/**
 * Tiny inline copy of runner-core's `parseParameters`. The webview can't
 * directly import runner-core (CJS interop quirks with Vite's named-export
 * tracking), so this pulls just enough to surface declared variables.
 * Returns a {name → declared-value} map; values keep their `$VAR`
 * placeholders since the webview doesn't have access to .env.
 */
const HEADING_RE = /^(#{2,})\s+(\S.*?)\s*$/;
const ITEM_RE = /^\s*-\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/;

export function parseParametersInline(text) {
  const lines = text.split(/\r?\n/);
  let inSection = false;
  let depth = 0;
  const out = {};
  for (const raw of lines) {
    const heading = HEADING_RE.exec(raw);
    if (heading) {
      const headingDepth = heading[1].length;
      const name = heading[2].toLowerCase();
      if (inSection && headingDepth <= depth) break;
      if (!inSection && name === "parameters") {
        inSection = true;
        depth = headingDepth;
      }
      continue;
    }
    if (!inSection) continue;
    const item = ITEM_RE.exec(raw);
    if (!item) continue;
    out[item[1]] = item[2];
  }
  return out;
}

/** The AUTHOR-CHOSEN name rule, hand-copied: this module is bundled into the
 *  webview, which imports nothing from runner-core. It is the server's
 *  `isSecretName` (src/parser/parameters.ts) character for character — a
 *  substring, so `mypassword` and `apitoken` mask — and runner-core's
 *  `SECRET_NAME` is the same literal again. A client rule that is not the
 *  server's shows in this panel a value the report beside it redacts, which is
 *  how `mypassword` came to render in full; `keyword` masking here is the
 *  price, and it is the price the report pays too.
 *  `tests/record-secret-parity.test.js` reads all three sources and fails if
 *  any of them drifts. */
const SECRET_NAME = /password|secret|token|key/i;

/** The record-COLUMN rule, hand-copied from runner-core/repl.js
 *  `isRecordSecretKey`, which is itself the mirror of the server's
 *  (src/utils/secrets.ts). Narrower than the rule above on purpose: a column
 *  name comes off the page, where `keyword` and `sort_key` both contain
 *  `key`, and masking one replaces its value everywhere on the server,
 *  including in the DOM snapshot the model plans its next action from. */
const RECORD_SECRET_WORD = /(^|_)(password|passwd|pwd|secret|token|otp|credential|credentials)(_|$)/;
const RECORD_SECRET_KEY = /(^|_)(api|access|private|auth|signing|encryption)_keys?(_|$)/;
export const RECORD_SECRET_PATTERNS = { word: RECORD_SECRET_WORD, key: RECORD_SECRET_KEY };

/** Exported for the same reason: the parity test compares `.source` rather
 *  than eyeballing three files. */
export const SECRET_NAME_PATTERN = SECRET_NAME;

export function isRecordSecretKeyInline(key) {
  const words = String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
  return RECORD_SECRET_WORD.test(words) || RECORD_SECRET_KEY.test(words);
}

/** Is a flat, author-chosen name a secret by {@link SECRET_NAME}? */
export function isSecretFlatNameInline(name) {
  return SECRET_NAME.test(String(name));
}

/** The dotted name read as ONE record key: `api.key` → `api_key`. The record
 *  rule, not the author rule, so it stays whole-word — a name that merely
 *  contains `key` across the dot (`row.keyword`) is not caught by it. Kept
 *  line for line with runner-core's and the server's copies; the parity test
 *  compares all three bodies. */
function wholeNameIsRecordSecretInline(name) {
  return name.includes(".") && isRecordSecretKeyInline(name.split(".").join("_"));
}

/** Is `varName` a secret? The three rules of runner-core's `isSecretVarName`:
 *  a flat name is the author's, so the broad substring rule decides it; a
 *  dotted `root.property` is a record binding, so the root takes the flat rule
 *  and the property takes the record-column one; and the whole dotted name is
 *  read as one credential key too (`api.key` → `api_key`), because not every
 *  dotted name is a binding. */
export function isSecretVarNameInline(varName) {
  const name = String(varName);
  const dot = name.indexOf(".");
  if (dot < 0) return isSecretFlatNameInline(name);
  return (
    isSecretFlatNameInline(name.slice(0, dot))
    || isRecordSecretKeyInline(name.slice(dot + 1))
    || wholeNameIsRecordSecretInline(name)
  );
}

function maskValueInline(value) {
  return value.length === 0 ? "(empty)" : "*".repeat(Math.min(value.length, 8));
}

/** Is this parsed JSON value one record — an object with keys, rather than a
 *  list, a null or a scalar? Its own function so the mask loop below reads as
 *  one call, the same way runner-core's does. */
function isPlainRecordInline(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A captured value with the secret COLUMNS of the records inside it masked;
 *  anything that is not a record (or a list of them) is returned as it came.
 *  Mirrors runner-core's `maskRecordSecrets` — a `readTable` capture is a
 *  whole table under one non-secret name, so the name rule has nothing to
 *  catch and this render is the only guard the panel has.
 *
 *  A cell masks at any JSON type it can hold on its own — string, number,
 *  boolean — because `{"password":123}` rendered the credential in the clear
 *  while `{"password":"123"}` starred it. The LIMIT is a null, an object or an
 *  array, which are left as they came: starring a null would report a value
 *  where there is none, and a nested object would have to be walked, which
 *  nothing on either side masks inside today.
 *
 *  Kept line for line with runner-core's copy — `tests/record-secret-parity.
 *  test.js` normalises the TypeScript spellings away and compares the two
 *  bodies, so a change to one of them fails rather than drifts. */
export function maskRecordSecretsInline(value) {
  const text = String(value);
  // A leading BOM is stripped before both the sniff and the parse. JS `\s`
  // INCLUDES U+FEFF, so `\uFEFF[{"password":…}]` passed the sniff and then
  // threw in JSON.parse, and the catch returned the credential unmasked —
  // the one input shaped exactly like the case this function exists for.
  const body = text.replace(/^\uFEFF/, "");
  if (!/^\s*[[{]/.test(body)) return text;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return text;
  }
  const records = Array.isArray(parsed) ? parsed : [parsed];
  let masked = false;
  for (const record of records) {
    if (!isPlainRecordInline(record)) continue;
    for (const [key, cell] of Object.entries(record)) {
      if (!isRecordSecretKeyInline(key)) continue;
      if (cell === null || typeof cell === "object") continue;
      record[key] = maskValueInline(String(cell));
      masked = true;
    }
  }
  return masked ? JSON.stringify(parsed) : text;
}

/** Mask password/secret/token/key-shaped variable names, and the secret
 *  columns of any record a value holds. Same rule and same shape as
 *  runner-core/repl.maskIfSecret: the name first and outright (a secret-named
 *  value is hidden whole), then the record scan for everything else. */
export function maskIfSecretInline(varName, value) {
  // `String(value)` on both paths, and the falsy guard before the mask, so a
  // row with no value yet renders exactly what it rendered before.
  if (!isSecretVarNameInline(varName)) return maskRecordSecretsInline(String(value));
  if (!value) return "(empty)";
  return maskValueInline(String(value));
}

/** The same, for a name that is author-chosen END TO END — the panel's copy of
 *  runner-core's `maskIfSecretAuthored`, which is itself the mirror of the
 *  server's `redactAuthoredMap`. The capture banner's `✎ name ← value` is one:
 *  a `[store as:]` name is a word a person typed, so the WHOLE key takes the
 *  broad flat rule rather than being split at the dot and handed to the narrow
 *  record one. `api.key` and `user.apikey` printed in the clear here while the
 *  report beside them said `***`. The Variables rows keep `maskIfSecretInline`:
 *  those are scope entries, and a loop's `row.<column>` binding is half the
 *  page's word. */
export function maskIfSecretAuthoredInline(name, value) {
  if (!isSecretFlatNameInline(name)) return maskRecordSecretsInline(String(value));
  if (!value) return "(empty)";
  return maskValueInline(String(value));
}

function findStepsSpan(lines) {
  let headingIndex = -1;
  let headingDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = STEPS_HEADING_RE.exec(lines[i] || "");
    if (m) {
      headingIndex = i;
      headingDepth = m[1].length;
      break;
    }
  }
  if (headingIndex < 0) return null;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const m = ANY_HEADING_RE.exec(lines[i] || "");
    if (m && m[1].length <= headingDepth) {
      return { start: headingIndex + 1, end: i - 1 };
    }
  }
  return { start: headingIndex + 1, end: lines.length - 1 };
}
