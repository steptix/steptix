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
 *   runtimeSources   — optional map {name → 'capture' | 'toolOutput'} carrying
 *                      the `source` discriminator from each `capture` event
 *                      (see runner-core CaptureEvent). Lets the panel tell a
 *                      value a skill/tool returned apart from one extracted
 *                      from the page. Absent / unknown names default to
 *                      `'capture'` (the conservative back-compat default for
 *                      a server that predates the field).
 *
 * Returns: an ordered list of { name, source, value, line?, captureSource? },
 * with duplicates removed (param > input > output if a name appears in more
 * than one place). `captureSource` is only set on rows whose runtime value
 * arrived via a `capture` event; it is the wire `source` discriminator
 * (`'capture'` | `'toolOutput'`), classified by `classifyCaptureSource`.
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
  return source === "toolOutput" ? "toolOutput" : "capture";
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

/** Mask password/secret/token-shaped variable names. Same shape as runner-core/repl.maskIfSecret. */
export function maskIfSecretInline(varName, value) {
  if (!/password|secret|token|apikey|api_key/i.test(varName)) return String(value);
  if (!value || value.length === 0) return "(empty)";
  return "*".repeat(Math.min(String(value).length, 8));
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
