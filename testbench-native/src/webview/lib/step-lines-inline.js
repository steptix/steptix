/**
 * Inline step-line detection for the webview.
 *
 * Mirrors `runner-core/step-lines`'s logic for "what counts as a numbered
 * step line under ## Steps". The webview can't import runner-core directly
 * because Vite's CJS interop drops named exports through __exportStar.
 *
 * A line is a step line iff:
 *   - it lives under a `## Steps` (or deeper) heading, before the next
 *     same-or-shallower heading
 *   - it matches `^\s*\d+\.\s+\S` (numbered list item with content)
 *
 * A numbered item inside an ignored region — one opened by a depth->=4
 * heading WITH TEXT, per the sections contract §5 rule 4a — is not a step
 * line here either. Nothing runs those items, so nothing in the panel may
 * offer to; the host's copy applies the same rule and the copy-parity test
 * pins the two together.
 *
 * `extractStepLineIds` returns main-flow AND inline-section body lines, and
 * must keep doing so: the webview paints, anchors and filters by these ids,
 * and a body line is still a line the user can see and click. That is a
 * PRESERVATION requirement (stories/test-script-sections-contract.md §5,
 * consumer split) — it already holds, because `findStepsSpan` closes only on
 * a heading of depth <= the Steps heading's, so a `###` never ends the span —
 * and it is pinned by tests rather than implemented afresh.
 */

const STEPS_HEADING_RE = /^(#{2,})\s+steps\s*$/i;
const ANY_HEADING_RE = /^(#{1,6})\s+\S/;
const STEP_LINE_RE = /^\s*\d+\.\s+\S/;
/**
 * A heading made of nothing but hashes. `ANY_HEADING_RE` demands a non-space
 * after them and cannot see these at all.
 */
const HASHES_ONLY_RE = /^#{3,}\s*$/;
/** Sections are recognised only under a depth-2 `## Steps`. */
const SECTION_HOST_DEPTH = 2;
const STEP_PREFIX_RE = /^\s*\d+\.\s+/;
const NO_HOOKS_MARKER = /^\[no-hooks\]\s*/i;
/**
 * Deliberately STRICTER than `STEP_LINE_RE` above: runner-core's step regex
 * rejects indented numbered items, and this mirror must agree with it exactly
 * or the same file yields different sections in the webview and in the host.
 * `STEP_LINE_RE` is left alone because `extractStepLineIds` and the variables
 * panel have shipped on the looser form.
 */
const SECTION_STEP_RE = /^\d+\.\s+\S/;

/**
 * 0-based indices inside an ignored region: everything from a depth->=4
 * heading with text up to the next section heading (a `###` with text, or a
 * hashes-only line at any depth) or the end of the span.
 */
function ignoredLineSet(lines, span) {
  const out = new Set();
  if (!span || span.headingDepth !== SECTION_HOST_DEPTH) return out;
  let ignoring = false;
  for (let i = span.start; i <= span.end; i++) {
    const raw = lines[i] || "";
    if (HASHES_ONLY_RE.test(raw)) {
      ignoring = false;
      continue;
    }
    const heading = ANY_HEADING_RE.exec(raw);
    if (heading) {
      ignoring = heading[1].length >= SECTION_HOST_DEPTH + 2;
      continue;
    }
    if (ignoring) out.add(i);
  }
  return out;
}

/** 1-based line numbers of every step under ## Steps. */
export function extractStepLineIds(text) {
  const lines = text.split(/\r?\n/);
  const span = findStepsSpan(lines);
  if (!span) return [];
  const ignored = ignoredLineSet(lines, span);
  const out = [];
  for (let i = span.start; i <= span.end; i++) {
    if (ignored.has(i)) continue;
    if (STEP_LINE_RE.test(lines[i] || "")) out.push(i + 1);
  }
  return out;
}

/**
 * The panel header's run tally, over STEP lines only.
 *
 * `statuses` is the whole snapshot's line → status map, and a snapshot holds
 * more than steps: since PR #137 every data-table ROW line wears a status too,
 * and a row the run never reached is painted `skip` — which the Rows panel two
 * inches below calls "not run". Counted with the steps, a Stop part-way through
 * a three-row table renders `◌ 3 skipped` in the header with nothing returned
 * and no step skipped, contradicting the panel's own Rows section.
 *
 * `stepLineIds` is `extractStepLineIds` of the same text: main-flow and inline
 * section body lines, which is exactly what the header means by a step. Row
 * lines are table pipes and match no numbered-item regex, so they are outside
 * it by construction rather than by an exclusion list that could drift.
 *
 * The pass breakdown is folded in here too, so all five numbers come from one
 * filter and cannot disagree about which lines they were counting.
 */
export function countStepLineStatuses(statuses, stepLineIds, notTakenLines) {
  const ids = new Set(stepLineIds ?? []);
  const entries = Object.entries(statuses ?? {}).filter(([line]) => ids.has(Number(line)));
  const mine = entries.map(([, status]) => status);
  const count = (...wanted) => mine.filter((s) => wanted.includes(s)).length;
  // A ⚠ on a line that did NOT run — a chain member whose condition's code
  // threw on the visit that took another member (the detail's `notTaken`). It
  // is there to offer Repair; the step was still skipped, never passed.
  const notTaken = new Set(notTakenLines ?? []);
  const staleNotTaken = entries.filter(
    ([line, status]) => status === "pass-stale" && notTaken.has(Number(line)),
  ).length;
  return {
    // Every 'pass*' is a passed step; what differs is what it cost, which is
    // what the breakdown beside it says.
    pass: count("pass", "pass-code-behind", "pass-stale") - staleNotTaken,
    codeBehind: count("pass-code-behind"),
    stale: count("pass-stale"),
    fail: count("fail"),
    skip: count("skip") + staleNotTaken,
    // A step that failed and the run carried on past it — an `otherwise continue`
    // tail (stories/step-failure-outcomes.md, decision 6). Counted apart from BOTH
    // `pass` and `fail`: it did not do its work, and the run is not red for it.
    tolerated: count("fail-tolerated"),
  };
}

/**
 * Filter a list of {id, text, ...} entries to only those whose `id` is
 * a real step line in `text`. Preserves all extra fields on each entry.
 */
export function filterToStepLines(text, entries) {
  if (!entries || entries.length === 0) return [];
  const ids = new Set(extractStepLineIds(text));
  return entries.filter((e) => ids.has(e.id));
}

/**
 * 0-based index of the closing `---` of a YAML frontmatter block, or -1.
 *
 * Mirrors runner-core's `findFrontmatterEnd`, including its leniency about an
 * unterminated block. Only `extractSections` consults it: `extractStepLineIds`
 * has shipped without a frontmatter skip and changing that would move
 * decorations on real files for no benefit here. The asymmetry is deliberate
 * and unifying the two belongs to issues/035.
 */
function findFrontmatterEnd(lines) {
  let i = 0;
  while (i < lines.length && (lines[i] || "").trim() === "") i++;
  if (i >= lines.length || (lines[i] || "").trim() !== "---") return -1;
  for (let j = i + 1; j < lines.length; j++) {
    if ((lines[j] || "").trim() === "---") return j;
  }
  return -1;
}

function findStepsSpan(lines, from = 0) {
  let headingIndex = -1;
  let headingDepth = 0;
  for (let i = from; i < lines.length; i++) {
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
      return { start: headingIndex + 1, end: i - 1, headingDepth };
    }
  }
  return { start: headingIndex + 1, end: lines.length - 1, headingDepth };
}

/**
 * The inline sections defined in `text`, in document order, mirroring
 * runner-core's `extractSections`. Empty-name entries (a hashes-only heading)
 * ARE emitted — refusing a file the server would mis-execute depends on
 * seeing them.
 *
 * Kept in step with runner-core by the copy-parity test, which asserts this
 * and runner-core against the same frozen
 * `fixtures/sections/classification.json`.
 */
export function extractSections(text) {
  const lines = text.split(/\r?\n/);
  const span = findStepsSpan(lines, findFrontmatterEnd(lines) + 1);
  if (!span || span.headingDepth !== SECTION_HOST_DEPTH) return [];

  const ignored = ignoredLineSet(lines, span);
  const out = [];
  for (let i = span.start; i <= span.end; i++) {
    const raw = lines[i] || "";

    if (HASHES_ONLY_RE.test(raw)) {
      out.push({ name: "", headingLine: i + 1, steps: [] });
      continue;
    }

    const heading = ANY_HEADING_RE.exec(raw);
    if (heading) {
      // A depth >= 4 heading opens an ignored region: it still neither opens
      // a section nor closes the body it sits in, but nothing numbered under
      // it is a step (contract §5 rule 4a).
      if (heading[1].length === SECTION_HOST_DEPTH + 1) {
        out.push({
          name: raw.replace(/^#{3,}\s*/, "").trim(),
          headingLine: i + 1,
          steps: [],
        });
      }
      continue;
    }

    // Before the first section heading we are still in the main flow.
    if (out.length === 0) continue;
    if (ignored.has(i)) continue;
    if (!SECTION_STEP_RE.test(raw)) continue;

    const instruction = raw.replace(STEP_PREFIX_RE, "").trim();
    // The cull rule: an item empty after the ordinal and the marker strip
    // carries no instruction and must never reach the wire.
    if (instruction.replace(NO_HOOKS_MARKER, "").trim() === "") continue;
    out[out.length - 1].steps.push({ line: i + 1, instruction });
  }

  return out;
}
