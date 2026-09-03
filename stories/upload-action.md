# Upload action — the framework side of "Upload file \attachments\logo.png"

Part 2 of [file-upload-steps.md](file-upload-steps.md). Part 1 built the
Documents page in the SecureBank fixture app (PR #117). This part makes the
steps that drive it work. Spec only; nothing here is built yet. Reviewed
2026-09-03 by three independent passes (claims-vs-code, design and test
plan, adversarial); their findings are folded in and the record is in §"What
the review changed".

## In plain terms

You should be able to write these and have them just work, against any site:

- *Upload file \attachments\logo.png*
- *Use the Choose file button to upload \attachments\statement.pdf*
- *Attach \attachments\receipt-1.png and \attachments\receipt-2.png*
- *Upload file {{statement}}* with `statement: \attachments\statement.pdf`
  in `## Parameters`

The path is relative to the folder the test file is in. That is the one
decision the user made up front and everything else follows from it: the
same test, moved with its `attachments/` folder, keeps working; a test in a
zip sent to someone else keeps working; the cached action and the compiled
code-behind carry the path as written and never an absolute one.

The framework already has most of the machinery — an `upload` action exists
in the parser, the executor, the cache's mutating-action list and the report
type. What it lacks is a prompt rule telling the model the action exists, an
executor that copes with the hidden `<input type="file">` every real uploader
uses, a rule for what the path is relative to, a way to send several files,
and a failure mode that does not spend every configured retry on a typo in a
file name.

### What it looks like in practice

**You write:** *"Upload file \attachments\logo.png, then click Upload"* on
the Documents page.
**You get:** two actions in the run log — `{ "action": "upload",
"selector": "#statement-file", "filePath": "attachments/logo.png" }` and the
`click` on the Upload button the step names — the file resolved to
`<test folder>\attachments\logo.png`, the page's Uploaded documents table
showing `logo.png · 87 B · image/png`, and a log line naming the absolute
path that was sent. Re-run: the step replays from the step cache with zero
AI calls.

**You write:** *"Use the Choose file button to upload
\attachments\statement.pdf"* on the Proof of identity card, whose
`<input type="file">` is `display:none`.
**You get:** an `upload` action with `"selector": "#identity-choose"`,
because the step named the button. The executor sees the target is not a
file input, clicks it, catches the file chooser it opens, and answers with
the file. Had the step said *"upload \attachments\statement.pdf as proof of
identity"* with no button named, the model would target the input instead —
the snapshot shows it as `<input id="identity-file" name="file" type="file">
<!-- hidden: display:none -->` — and the executor would set the files on it
directly, hidden or not. Both routes pass; the run log says which ran.

**You write:** *"Attach \attachments\receipt-1.png and
\attachments\receipt-2.png"* on the Receipts card.
**You get:** one action with `"filePaths": ["attachments/receipt-1.png",
"attachments/receipt-2.png"]`, both files in one `setInputFiles` call, the
status line *"Uploaded 2 files"*.

**You write:** *"Upload file {{statement}}"* with the parameter set to
`\attachments\statement.pdf` — backslashes and all. (The fixture test gains
a `## Parameters` block and this step as part of this story, so the clause
has a live vehicle.)
**You get:** the cached action stores `{{statement}}`, not the value, the
way `type` actions already store `{{password}}`; so changing the parameter
does not invalidate the cache, and the compiled code-behind reads
`step.filePath(step.getVar('statement'))` rather than freezing the file
name. The backslashes are normalised wherever the value is finally used,
so the parameter can be written either way.

**You write:** *"Upload file \attachments\missing.png"*.
**You get:** the step fails before any selector is evaluated, with no
retries and no further AI turns after the failure:
*"Upload file not found: C:\…\tests\attachments\missing.png (resolved from
"attachments/missing.png" against the test file's folder C:\…\tests). Put
the file there or correct the step's path"*.

**You write:** *"Upload file \attachments\malware.exe"* on the Documents page.
**You get:** the upload action succeeds — the framework handed the file to
the page — and the page shows *"malware.exe is not an allowed file type"*.
Rejection is the site's call; the next step asserts on it.

> **Verification rule.** "Done" means, against the Documents page of the
> fixture app: (1) `templates/init/tests/securebank-upload.md` passes end to
> end on an AI run, and every upload step in its run log contains exactly
> one `upload` action plus the `click` on the submit button the step names —
> no `type`, no `click` on a file input, no guessed folder, and the action's
> path is the step's path in normalised form; (2) step 6, which names the
> Choose file button, runs through the file-chooser route (`upload.via:
> "chooser"` in the transcript), and a variant of that step that names no
> button runs through the input route by targeting `#identity-file` — both
> pass; (3) the two-receipt step is one action with two `filePaths`; (4) a
> missing file fails with the exact E3 text, no selector evaluated, no
> click, no chooser, and no further AI turns after the failure — on a plain
> run **and** on a compile run, where selector measurement is on; (5)
> re-running the test replays every upload step from the step cache, and a
> unit test proves a cached upload replayed under a different test folder
> resolves against that folder; (6) compiling the test produces entries that
> call `step.filePath(...)` and the compiled replay passes strict with zero
> AI calls; (7) the same markdown test passes against a CDP-attached browser
> (`## Config: cdp`), proving the bytes travel from the server process; (8)
> `Upload file {{statement}}` — a step and `## Parameters` block added to
> `securebank-upload.md` by this story, with the parameter written with
> backslashes — round-trips through the cache as the placeholder and
> replays.

## Context — what exists, and why the steps don't work today

| Layer | State today |
|---|---|
| [types.ts:7](../src/ai/types.ts) | `'upload'` in `ActionType`; `filePath?: string` at line 48 |
| [action-parser.ts:5](../src/ai/action-parser.ts) | `upload` accepted; aliases applied at line 269 before the validity check at 274; `filePath` copied when a string (line 292) in the flat field block (289-362); no per-action validation; unknown fields dropped |
| [actions.ts:532](../src/browser/actions.ts) | `executeUpload`: `filePath ?? value`, then `locator(sel).locator('visible=true').first().setInputFiles(path)`, 10 s budget |
| [actions.ts:601](../src/browser/actions.ts) | measurement hoist waits for the target with state `visible`; the whole prelude (sanitise, iframe promotion, frame checks, hoisted wait, ambiguity gate — lines 188-284) runs before the action switch |
| [step-executor.ts:53](../src/runner/step-executor.ts) | `upload` in `MUTATING_ACTIONS`; one `executeAction` call site (line 1683), which cache replay also goes through |
| [step-cache.ts:327](../src/cache/step-cache.ts) | actions stored as the AI returned them; `reverseInterpolate` touches **`value` only**, by literal `replaceAll` of the raw parameter value |
| [prompts.ts](../src/ai/prompts.ts) | no rule names `upload`; the word appears once, as an example of a slow `wait` (line 186). There is no action vocabulary list anywhere — the model learns action names only from the per-action rules. Rule 4 (line 163) says hidden placeholders have "their attributes dropped — never target those" |
| [capture-dom.js:232](../src/browser/scripts/capture-dom.js) | a hidden element becomes `<input> <!-- hidden: display:none -->` — every attribute dropped, no exception list; `getAttributes` is never called on that path. `hideReason` (76-87) fires for `input[type=hidden]`, `aria-hidden="true"` and computed `display:none` |
| [dom-cleaner.ts:865](../src/browser/dom-cleaner.ts) | `expandDomSubtree` drops a hidden element entirely (`if (!isVisible(el)) return ''`) — an `expand` on an uploader card shows no input at all |
| [dom-cleaner.ts:29](../src/browser/dom-cleaner.ts) | attribute allow-list keeps `id name type` but not `accept` or `multiple` |
| [retry.ts:21](../src/runner/retry.ts) | `withRetry` retries every error except an aborted signal; no non-retryable class exists. `execution.retries` defaults to 1, so a step gets two attempts |
| [step-executor.ts:452, 639](../src/runner/step-executor.ts) | a cache hit whose replay throws is invalidated and re-run under AI; a code-behind entry that throws is discarded and healed under AI — both regardless of why it threw |
| [codebehind/types.ts:26](../src/codebehind/types.ts) | `step` has `getVar`, `setVar`, `expect` — nothing else; the context has no path of any kind |
| [generator.ts:862](../src/report/generator.ts) | `renderSubAction` shows only `action` and `description`. (Part 1's context table said `template.ts:326` renders a `filePath` row — that is the *test file* meta row, not an action field) |
| README.md:746, SPEC.md:380 | both already list `upload`; SPEC-SESSIONS-API.md:363 lists "File uploads" under *Out of Scope (v1)* |

So the situation is the scroll story's again — the plumbing exists and the
prompt is silent — with five extra problems the scroll story did not have:

1. **Hidden inputs fail twice.** The common real-world uploader is a styled
   button or drop zone with the `<input type="file">` at `display:none` and
   a click handler calling `input.click()`. The executor's `visible=true`
   filter never matches it, and the snapshot strips its `id`, so the model
   cannot even name it. Playwright's `setInputFiles` works fine on a hidden
   input; the filter is the bug.
2. **The path is passed verbatim to Playwright**, which resolves a relative
   path against the *server process's* working directory
   (`playwright-core/lib/client/elementHandle.js:220`, `path.resolve`, then
   `fs.stat` at 213), and nothing in the framework resolves or checks it
   first. `\attachments\x` is a rooted path on Windows — it means
   `C:\attachments\x`.
3. **One file only.** `filePath` is a string; `setInputFiles` takes an array.
4. **A missing file costs every retry.** The error reaches the model
   verbatim through the retry context (prompts.ts:563), but `withRetry`
   re-runs the whole step for each configured retry, each with a fresh AI
   turn, and nothing the model does can make a file appear.
5. **A parameterised path freezes.** `reverseInterpolate` only puts
   `{{param}}` back into `value`, so `Upload file {{statement}}` would cache
   the resolved file name.

And one measured Playwright fact (1.59.1) that fixes where the file must
live: `_connectOverCDPImpl` marks the browser as not collocated with the
server (`lib/server/chromium/chromium.js:120-121`), and
`prepareFilesForUpload` then reads the bytes in the Node process and ships
them as payloads, under a 50 MB cap (`lib/server/fileUploadUtils.js:58-68`).
A collocated (launched) browser gets the absolute path via
`DOM.setFileInputFiles` instead. Either way: **the file must be readable by
the Sessions API server process**, and never by the browser or the
TestBench machine. That is the rule to document.

## Locked decisions

1. **Extend `upload`; no new action.** The vocabulary has it, the parser
   accepts it, the cache classes it correctly. Add aliases `attach`,
   `attach_file`, `file_upload`, `set_files`, `setInputFiles` →
   `upload` in `ACTION_TYPE_ALIASES` (the `key_press` → `keypress`
   precedent), because the model will guess these when it half-remembers.
2. **The path in the action is the path from the step**, normalised to
   forward slashes with no leading separator, never absolute. Two reasons
   beyond machine-independence: a Windows path is hostile to JSON
   (`"\attachments"` is *invalid* JSON — `\a` is not an escape — and the
   model will produce it), and the cache and code-behind need something
   stable. The prompt rule asks for the normalised form; the parser
   normalises what it gets; and because a `{{param}}` value arrives after
   the parser, **normalisation also runs at every point of use** — the
   executor and `step.filePath` (§3, §8). The step text itself is untouched:
   authors keep writing backslashes if they like.
3. **Resolution happens in the executor, once, into a local, before any
   selector is evaluated.** The action object is never written to. The
   precedent to avoid is `action.apiMode = 'browser'`
   (step-executor.ts:1583), which reaches the cache because cached turns
   hold the same object references.
4. **Base folder = the folder of the test file being run** (the user's
   decision, file-upload-steps.md Decisions). Consequences per path into the
   executor:
   - CLI `run`: `path.dirname(test.filePath)`.
   - Sessions API: `path.dirname(request.testFilePath)` per request. TestBench
     sends the open document's path on a full run
     (run-controller.ts:2692) and on an interactive step (2899) — the *test*
     file even when the step being run lives in a skill.
   - A step inside a **skill**: the invoking test's folder, not the skill's.
     The skill has no run of its own; the test owns the run. A skill inside
     the project reaches its own fixtures with `..`; a skill in a folder
     outside the project root (`tests.skillsDir: ../shared-skills`) cannot —
     its files are outside the fence (decision 5), so it must use files that
     live in the project.
   - MCP `run_steps` and `run_errand`: their synthetic test file already
     lives in the project root (assemble.ts:58 and :343, tools.ts:880), so
     the base is the project root. `run_errand` has its own `executeStep`
     call (errand-runner.ts:705) and threads the option itself.
   - **No test file** — Flick never sends one, and any other Sessions API
     client may omit it: a relative path is refused with a message that
     says so; an absolute path still works.
5. **Fence at the project root, lexically.** `..` is allowed, but a path
   whose resolved form is outside the folder holding `aiui.config.json` is
   refused. With no project root, the fence is the base folder. The
   comparison is `path.resolve` plus case-folding on Windows — the same
   `comparable()` helper `resolveProjectRoot` uses (project-root.ts:9,
   module-private today; export it) — and
   **not** realpath: a junction inside the project that points outside is
   followed on purpose, because worktrees are junctions and their files are
   in-tree by any sensible reading. Honest scope: `testFilePath` is whatever
   the client sends (api-server.ts:649 validates its type, nothing else), so
   the fence bounds a *test author's* mistake for an already-trusted client.
   The server's real boundary is the API key, and a client past it can
   already run tools and code-behind. The fence is not a security control
   and the spec must not describe it as one.
6. **Absolute paths are allowed** — a drive-letter path, a UNC path, or a
   `file://` URL — and still fenced. They are for the rare machine-specific
   case and the error messages steer authors back to relative.
7. **Executor target rule: visible first, then a hidden file input, never a
   hidden anything-else.** If any match for `selector` is visible, the
   target is the first visible match — a file input, or a `<label>` whose
   control is one, gets `setInputFiles` (Playwright follows the label);
   anything else is clicked and the file chooser it opens is answered. If
   no match is visible, the target is the first match that is an
   `input[type="file"]`, set directly. A hidden non-file element is never a
   target; it gets the ordinary "not visible" selector error. This keeps
   the visible-first rule the selector-ambiguity story established (a
   hidden decoy that happens to be first in DOM order must not win) while
   admitting the one hidden element that is a legitimate target.
8. **Missing file, directory, outside the fence, unparsable `file://` URL,
   or no base folder for a relative path are non-retryable.** They fail the
   step before any selector is evaluated, cost no further AI turns, and the
   message names the absolute path tried and the base it came from. They
   also do **not** invalidate a cache hit or discard a code-behind entry —
   the plan was fine, the file is missing. A chooser that does not open, or
   a selector that does not match, stays retryable — the model can retarget.
9. **The snapshot keeps a hidden file input recognisable.** The hidden
   placeholder for an `input[type="file"]` that is itself the hidden element
   keeps `id`, `name`, `type`, `accept` and `multiple`; the same carve-out
   applies in `expandDomSubtree`; and `accept` and `multiple` join the
   attribute allow-list for visible inputs, so the model can tell a
   multi-file field from a single one. Prompt rule 4 and the transcript
   legend get the matching one-tag exception. Limit, stated honestly: an
   input inside a hidden *ancestor* (`<div style="display:none"><input
   type="file"></div>`) is still collapsed with the ancestor; the opener
   route covers that layout.
10. **When the step names a control, the model targets the control.** A
    step that says "use the Choose file button", "click Browse and pick",
    "drop onto the upload area" targets that button, link or zone; a step
    that names no control targets the field's `<input type="file">`,
    hidden or not. This reverses Part 1's verification clause 2 ("without
    the model ever seeing the input's id") on purpose: now that the input
    is visible in the snapshot, hiding it from the model again would be
    perverse, and steps that name a button are how authors actually write.
11. **Code-behind resolves through `step.filePath(rel)`.** Generated code
    never contains an absolute path, and a string literal handed straight to
    `setInputFiles`/`setFiles` is rejected the way a bare ambiguous selector
    is: one re-ask with the reason, then decline.
12. **The `value` fallback goes.** `executeUpload`'s `filePath ?? value` is
    a leftover; a model that puts the path in `value` gets a clear
    *requires "filePath"* error on its next turn instead of a mystery
    cwd-relative resolution. (Was open question 2.)
13. **A one-element `filePaths` stays an array.** Part 1's outline said the
    parser would collapse it to `filePath`; it does not, because the
    executor reads both through one accessor and a collapse would be a
    second place for the shape to drift. A *string*-valued `filePaths` is
    treated as `filePath`, since the model will do that.
14. **Which route ran is recorded beside `targeting`, not inside it.**
    `upload: { via: 'input' | 'chooser' }` is a sibling field on the
    recorded sub-action, because `measuredSelectorRules` decides "was this
    action measured" by `targeting === undefined` (prompts.ts:1015) and an
    upload carrying only a `via` inside `targeting` would read as measured.
    It does **not** ride along for free: `SubActionResult` declares
    `targeting` explicitly (report/types.ts:44), `actionsOf` merges only
    `sa.targeting` onto the action (recording.ts:577-581), and
    `RecordedAction` / `TranscriptAction` are `AIAction & { targeting? }`
    (recording.ts:40, prompts.ts:859). All four get the new field.
15. **No `accept` enforcement, no drag-and-drop, no File System Access API,
    no bytes over the Sessions API.** The site decides what it accepts; the
    fixture's rejection cases exist to prove that. Dropping OS files needs a
    synthesised `DataTransfer` and is a separate story. A site whose button
    calls `showOpenFilePicker()` emits a chooser event Playwright cannot
    answer (`crPage.js:694` drops the event because it carries no backend
    node id) — the chooser-timeout message says so. Shipping a file from a
    remote TestBench to the server is a separate story; today the message
    says where the file was looked for.

## Design, by layer

### 1. What the model is told — prompt rule 10a, and a one-line change to rule 4

Slots in after rule 10 (`type`, prompts.ts:173), as `10a`, the letter-suffix
convention every recent rule used. Draft text, to be tuned on the live run.
**Source gotcha:** the rules are a JS template literal, where `\a` silently
becomes `a`; the example below must be written `\\attachments\\logo.png` in
`prompts.ts`, and a test asserts the rendered prompt contains a backslash.

> 10a. UPLOADING A FILE. A step that names a file path — a token with a
> file extension or a folder separator, such as "Upload file
> \attachments\logo.png", "Attach receipt-1.png and receipt-2.png", "Use the
> Choose file button to upload id.pdf" — is an upload. ("Choose/select
> <option text>" with no path is a dropdown, rule 11.) Emit an "upload"
> action: `{ "action": "upload", "selector": "#statement-file", "filePath":
> "attachments/logo.png", "description": "Upload logo.png as the statement"
> }`. RULES FOR "filePath": copy the path exactly as the step wrote it, with
> backslashes turned into forward slashes and no leading slash — do NOT make
> it absolute, do NOT guess a folder, do NOT check whether it exists; the
> framework resolves it relative to the test file and fails the step itself
> if it is missing. For several files into one field use `"filePaths":
> ["attachments/receipt-1.png", "attachments/receipt-2.png"]` instead of
> "filePath". RULES FOR "selector": when the step names a button, link or
> drop zone ("use the Choose file button", "click Browse"), target that
> control — the framework clicks it and answers the file picker for you.
> When the step names no control, target the field's `<input type="file">`
> — a file input marked `<!-- hidden: display:none -->` is NORMAL for a
> styled uploader and is still the right target (the exception to rule 4);
> do not try to make it visible. Never "type" a path into a text field and
> never "click" a file input. A separate click on the Upload/Submit button
> the step names is still a "click" action after the upload. Do not add a
> "wait" after an upload unless the step names a completion condition (rule
> 22).

Rule 4 (prompts.ts:163) gains, after "never target those": *"— except a
hidden `<input type="file">`, which keeps its attributes and is a valid
upload target (rule 10a)"*. `targetingLegend` (prompts.ts:985-990) gets the
same clause.

Nothing is added to `formatTestInfo` (a strict-equality test pins its output,
prompts-cache.test.ts:80, and the model does not need the folder — it must
not resolve paths). `## Response Format` (prompts.ts:252-259) stays as it
is; the rule carries the example.

### 2. Action shape and parser

[types.ts](../src/ai/types.ts): add `filePaths?: string[]` directly under
`filePath` (line 48), doc-commented as "Several files for one upload; exactly
one of filePath / filePaths". First array-typed field on `AIAction`, so the
parser gets its first array branch.

[action-parser.ts](../src/ai/action-parser.ts), in the flat field block
(lines 289-362):

- `filePath`: string → `normaliseUploadPath(s)`; blank after trim → dropped.
- `filePaths`: array → keep the string entries, normalise each, drop blanks;
  an empty result → field dropped. A **string** → treated as `filePath`
  (decision 13). Any other type → dropped, like every other invalid value
  in this parser (`waitType`, `direction`, `to`, `engine`).
- Both present → keep `filePaths`, drop `filePath`, `logger.warn` once. The
  executor then has one shape to read: `uploadPathsOf(action)` returns
  `filePaths ?? [filePath]`.
- `normaliseUploadPath` (exported from `src/browser/upload-paths.ts`, §3, so
  the parser, the executor, the cache and `step.filePath` share one
  function): trim; `\` → `/`; collapse `//` except a leading `//` (UNC);
  strip one leading `/` **unless** the path is absolute (drive letter
  `^[A-Za-z]:/`, UNC `^//`, or `file://`). Spaces, `#` and `?` in a plain
  path are just characters. A `{{param}}` placeholder is not something the
  parser will see (the step is interpolated before the model does,
  session-manager.ts:3772); a model that echoes braces gets E3 with the
  braces in the path, which is the honest outcome.

The JSON-escape hazard is real and the parser cannot fix it by
normalisation: `"\attachments"` fails `JSON.parse` in `extractJson`
(action-parser.ts:142-183) before any field is seen, and the turn is lost.
Two defences: the prompt rule asks for forward slashes (verification rule 1
is partly a compliance test of that), and `extractJson` gains a one-shot
repair — when the first parse throws, retry once with every backslash inside
a string token that is not followed by `" \ / b f n r t u` replaced by `/`,
logged at debug. A test feeds it the raw text a model would emit.

### 3. Path resolution — one pure module

New `src/browser/upload-paths.ts`, no Playwright, unit-testable:

```ts
export interface UploadPathContext {
  /** Folder of the test file being run; undefined when no test file (Flick). */
  baseDir?: string;
  /** Folder holding aiui.config.json; null when there is none. */
  projectRoot?: string | null;
}
export type UploadPathResult =
  | { ok: true; absolute: string[] }
  | { ok: false; error: string; retryable: false };
export function normaliseUploadPath(raw: string): string;
export async function resolveUploadPaths(paths: string[], ctx: UploadPathContext): Promise<UploadPathResult>;
```

Per path, in order:

1. **Normalise** with `normaliseUploadPath` — again, because a `{{param}}`
   value bypasses the parser (decision 2).
2. **Classify.** `file://` → `fileURLToPath`; a throw (a host on POSIX, a
   bad percent-escape), or a URL carrying `?` or `#` (Node silently drops
   the fragment and would name the wrong file) → E6. Drive-letter, UNC or
   `path.isAbsolute` → absolute as given; a leading `//` is UNC on Windows
   and `/…` on POSIX — **the server's OS decides**, and the doc says so.
   Otherwise relative.
3. **Base.** Relative with no `baseDir` → E1. Otherwise
   `path.resolve(baseDir, rel)`.
4. **Fence.** `fence = projectRoot ?? baseDir`; `rel =
   path.relative(comparable(fence), comparable(abs))`; refused when
   `path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)`
   → E2. (Not `startsWith('..')` — a folder named `..cache` inside the
   project is legal.)
5. **Exists and is a file.** `fs.stat` → ENOENT → E3; a directory → E4;
   anything else → E5 with the OS message.

All paths are resolved before any is judged, and the error names the first
failure. The result is the absolute list in the order given.

Errors (exact text; `<abs>`, `<rel>`, `<base>`, `<fence>` substituted; the
house rule is *what's wrong, then a verb-led fix, with the absolute path*):

| # | Message |
|---|---|
| E1 | `Upload path "<rel>" is relative but this run has no test file to resolve it against. Run the step from a test file, or use an absolute path` |
| E2 | `Upload path "<rel>" resolves to <abs>, outside the project folder <fence>. Keep upload files inside the project` |
| E3 | `Upload file not found: <abs> (resolved from "<rel>" against the test file's folder <base>). Put the file there or correct the step's path` — for an absolute input the parenthesis is omitted |
| E4 | `Upload path <abs> is a folder, not a file (resolved from "<rel>"). Name a file inside it` |
| E5 | `Upload file <abs> cannot be read: <os message>. Check the file's permissions` |
| E6 | `Upload path "<rel>" is a file URL the server cannot read: <reason>. Use a plain path` |

These messages carry the absolute path, and they reach the HTML report via
`sub.error` / `step.error` (generator.ts:487, 896). That is accepted: a
failure report that hides where the file was looked for is useless, and the
report already redacts secret *values* by literal match
(`redactReport`, session-manager.ts:4721), so a folder segment equal to a
password becomes `***`. The success-path report line is relative (§9).

Where the base comes from — one new option threaded through the same chain
`baseUrl` uses today:

- `StepExecutorOptions.uploadPaths?: UploadPathContext`
  ([step-executor.ts:107](../src/runner/step-executor.ts)).
- `ExecuteActionOptions.uploadPaths?: UploadPathContext`
  ([actions.ts:124](../src/browser/actions.ts)), passed at the single
  `executeAction` call site (step-executor.ts:1683). Cache replay goes
  `executeStep` → `executeStepAttempt(…, cached)` → that same call, so it
  gets the option for free.
- Producers, every `executeStep` caller: `runTest`
  ([test-runner.ts:704, 1024, 1051](../src/runner/test-runner.ts), which
  has `test.filePath` and `projectRoot` from line 380, **plus** the
  `executorOptions` literal at 1147 that becomes `ctx.executorOptions` for
  the REPL — a fourth options object, or a REPL upload step gets E1); the
  two recursive `executeStep` calls in the branched-step path
  (step-executor.ts:2523, 2569) spread `{ ...opts }` and need nothing; the session
  manager's run, whose bundle is the `projectBundle` resolved in
  `executeStepsInternal` (session-manager.ts:2515-2528) and whose
  `executeStep` call is at 4206 beside `baseUrl`; the errand runner
  (errand-runner.ts:705, bundle at 301, passes no `baseUrl` today);
  the Runner UI adapter (runner-adapter.ts:224 and 491, `filePath` at
  303); the interactive REPL (interactive-repl.ts:265) inherits
  `ctx.executorOptions` and needs nothing. `EvaluateAssertionParams` does
  not need it.
- Code-behind: `RunCodeBehindOptions.uploadPaths` → `makeStepApi` (§8).

### 4. Executor

Two changes in `executeAction` ([actions.ts:175](../src/browser/actions.ts))
and a rewritten `executeUpload`.

**Resolve first.** Immediately after `logger.subAction` (line 182) and
before the prelude — before `sanitizeCssSelector`, before
`promoteIframeFromSelector` (which runs a `count()` when the selector has
whitespace), before the frame checks and the measurement hoist:

```ts
let uploadFiles: string[] | undefined;
if (action.action === 'upload') {
  const r = await resolveUploadPaths(uploadPathsOf(action), options?.uploadPaths ?? {});
  if (!r.ok) {
    logger.error(`Action failed [upload]: ${r.error}`);   // the generic catch is below the try; this path logs itself
    return { success: false, error: r.error, retryable: false };
  }
  uploadFiles = r.absolute;
}
```

That is what makes "no selector evaluated" true under a compile run, where
the hoisted `waitFor` would otherwise spend the whole budget on a slightly
wrong selector before the path was ever checked. The generic catch
(actions.ts:405-435) is not involved — this return sits above the `try` at
243 — so `matchCount` stays `undefined` and the retry context's
"→ No elements matched this selector" suffix (prompts.ts:565) cannot
appear.

**Choose the target, then act.** `executeUpload(root, page, eff, files,
timeoutMs)`:

1. `matches = root.locator(selector)`;
   `await matches.first().waitFor({ state: 'attached', timeout })` —
   something must match, else the ordinary selector error (retryable).
2. `visible = matches.locator('visible=true')`. If `await visible.count()
   > 0`: `target = visible.first()`, and classify it with one `evaluate`:
   `'input'` when it is an `<input type="file">` **or a `<label>` whose
   `control` is one** (Playwright's `setInputFiles` follows a label to its
   control, `server/dom.js:565`, so the label can take the input route with
   no chooser round-trip); otherwise `'opener'`. If nothing is visible:
   `hidden = matches.and(root.locator('input[type="file"]'))`; if its count
   is > 0, `target = hidden.first()`, route `'input'`; else throw the
   ordinary not-visible error (retryable). `evaluate` works under a
   `FrameLocator` root; `MEASUREMENT_TIMEOUT_MS` bounds the probe.
3. **Input route.** Read `multiple` in the same probe. If `files.length >
   1` and the input is single, throw `<selector> accepts one file but the
   step gave N. Split the step, or target a multi-file field` (retryable —
   the model can pick one file or another field). Then
   `await target.setInputFiles(files, { timeout })`. Hidden is fine.
4. **Opener route.** The click must win over the chooser wait when it
   fails, and a failed click must not leave an unhandled rejection behind
   — `Promise.all([waitForEvent, click])` does exactly that (the waiter
   rejects on its own timeout later, with nobody listening; on the CLI, Node
   22's default `--unhandled-rejections=throw` would end the run; the
   server's crash guard only logs it). The pattern:
   ```ts
   const chooser = page.waitForEvent('filechooser', { timeout });
   chooser.catch(() => {});                 // handled: a click failure below is the error that surfaces
   await target.click({ timeout });         // a click error wins — it is the more specific one
   const fc = await chooser;                // times out → the chooser error below
   if (files.length > 1 && !fc.isMultiple()) throw <the single/multi error above>;
   await fc.setFiles(files);
   ```
   `filechooser` is a `Page` event, so it fires for openers inside iframes
   too — `root` may be a `FrameLocator`, `page` is always the `Page`; the
   listener is registered synchronously by `waitForEvent` before the click
   starts. If the click succeeded and no chooser arrives in `timeout`, throw
   `Clicking <selector> did not open a file chooser Playwright can answer.
   If the snapshot shows an <input type="file"> for this field, target it
   directly; a picker opened with the File System Access API cannot be
   driven` (retryable — the model can retarget; on a File System Access
   site it will fail again, which is the honest outcome, decision 15).
   Residual, stated: after a failed click the waiter stays armed for up to
   `timeout`, keeping chooser interception on for that long; and a page
   that opens a *second* chooser after the first was answered gets a native
   dialog in a headed browser, since nothing is listening. Both are edge
   cases this story does not chase.
5. Log, at info, before the Playwright call:
   `upload: <abs1>[, <abs2>…] → <selector> (<input|via file chooser>)`. The
   `subAction` line still prints the model's description; this is the line
   that names the absolute path, the way `read` and `count` print their
   detail ([actions.ts:1448, 1562](../src/browser/actions.ts)).
6. Return `upload: { via }` on `ActionExecutionResult` (actions.ts:153);
   the step executor copies it onto the sub-action record beside
   `targeting` (step-executor.ts:1754), `SubActionResult` declares it, and
   `actionsOf` (recording.ts:577-581) merges it into the transcript
   (decision 14).

Budget: `UPLOAD_TIMEOUT_MS` stays 10 s. The measurement hoist
(`singularTargetOf`, actions.ts:601) changes for `upload` to `target:
matches.first(), state: 'attached'`, since a hidden input is a legitimate
target. Two consequences for the ambiguity gate at actions.ts:261-284:

- It keys on `matchCount` for state `attached`, which is wrong for this
  action (a hidden decoy plus one visible button is `matchCount: 2` and was
  the AI being right, per the ambiguity story). So the gate gets an
  upload-specific clause: ambiguous when `visibleMatchCount > 1`, or when
  `visibleMatchCount === 0 && matchCount > 1`.
- That clause cannot read the counts off `targeting`: `measureTargeting`
  takes `visibleMatchCount` only when `full || state === 'visible'`
  (actions.ts:627-630), so a gate-only run (`ambiguousTarget: 'fail'`, no
  `measure`) would never measure it once upload is `attached`; and a zero
  visible count is stripped from `targeting` (656-657), so the second half
  of the clause could never be true even under compile. For `upload`,
  measure both counts regardless of `full` and evaluate the clause on the
  raw local counts before they are folded into `targeting`.

`SINGULAR_TARGET_ACTIONS` (prompts.ts:871) is unchanged — an upload still
has one target.

### 5. Non-retryable failures

Today `withRetry` ([retry.ts:21](../src/runner/retry.ts)) retries everything
but an aborted signal, and `StepFailureError` (step-executor.ts:228) has no
notion of retryability. `StepFailureError` reaches `withRetry` unwrapped
(the turn-loop catch at 1859 rethrows it as-is; the attempt returns
`executeStepAttempt` directly), the multi-turn loop exits on `turnFailed`
(1830) before any `needs_reeval` re-ask, and the cache writes only on
success (498), so there is no partial state to worry about. Minimal change,
no new error hierarchy:

- `ActionExecutionResult.retryable?: false` (actions.ts:153) — set only by
  the resolve-first return in `executeAction`.
- `StepFailureError.retryable: boolean` (default true); the executor sets
  it false when the failed action's result said so
  (step-executor.ts:1776-1802 → 1830-1836).
- `withRetry`: after the `signal.aborted` check and **before** the
  `attempt <= maxRetries` warning (retry.ts:41-48), `if ((err as {
  retryable?: boolean }).retryable === false) throw err;`, logged as
  `<label> failed and will not be retried: <message>` so the run log shows
  the retries were skipped on purpose, not that attempt 1 failed and a
  retry is coming.
- The cache-hit catch (step-executor.ts:452-456) checks the same flag: a
  non-retryable failure fails the step without `invalidateStep`.
- The code-behind half needs one more hop, because `runCodeBehindEntry`
  reduces a thrown error to `{ status: 'failed', expectationFailed, error:
  err.message }` (execute.ts:111-118) and the heal path (639-650) reads
  only those. `step.filePath` throws an error tagged `retryable: false`;
  `runCodeBehindEntry` propagates that as an outcome field
  (`nonRetryable: true`); and `brokenCode` at step-executor.ts:640 excludes
  it, so the step fails with the entry kept and no heal (decision 8).

Wording that follows from the trace: "no further AI turns after the
failure" — not "one AI turn total", since a model may legitimately spend a
turn on `expand` or `find` before it emits the upload.

An assertion failure keeps its current behaviour (it still burns retries);
tightening that is a separate, wider change.

### 6. Step cache

Actions are cached as the AI returned them ([step-cache.ts:29-39](../src/cache/step-cache.ts)),
so `filePath`/`filePaths` are stored verbatim — normalised, relative,
machine-independent — with no change. Three things do change:

- `reverseInterpolate` / `forwardInterpolate` (step-cache.ts:327-386) extend
  from `value` to `filePath` and each `filePaths` entry. The
  `if (!action.value) return action` early return is restructured to cover
  the new fields.
- For the path fields, `reverseInterpolate` matches each parameter's raw
  value **and** `normaliseUploadPath(value)`. This is the whole fix for
  problem 5: the step is interpolated before the model sees it
  (session-manager.ts:3772 on the server; test-runner.ts:879 on the CLI),
  so the model emits `attachments/statement.pdf`, and a literal search for
  the raw `\attachments\statement.pdf` would never match. On replay
  `forwardInterpolate` puts the raw value back, and the executor normalises
  at the point of use (decision 2). The existing longest-first ordering
  (333-335) must sort over **both** forms of every parameter, not the raw
  values alone — the normalised form is shorter when a leading slash was
  stripped, and a short form applied early can replace inside another
  parameter's longer raw value. The short-value hazard `reverseInterpolate`
  already has (`receipt: "1"` matching inside `receipt-1.png`) is
  inherited, not new.
- The code-behind leak guard's `guardedValues` (generate.ts:396-404) gains
  the normalised form of each guarded value for the same reason, so a
  frozen `attachments/statement.pdf` is caught when the parameter was
  written with backslashes.

`${env.*}`/`${data.*}` need nothing: their values are already folded into
the cache hash (session-manager.ts:3145). `stepsHash`, `SCHEMA_VERSION` and
the assertion cache are untouched. `cacheDirName` reduces to `[a-z0-9-]`
(step-cache.ts:287-319) and `stepsHash` is the JSON of the step texts, so a
cache written on Windows replays on Linux. Nothing stored is absolute — a
test asserts the cached JSON contains no drive letter.

### 7. DOM snapshot

[capture-dom.js:232-251](../src/browser/scripts/capture-dom.js): in the
hidden-element branch, before emitting the bare placeholder, special-case
`tag === 'input' && el.type === 'file'`: emit `getAttributes(el)` filtered
to `id name type accept multiple` plus the existing comment, e.g.
`<input id="identity-file" name="file" type="file"> <!-- hidden: display:none -->`.
`el` and `getAttributes` are both in scope there. The placeholder comment
text is unchanged so nothing that greps for `hidden:` moves.

[dom-cleaner.ts:862-870](../src/browser/dom-cleaner.ts): `expandDomSubtree`'s
`processEl` gets the same carve-out — a hidden `input[type="file"]` is
emitted with those five attributes (via `getAttrs(el)`) instead of being
dropped — so an `expand` on an uploader card shows the input. Note its
`isVisible` (852) also treats `visibility:hidden` and `opacity:0` as
hidden, unlike the capture script, so the expand carve-out surfaces those
inputs too; harmless, since the executor handles every kind of hidden file
input the same way.

[dom-cleaner.ts:29-33](../src/browser/dom-cleaner.ts): add `accept` and
`multiple` to `ALLOWED_DOM_ATTRIBUTES`. Both appear only on inputs; the size
cost is nil.

`hideReason` (capture-dom.js:76-87) is unchanged: on the capture path an
input hidden by `opacity:0` or moved off-screen is rendered as visible and
the executor handles it the same way. The iframe content path reuses the same capture
script, so it inherits the change; `find-in-dom.js` only prefers visible
matches and needs nothing.

### 8. Code-behind

- [types.ts:26](../src/codebehind/types.ts): `CodeBehindStepApi.filePath(relative: string): string`
  — "Resolve a path written in a step (relative to the test file's folder)
  to the absolute path Playwright needs. Throws with the same message the
  AI run would show if the file is missing or outside the project." Sync,
  because entries are simplest when they can inline it:
  `await page.locator('#statement-file').setInputFiles(step.filePath('attachments/logo.png'))`.
  Normalises its argument (decision 2), rejects `undefined` with
  *"step.filePath needs a path; step.getVar returned nothing"* so
  `step.filePath(step.getVar('x'))` fails clearly, and uses `fs.statSync`
  — reachable because `execute.ts` is framework code compiled by tsc, not
  part of the author's esbuild-bundled `.steps.ts`. Its E1–E6 errors carry
  `retryable: false`, which `runCodeBehindEntry` turns into an outcome
  field so the heal path can honour it (§5).
- [execute.ts:84-91, 146-151](../src/codebehind/execute.ts): `RunCodeBehindOptions.uploadPaths`
  → `makeStepApi(scope, resolvedParameters, outputs, envData, uploadPaths)`.
  Missing base folder → E1. The only executing call site is
  `runCodeBehindStep` (step-executor.ts:627-637), built from `opts`, so
  once `StepExecutorOptions.uploadPaths` exists nothing else is needed.
- Generation prompt ([prompts.ts:1166-1183](../src/ai/prompts.ts)): the
  context blurb gains `step.filePath(relative)`; a new rule **7a** — not 8:
  the injected selector rules already start at 8 (prompts.ts:970, 1032,
  1049) and `postConditionNumber` follows them (1120-1121), so the
  post-condition stays 9 unmeasured / 10 measured and the existing tests
  (codebehind-generate.test.ts:336, 369) stay green:
  > 7a. **Files come through `step.filePath`.** An `upload` action's
  > `filePath`/`filePaths` in the transcript are relative to the test file.
  > Pass each through `step.filePath('…')` — the verbatim string — and hand
  > the result to `locator.setInputFiles(...)` when the action's `upload.via`
  > is `"input"`. When it is `"chooser"`, the action clicked a control that
  > opened a picker; write it as:
  > `const chooser = page.waitForEvent('filechooser'); chooser.catch(() => {});
  > await page.locator('#identity-choose').click();
  > await (await chooser).setFiles(step.filePath('attachments/statement.pdf'));`
  > A parameterised path is `step.filePath(step.getVar('name'))`. Never
  > write an absolute path, and never hand a string literal straight to
  > `setInputFiles` or `setFiles`.
- Static backstop ([generate.ts:250-305](../src/codebehind/generate.ts)),
  beside the ambiguous-selector complaint and using the same re-ask hook
  (193, 219): `LITERAL_FILE_ARG =
  /\.(setInputFiles|setFiles)\(\s*(['"\`]|\[\s*['"\`])/` — a string literal
  or array-of-literals as the first argument → one re-ask with
  *"upload paths must go through step.filePath(...)"*, then decline. Same
  regex catches an absolute path literal, since that too is a literal.
  `STRICT_TARGET_CALL` (282) already lists `setInputFiles` for the
  bare-selector check; the two regexes look at different arguments of the
  same call, and a test pins a candidate that trips both so the order of
  complaints is deliberate (selector first — it is the one the model is
  likelier to get wrong).
- Transcript: the raw JSON already shows `filePath`/`filePaths` and
  `targeting` (prompts.ts:1067); `upload.via` rides along as a sibling
  (decision 14) and `targetingLegend` gains one line explaining it.
- Review checklist ([review.ts:51-78](../src/codebehind/review.ts)): item 9,
  "Upload paths go through `step.filePath`, never a literal or an absolute
  path".
- Loader and writer: unchanged. Recording: `RecordedAction` widens to carry
  `upload` and `actionsOf` merges it (decision 14); `redactDeep` leaves
  paths alone.

### 9. Report, clients, docs

- [generator.ts:862-913](../src/report/generator.ts) `renderSubAction`:
  for `action === 'upload'`, one detail line under the description —
  `file: attachments/logo.png` or `files: attachments/receipt-1.png,
  attachments/receipt-2.png` — the *relative* form on the success path,
  since the report is shared and the absolute path is in the run log (and
  in the error text when it failed, §3). Rendered with the existing
  `.sub-action-body` class; no template change — but `hasBody`
  (generator.ts:867) gates the body on screenshot/DOM/reasoning/error/API
  data, so it must count the upload line too or a plain success renders
  nothing.
- Flick renders every action field generically
  (flick-vscode/src/webview/main.ts:922-935, arrays via `formatValue`):
  `filePaths` shows with no change. TestBench never sees actions (no action
  event in the SSE protocol): no change, no version bump.
- MCP `STEP_SYNTAX` crib ([tools.ts:1686](../src/mcp/tools.ts)) gains one
  line: `Upload file attachments/logo.png   a file path is relative to the
  test file (run_steps/run_errand: the project root)`.
- Docs: SPEC.md:380 gains `filePaths`; SPEC-SESSIONS-API.md drops "File
  uploads" from Out of Scope (line 363) and adds an `upload` example under
  Step Format (line 105) with the relative-to-`testFilePath` rule and the
  no-test-file limitation; README.md:746 row reads
  `locator.setInputFiles` / `filechooser` and links the story; the
  attachments READMEs are already right; CLAUDE.md's note that the fixture
  app "holds no per-run state" is corrected (it has held `/api/documents`
  since Part 1 — tests clear it first, and a concurrent run in another
  worktree can still race step 11 of `securebank-upload.md`).
- CHANGELOG: `### Added — upload steps: "Upload file \attachments\logo.png"`
  under Unreleased.

## Tests

Unit and seam, root vitest (new files are marked *new*):

- *new* `tests/upload-paths.test.ts` — `normaliseUploadPath` (backslashes,
  leading slash, UNC prefix kept, spaces/`#`/`?` untouched) and
  `resolveUploadPaths`: relative resolves against base; `..` inside the
  fence allowed; a folder named `..cache` allowed; `..` escaping → E2; no
  base → E1; missing → E3; directory → E4; `file://` with a fragment → E6;
  absolute drive/UNC accepted and fenced; order preserved; on Windows a
  differently-cased drive letter does not trip the fence; `projectRoot:
  null` fences at the base.
- `tests/action-parser.test.ts` — upload: `filePath` normalisation
  (backslashes, leading slash, escaped-JSON form); `filePaths` array,
  blanks and non-strings dropped, string-valued treated as `filePath`,
  both-present precedence; aliases `attach`/`file_upload` → `upload`;
  `extractJson` repairs `{"filePath": "\attachments\logo.png"}` as the raw
  text a model would emit, and leaves valid escapes alone.
- *new* `tests/upload-action.test.ts` — real Playwright against the fixture
  server (the `open-page.test.ts` boot pattern), calling `executeAction`
  directly with `uploadPaths` pointed at `fixtures/tests`:
  - **minimum**: visible input, one file, `upload.via === 'input'`;
  - hidden input by id (no visible match → hidden file-input fallback);
  - the same hidden-input case with `ambiguousTarget: 'fail'` and
    `measure: true`, asserting success and `targeting.matchCount === 1` —
    this is the test that catches the hoist reverting to `visible`;
  - a selector matching a hidden decoy input first and a visible button
    second → the button is chosen (visible-first), `via === 'chooser'`;
    run **gate-only** (`ambiguousTarget: 'fail'`, no `measure`) and
    asserting the gate did not fire — this is the test that catches the
    clause reading counts off a `targeting` that never measured them;
  - two visible file inputs under one selector, gate-only → the ambiguity
    refusal fires;
  - opener button via chooser; a `<label for>` whose control is the file
    input → input route, no chooser;
  - opener inside an iframe (a small fixture page wrapping `documents.html`
    in an iframe, driven through the `frame` field);
  - two files into the multi field; two files into a single field → the
    single/multi error, retryable;
  - missing file → E3, `retryable: false`, and no navigation, no chooser,
    no click, **no selector evaluated** (a page `filechooser` listener, a
    click counter, and a spy on `page.locator`) — run twice, plain and with
    `measure: true`;
  - a `{{param}}` value with a leading backslash, resolved by the executor
    after `forwardInterpolate` (the minimum-scenario check for decision 2);
  - a non-file opener that opens nothing → the chooser error, retryable, and
    no unhandled rejection (`process.on('unhandledRejection')` spy);
  - a logger spy sees the `upload: <abs> → <selector>` line with an
    absolute path under `fixtures/tests/attachments`.
  Asserts the fixture's table after each success, so the bytes are proven
  to arrive.
- `tests/step-cache.test.ts` (or the existing cache suite) — `Upload file
  {{statement}}` with `statement: \attachments\statement.pdf`
  reverse-interpolates `filePath` and each `filePaths` entry to the
  placeholder; the cached JSON contains no absolute path and no
  backslash; `forwardInterpolate` restores the raw value; two parameters
  where one's normalised form is a substring of the other's raw value
  still reverse-interpolate longest-first.
- *new* `tests/retry.test.ts` — `withRetry` stops on `retryable === false`
  after one attempt, rethrows the same error, and logs the
  "will not be retried" line rather than "failed on attempt 1"; other
  errors still retry.
- `tests/step-executor` suite — the **composition** of the chain: with
  `retries: 1` and a mocked AI, E3 → one attempt, one AI call; the
  chooser-not-opening error → two attempts, two AI calls; a cached upload
  whose file is missing → E3, the cache entry **not** invalidated, no AI
  call; a cached upload written under base A replayed with
  `uploadPaths.baseDir` B → the executor resolved against B (verification
  clause 5); a code-behind entry whose `step.filePath` throws E3 → step
  fails, entry kept, no heal, and the outcome carries `nonRetryable`
  (`tests/codebehind-healed-run.test.ts` is the home for that one).
- *new* `tests/api-server-upload.test.ts` — the client seam: POST a step
  through the real api-server entry with `testFilePath` set and a mocked
  AI returning an `upload` action, and assert the executor received
  `uploadPaths.baseDir === dirname(testFilePath)` and the bundle's
  `projectRoot`; POST a missing-file step **with** `testFilePath` → E3 as
  the step error, one AI call; POST the same step **without**
  `testFilePath` → E1, one AI call. Also through `run_errand`'s runner, so
  errand-runner's own threading is covered.
- `tests/dom-cleaner.test.ts` / a capture-dom test — a hidden
  `<input type="file" id="x" accept=".pdf" multiple>` renders with those
  attributes; a hidden `<input type="text" id="y">` still renders bare; an
  input inside a hidden `<div>` is still collapsed with it; `accept` and
  `multiple` survive on a visible input; `expandDomSubtree` emits the hidden
  file input.
- `tests/prompts-cache.test.ts` — rule 4 carries the file-input exception
  and rule 10a renders with a backslash in its example; `formatTestInfo`
  untouched, so the strict-equality test stays green.
- `tests/codebehind-generate.test.ts` — the prompt carries rule 7a and the
  post-condition is still 9; `actionsOf` carries `upload.via` into the
  transcript; a candidate calling
  `setInputFiles('attachments/logo.png')` gets one re-ask then declines; a
  candidate calling `setInputFiles(step.filePath('attachments/logo.png'))`
  passes; a candidate that is both bare-selector and literal-path gets the
  selector complaint first; `guardedValues` includes the normalised form
  of a backslash parameter; `upload.via` appears in the transcript legend
  and `measuredSelectorRules` still classes an unmeasured upload as
  unmeasured.
- *new* `tests/codebehind-execute.test.ts` — `step.filePath` resolves
  against `uploadPaths.baseDir`, normalises a backslash argument, throws E3
  text for a missing file, E1 with no base, and a clear message for
  `undefined`.

Live, run by hand (each needs the AI key; the fixture app is booted by the
harness or by `npx tsx fixtures/test-app/server.ts`):

- `node dist/index.js run templates/init/tests/securebank-upload.md` —
  verification clauses 1–5 and 8. This story adds the `## Parameters`
  block (`statement: \attachments\statement.pdf`) and a fourteenth step,
  *"Upload file {{statement}} as the statement, then click Upload"*, to
  that file; the live TestBench suite below counts fourteen.
- The same file compiled (`Compile This Test` or the CLI compile command)
  and replayed strict — clause 6; the compile run doubles as the
  measurement-on half of clause 4 when step 12 is temporarily pointed at a
  missing file.
- The same file with `## Config: cdp` against a `start_cdp_browser` Chrome
  — clause 7.
- A live TestBench suite `testbench-native/tests/integration/live/upload-steps.test.cjs`
  modelled on `pause-resume.test.cjs`, asserting all fourteen steps reach
  pass or pass-cached. That harness observes step statuses only, so the
  absolute-path log line is asserted in `upload-action.test.ts` via the
  logger spy, not here. Added so the next person does not have to remember
  clause 1 by hand.

## Rollout

Server-side only: `npm run build`, restart the `:3100` server, reload any
TestBench windows so their next run hits the new build. No TestBench or
runner-core change, so no version bump and no `.vsix`. The
`securebank-upload.md` test that has been failing since PR #117 turns
green; that is the smoke test.

## Non-goals

- **Drag-and-drop of OS files** — needs a synthesised `DataTransfer`;
  separate story. The fixture's drop zone works for humans only.
- **File System Access API pickers** (`showOpenFilePicker`) — Playwright
  cannot answer them; the chooser-timeout message says so.
- **Downloads** — the reverse direction; separate story.
- **Shipping bytes from a remote TestBench to the server** — the file must
  be readable by the server process. The E3 message says where it looked.
- **`accept` / size enforcement in the framework** — the site decides.
- **A base folder for Flick** — Flick has no test file; relative paths get
  E1. Giving Flick a workspace-relative base is a one-line follow-on once
  someone wants it.
- **Assertion failures becoming non-retryable** — worth doing, wider than
  this story.
- **Making the fence a security boundary** — see decision 5.

## Follow-ons worth a chip, not this story

- **TestBench diagnostic for a missing attachment**: a squiggle under
  `\attachments\missing.png` at edit time, before any run. Fits the
  `computeSectionDiagnostics` pattern
  (testbench-native/src/extension/section-diagnostics-core.ts:41) with a
  new TB code beside TB020 (runner-core/src/errors.ts:160) — remember the
  `SAMPLE_CONTEXTS` audit in runner-core/tests/errors.test.js and the
  `node --test` run. Needs a step-text heuristic for "this token is a file
  path", which is why it is not here.
- **Path completion** for `\attachments\` in step text, mirroring the
  `${data.}` completion.
- **A second chooser after the first was answered** leaves a native dialog
  up in a headed browser; if a real site does that, a `filechooser`
  listener that stays armed for the step's remaining budget is the fix.

## What the review changed

Three passes ran against the first draft on 2026-09-03. What they moved:

- **Prompt rule 10a contradicted rule 4** ("never target hidden
  placeholders") and steered the model away from the button route the
  verification rule depended on. Rule 4 gets a one-tag exception; the
  selector rule became "target the control the step names, else the
  input" (decision 10); verification clause 1 now allows the `click` on
  the submit button the fixture's own steps require.
- **"Fails before any browser call" was false** under a compile run: the
  measurement hoist runs before the action switch, and the generic catch
  runs a `count()`. Path resolution moved to the top of `executeAction`
  and returns instead of throwing.
- **The `Promise.all` chooser race leaked an unhandled rejection** that can
  end a CLI run. Replaced with the handled-waiter pattern, in the executor
  and in the code-behind rule.
- **An unfiltered `.first()` reintroduced the hidden-decoy bug** the
  selector-ambiguity story fixed. Replaced with visible-first, then a hidden
  file input, never a hidden anything-else (decision 7), and the ambiguity
  gate got an upload-specific clause.
- **A `{{param}}` written with backslashes could never round-trip**: the
  model sees the interpolated step and emits the normalised form, so a
  literal reverse-match on the raw value misses. Reverse-interpolation now
  matches the normalised value too, and normalisation runs at every point
  of use, not only in the parser.
- **The fence was overclaimed**: `resolveProjectRoot` is lexical, not
  realpath, and `testFilePath` is client-supplied. Decision 5 now says what
  the fence is for and what it is not; the `..` test was tightened.
- **Code-behind rule numbering collided** with the injected selector rules
  at 8; the new rule is 7a.
- **Non-retryable failures still invalidated a cache hit and healed a
  code-behind entry.** They no longer do (decision 8).
- Producer list gained the errand runner, the Runner UI and the REPL's
  options literal; `expandDomSubtree` gained the carve-out; `upload.via`
  moved out of `targeting` — and a confirmatory pass then showed it would
  be dropped by `actionsOf` and the `& { targeting? }` types unless all
  four are widened; the `value` fallback was decided away; error messages
  gained verb-led fixes; the live-suite proposal was scoped to what its
  harness can observe; and the test plan gained the composition,
  replay-under-another-base, hoist-regression and unhandled-rejection
  cases.
- **The confirmatory pass** also found that the upload-specific ambiguity
  clause could never fire (a gate-only run does not measure the visible
  count once the state is `attached`, and a zero count is stripped from
  `targeting`), that a `step.filePath` error loses its non-retryable flag
  inside `runCodeBehindEntry`, that the report's `hasBody` gate would hide
  the upload line, that reverse-interpolation's longest-first sort must
  cover both forms of a value, and that verification clause 8 had no live
  vehicle — so the fixture test gains a parameterised step.

## Decisions after review (2026-09-03)

Two questions were left open by the review and put to the user; both
answered the same day.

1. **`step.filePath` is synchronous.** It returns the absolute path
   directly, so an entry stays one expression —
   `setInputFiles(step.filePath('attachments/logo.png'))` — and matches
   `step.getVar`, the other synchronous helper the model already writes
   against. The blocking `fs.statSync` costs microseconds. Async was
   rejected because its only benefit (running the helper somewhere
   without synchronous file access) is not needed, and a forgotten
   `await` would hand Playwright a promise instead of a path.
2. **The `extractJson` repair ships.** When the first `JSON.parse` fails,
   the parser retries once with every backslash inside a string token
   that is not followed by a valid JSON escape character replaced by a
   forward slash, logged at debug. It never runs on JSON that parsed. The
   prompt rule asking for forward slashes stays the first line of
   defence; the repair exists because a model copying
   `\attachments\logo.png` from the step is the single most likely first
   failure a user will see, and losing a whole AI turn to it is the wrong
   outcome.

No open questions remain.
