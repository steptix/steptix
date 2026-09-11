# File upload steps — "Upload file \attachments\logo.png"

## In plain terms

You should be able to write a test step like this and have it just work:

- *Upload file \attachments\logo.png*
- *Upload \attachments\statement.pdf as the bank statement*
- *Attach \attachments\receipt-1.png and \attachments\receipt-2.png*
- *Try to upload \attachments\malware.exe and confirm it is rejected*

The framework picks the file off disk, puts it into the page's file picker
the way a person would, and the site under test receives a real upload.

This story is in two parts, built in this order:

1. **A Documents page in the SecureBank fixture app** (`fixtures/test-app`)
   that behaves like the upload screens real sites have — a plain file field,
   a styled "Choose file" button hiding its input, a multi-file field, and
   server-side validation that can reject a file. This part is built first,
   on its own, so the framework work has something honest to be tested
   against.
2. **Framework support for upload steps** — teaching the model that the
   `upload` action exists, making the executor handle the hidden-input
   pattern, and deciding what a path in a step is relative to. Specified here
   so the page in part 1 is shaped by what part 2 needs; built as a
   follow-on.

### What it looks like in practice

**You write:** *"Upload file \attachments\logo.png"* on the Documents page.
**You get:** one `upload` action targeting the statement file field, the
file resolved against the folder of the test file being run, and the page's
"Uploaded documents" list showing `logo.png · 87 B · image/png`. The run
log names the absolute path that was sent, so a wrong folder is never a
mystery.

**You write:** *"Use the Choose file button to upload \attachments\logo.png"*
on the styled uploader, where the `<input type="file">` is `display:none`.
**You get:** the same result. The executor recognises that the target opens a
file chooser rather than being one, clicks it, and answers the chooser with
the file — no reliance on the hidden input being visible or even in the
snapshot.

**You write:** *"Upload \attachments\malware.exe"*
**You get:** the upload action succeeds (the file was handed to the page),
the page shows *"malware.exe is not an allowed file type"*, and the next
step's assertion on that message passes. Rejection is the site's decision,
not the framework's.

**You write:** *"Upload file \attachments\missing.png"*
**You get:** the step fails before touching the browser:
*"Upload file not found: C:\…\project\tests\attachments\missing.png (resolved
from `\attachments\missing.png` against the test file's folder,
C:\…\project\tests)"*.

**You run the same test again.**
**You get:** the upload step replays from the step cache with zero AI calls,
because the cached action stores the path exactly as the step wrote it, not
the absolute path it resolved to on this machine.

> **Verification rule for part 1.** "Done" means, with `fixtures/test-app`
> running: (1) a plain Playwright script (no AI) can `setInputFiles` on the
> plain field, on the hidden input behind the styled button, and on the
> multi-file field, and after each the "Uploaded documents" list shows the
> right file name, size and type; (2) the same script proves the styled
> button works through `page.waitForEvent('filechooser')` too; (3) a
> disallowed extension and an oversized file are each rejected with the
> exact message this spec names, and nothing is added to the list;
> (4) `GET /api/documents` returns what the page shows and
> `DELETE /api/documents` empties it; (5) the server's multipart parsing
> produces the same sha256 as the file on disk, for a binary file, so bytes
> arrive intact; (6) the Documents link appears in the sidebar of every
> SecureBank page that has one, and the existing `securebank.md` live suites
> still pass unchanged.

> **Verification rule for part 2.** Against the Documents page: (1) each
> "You write" step above executes as a single `upload` action in the run log
> and passes; (2) the hidden-input variant passes without the model ever
> seeing the input's id; (3) the multi-file step sends both files in one
> action; (4) the missing-file step fails with the message above and no
> browser action; (5) a compiled code-behind for the upload step reads the
> path through the step context, not as an absolute literal, and replays
> with zero AI calls; (6) re-running the markdown test hits the step cache
> for the upload step.

## Context — what exists, and why the steps don't work today

Most of the plumbing exists and has for a while:

| Layer | State |
|---|---|
| [types.ts:7](../src/ai/types.ts) | `'upload'` is an `ActionType`; `filePath` is a field on `AIAction` |
| [action-parser.ts:5](../src/ai/action-parser.ts) | `upload` accepted; `filePath` passes through (line 292) |
| [actions.ts:532](../src/browser/actions.ts) | `executeUpload` — `locator(selector).locator('visible=true').first().setInputFiles(filePath)` with a 10 s budget |
| [step-executor.ts:53](../src/runner/step-executor.ts) | `upload` is in `MUTATING_ACTIONS`, so cache replay treats it correctly |
| [template.ts:326](../src/report/template.ts) | the report already renders a `filePath` row with a copy button |
| [SPEC.md §6.1](../docs/specs/SPEC.md) | documents `upload` with `selector`, `filePath`, `description` |
| [prompts.ts](../src/ai/prompts.ts) | **Never mentions upload as an action.** Rules 9–12 cover navigate, type, select, wait; the only "upload" in the prompt is an example of a slow wait |
| [SPEC-SESSIONS-API.md](../docs/specs/SPEC-SESSIONS-API.md) | lists "File uploads" under *Out of Scope (v1)* |

So the situation is the one the scroll story found: the model's action
vocabulary is whatever the prompt says it is, and the prompt does not say
`upload`. When the model does guess, three more things go wrong:

- **Hidden inputs.** The overwhelmingly common real-world uploader is a
  styled button or drop zone with the `<input type="file">` set to
  `display:none` (or visually hidden off-screen), and a click handler that
  calls `input.click()`. `executeUpload` filters to `visible=true`, so the
  locator never matches. Playwright's `setInputFiles` itself works fine on a
  hidden input; the filter is what breaks it. And the DOM snapshot collapses
  hidden elements to a bare `<input> <!-- hidden: display:none -->` with
  every attribute dropped ([capture-dom.js:248](../src/browser/scripts/capture-dom.js)),
  so the model cannot even name the input. It can only name the button.
- **Paths.** Nothing resolves `filePath`. Whatever the model emits is passed
  straight to Playwright, which resolves relative paths against the server
  process's working directory — not the project, not the test file. A
  step written as `\attachments\logo.png` is a rooted path on Windows and
  means `C:\attachments\logo.png`. The Sessions API server runs the browser,
  so the file must be readable by *that* process, which is fine for
  TestBench on the same machine and worth a clear error everywhere else.
- **Multiple files.** `filePath` is a single string. `setInputFiles` accepts
  an array; the action shape does not.

The fixture app has no page with a file input at all, which is why part 1
comes first.

## Part 1 — the Documents page

### Where it lives

- `fixtures/test-app/documents.html`, served at `/documents` (added to
  `friendlyRoutes` in [server.ts](../fixtures/test-app/server.ts)) and at
  `/documents.html`.
- A **Documents** entry (📄) in the sidebar of `dashboard.html` and
  `transactions.html`, between Transactions and Settings, `href="documents.html"`.
  Both sidebars are separate copies, so both are edited.
- Same look as the other SecureBank pages: the shared sidebar, the page
  header, cards for each section. No new CSS framework, no build step — one
  static HTML file with inline script, like its siblings.
- **No login required** for the page or its API, like `assertions.html` and
  `confirm-action.html`. Root vitest integration tests drive the fixture app
  with bare Playwright and should not have to log in to reach a file input.
  Decided 2026-09-03 (Decisions, below).

### What is on the page

Three upload controls, each in its own card, each exercising one pattern the
framework must cope with. They post to the same endpoint and feed the same
list, so a test can use any of them and assert on one place.

**Card 1 — "Upload a statement" (plain field).** The minimum scenario:

```html
<label for="statement-file">Statement file</label>
<input type="file" id="statement-file" name="file" accept=".pdf,.png,.jpg,.jpeg">
<button type="submit" id="statement-upload">Upload</button>
```

Visible, labelled, in the snapshot with its id. If the framework cannot
upload here, nothing else matters.

**Card 2 — "Proof of identity" (styled uploader).** The typical scenario:

```html
<div id="identity-dropzone" class="dropzone" role="button" tabindex="0">
  <span>Drag a file here or</span>
  <button type="button" id="identity-choose">Choose file</button>
  <input type="file" id="identity-file" name="file" class="visually-hidden" accept=".pdf,.png,.jpg,.jpeg">
</div>
<div id="identity-selected" class="selected-file"></div>
<button type="submit" id="identity-upload" disabled>Upload</button>
```

The input is `display:none`; the button's click handler calls
`identityFile.click()`. Choosing a file enables Upload and shows the chosen
name in `#identity-selected`. The drop zone also accepts a real drag-and-drop
(`dragover`/`drop` handlers reading `dataTransfer.files`) so the page is
honest, but driving a drop is **not** something part 2 promises — see
non-goals.

**Card 3 — "Receipts" (multiple files).**

```html
<input type="file" id="receipts-files" name="file" multiple accept=".pdf,.png,.jpg,.jpeg">
<button type="submit" id="receipts-upload">Upload all</button>
```

Sends every chosen file in one multipart request; the list gains one row per
file.

**"Uploaded documents" card.** A table, `#documents-table`, one row per
upload, columns: Name, Size (human-readable, e.g. `1.2 KB`), Type (the MIME
type the browser sent), SHA-256 (first 12 hex chars, full hash in a `title`),
Uploaded (time). Rows carry `data-name` and `data-sha256` so a test can
target one precisely. Empty state: a single row *"No documents uploaded
yet."* A **Clear all** button (`#documents-clear`) calls
`DELETE /api/documents` and resets the table.

**Messages.** One status region, `#upload-status`, `role="status"`, shows the
outcome of the last submit:

| Situation | Message | Where checked |
|---|---|---|
| Success | `Uploaded logo.png (1.2 KB)` — or `Uploaded 2 files` for card 3 | client, from the response |
| Submit with nothing chosen | `Choose a file first` | client |
| Disallowed extension | `malware.exe is not an allowed file type` | server (400), echoed by client |
| Over the size limit | `big.pdf is larger than the 1 MB limit` | server (413), echoed by client |

Allowed extensions: `.pdf .png .jpg .jpeg .txt .csv`. Limit: 1 MB per file.
Server-side checks are the ones that count — `accept` on the input is a
hint the browser's picker honours, but `setInputFiles` bypasses the picker,
so the server has to say no for the rejection cases to be testable at all.

### Server side

Three routes on the existing `http` server, no new dependencies:

- `POST /api/documents` — `multipart/form-data`, field name `file`
  (repeated for multiple). Hand-rolled boundary parser over the raw body
  buffer: split on the boundary, read `Content-Disposition` filename and
  `Content-Type` per part, take the bytes between the blank line and the
  next boundary. Validates extension and size per part, and rejects the
  **whole request** if any part fails (nothing half-added). Stores
  `{ id, name, size, type, sha256, uploadedAt }` in an in-memory array;
  bytes are hashed and dropped, not kept. Returns `201 { documents: [...] }`
  with the rows added.
- `GET /api/documents` — `200 { documents: [...] }`, oldest first.
- `DELETE /api/documents` — `204`, empties the array. Exists so tests and
  suites can isolate themselves without restarting the server; the fixture
  app is shared between concurrent worktree runs (CLAUDE.md), and this is the
  first endpoint with per-run state, so **every test that asserts on the
  list clears it first**.

The body reader for this route reads raw bytes into a `Buffer`; the existing
`parseBody` is JSON-only and must not be reused. Cap the raw body at 8 MB
and answer `413` above it so a runaway upload cannot pin the fixture.

### Sample files

A step path resolves against the folder of the test file that uses it
(Decisions, below), so the sample files live **beside the tests**, one copy
per place tests live:

- `fixtures/tests/attachments/` — used by the root vitest for part 1 and by
  any `fixtures/tests/*.md` that uploads.
- `templates/init/tests/attachments/` — used by `templates/init/tests/`,
  the live TestBench workspace, so `securebank-upload.md` can say
  `\attachments\logo.png`.

Contents: `logo.png` (a real 16×16 PNG, 87 bytes), `statement.pdf` (a
minimal one-line PDF), `receipt-1.png` and `receipt-2.png` (distinct PNGs,
distinct hashes), `notes.txt`, `malware.exe` (a text file with the wrong
extension — the server only looks at the name), and a `README.md` saying
what each is for. `big.pdf` (just over 1 MB) is generated at test time by
the vitest, **not** committed. The folder is called `attachments/` (plural,
matching `tests/`, `skills/`, `reports/`); nothing in the framework depends
on the name — a test author can call theirs anything, since the path in the
step is relative to the test.

### Tests for part 1

- `tests/test-app-documents.test.ts` (root vitest): boots `server.ts` the
  way `open-page.test.ts` does, then (a) hits the three API routes with
  `fetch` + `FormData` and checks the sha256 against `fixtures/attachments`,
  and (b) drives the page with bare Playwright through all three cards using
  `setInputFiles` and the `filechooser` route, asserting on the table and
  status messages. This is the "an upload is automatable at all" proof that
  part 2 is measured against, and it is the test that catches the hidden
  input regressing to visible-only.
- `templates/init/tests/securebank-upload.md`: the markdown test for part 2,
  written now with the steps from "What it looks like in practice", and
  expected to fail until part 2 lands. Sits beside `securebank.md`, which is
  left untouched so `pause-resume` and `stop-report` keep their fixture.

## Part 2 — framework support (follow-on, specified here)

> **Superseded by [upload-action.md](upload-action.md)**, the full Part 2
> spec written after Part 1 merged (PR #117). The outline below is kept as
> the record of what Part 1 was shaped by; where the two differ, the newer
> story wins.

### Step phrasing the model must recognise

Any of *upload*, *attach*, *choose the file*, *select the file*, followed by
a path — with or without naming the field or button. The path is whatever
sits between the verb and the end of the clause: `\attachments\logo.png`,
`attachments/logo.png`, `./attachments/logo.png`, or a quoted path with
spaces. Two or more paths joined by *and* or a comma mean one multi-file
upload.

### Action shape

Extend, don't add — same reasoning as the scroll story: the vocabulary
already has `upload`.

```json
{ "action": "upload", "selector": "#statement-file", "filePath": "\\attachments\\logo.png", "description": "Upload logo.png as the statement" }
{ "action": "upload", "selector": "#identity-choose", "filePath": "\\attachments\\logo.png", "description": "Upload via the Choose file button" }
{ "action": "upload", "selector": "#receipts-files", "filePaths": ["\\attachments\\receipt-1.png", "\\attachments\\receipt-2.png"], "description": "Upload both receipts" }
```

- `filePath` stays as-is for one file; `filePaths` (array) is added for
  several. Exactly one of the two. (This outline said the parser would
  collapse a one-element `filePaths` to `filePath`; the Part 2 spec keeps
  it an array and reads both through one accessor — upload-action.md,
  decision 13.)
- The model writes the path **verbatim from the step**. Resolution is the
  framework's job (below), which is what keeps the cached action and the
  compiled code-behind machine-independent.
- `selector` is either the `<input type="file">` — when the snapshot shows
  one — or the visible control that opens the chooser. The prompt rule says
  to prefer the input when it is visible and the button otherwise, and never
  to try to make a hidden input visible first.

### Executor

`executeUpload` becomes:

1. Resolve the path(s) (below). Missing file → fail the action before any
   browser call, with the message from "What it looks like in practice".
2. Locate `selector` **without** the `visible=true` filter. If the first
   match is an `input[type="file"]` → `setInputFiles(paths)`. Hidden is fine;
   this is the one action where the visible filter is wrong.
3. Otherwise → race `page.waitForEvent('filechooser')` against a click on
   the visible match, and answer the chooser with `setFiles(paths)`. If no
   chooser opens within the budget, fail with *"Clicking `<selector>` did not
   open a file chooser — target the `<input type=\"file\">` directly if the
   snapshot shows one"*.
4. Budget stays `UPLOAD_TIMEOUT_MS` (10 s); the selector-measurement hoist
   ([actions.ts](../src/browser/actions.ts), `singularTargetOf`) keeps its
   `visible` state for the button case and gains an `attached` state for the
   input case.

`page.setInputFiles` over CDP streams the bytes from the server process, so
a CDP-attached browser on another machine still works as long as the
Sessions API server can read the file. That is the rule to document: *the
file must exist where the server runs*.

### Path resolution

Rooted-looking paths in steps (`\attachments\logo.png`) are meant to be
test-relative — nobody writes `C:\attachments` in a test. Decided
2026-09-03: the base is **the folder of the test file being run**. So:

- Strip a leading `\` or `/`, convert `\` to `/`, and resolve against
  `path.dirname(testFilePath)`. The Sessions API server already receives the
  test file's path with every run (it is what `resolveProjectBundle` keys
  on), and the CLI has it from the argument. A drive-letter or UNC path, or
  a `file://` URL, is left absolute.
- A step inside a **skill** resolves against the folder of the test file
  that invoked the skill, not the skill's own folder — the skill has no test
  file of its own and the invoking test is the thing that owns the run. A
  skill that needs its own fixtures can reach them with `..` (below), and a
  future story can add a skill-relative form if that turns out to be wanted.
- `..` is allowed, but anything that resolves **outside the project root**
  (the `aiui.config.json` folder) is refused with a clear error — the server
  should not be a file-read oracle for arbitrary paths just because a test
  asked. Projects with no `aiui.config.json` fall back to the test file's
  folder as the fence.
- Refuse a path that is missing or is a directory before any browser
  action, naming both the resolved absolute path and the base it was
  resolved against.
- The run log prints the absolute path that was sent.

The step-relative base means the same test file, moved with its
`attachments/` folder, keeps working — and that the cached action and the
compiled code-behind can carry the verbatim step path and stay
machine-independent.

### Snapshot, prompt, cache, code-behind

- **Prompt.** A new rule 10a next to `type`: what `upload` is, the two
  selector choices, verbatim paths, `filePaths` for several, and "do not
  add a `wait` after it — the page updates synchronously when the input's
  `change` event fires; wait only if the step names a completion condition".
- **Snapshot.** A hidden `<input type="file">` keeps its `id`, `name` and
  `type` in the placeholder comment (`<input> <!-- hidden: display:none;
  #identity-file type=file -->`) so the model can see there *is* an input
  behind the button even though it should target the button. Small change
  in `capture-dom.js`, scoped to `type=file`.
- **Cache.** `upload` is already mutating. The cached action carries the
  verbatim path, so a cache hit on another machine resolves against that
  machine's project root. The cache key must not include the resolved
  absolute path.
- **Code-behind.** Generated code uses `step.filePath('\\attachments\\logo.png')`
  (a new helper on the step context that applies the same resolution) and
  `locator.setInputFiles(...)` or the filechooser pattern. The generation
  prompt's rule 1 ("no resolved literals") extends to absolute file paths.
- **Report.** Already renders `filePath`; add `filePaths` as a joined list.
- **Docs.** `SPEC-SESSIONS-API.md` drops "File uploads" from out-of-scope;
  `SPEC.md §6.1` gains `filePaths`; the Flick/TestBench step-writing docs
  gain the phrasing examples.

## Non-goals

- **Drag-and-drop of OS files.** Playwright cannot drop a file from the
  desktop; the only route is synthesising a `DataTransfer` in page script.
  The drop zone on the fixture page works for humans and is there so the
  page is realistic, but no step phrasing promises to drive it. A later
  story can add a `dragDrop` action if a real site needs it.
- **Downloads.** The reverse direction — asserting that clicking a link
  saved a file — is a separate story
  ([tools-with-playwright-access.md](tools-with-playwright-access.md)
  already mentions it).
- **Uploading from the TestBench machine to a remote server.** When the
  extension and the Sessions API server are on different machines the file
  has to be on the server's side. Shipping bytes over the Sessions API is
  out of scope; the error message says where the file was looked for.
- **Files inside iframes** are not special: the existing `frame` field
  applies to `upload` like any other action.

## Decisions (2026-09-03)

Asked and answered before part 1 was built:

1. **A step path is relative to the test file's folder.** Not the project
   root and not a configured directory. The example step `\attachment\...`
   fixed the shape; the sample folders here are called `attachments/`, but
   the name is the test author's. The skill case is handled by resolving
   against the *invoking* test (Path resolution, above).
2. **All four page features:** the plain field, the styled button with a
   hidden input, the multiple field, and server-side rejection (bad
   extension, over 1 MB). The drop zone stays decoration on card 2.
3. **No login** for the Documents page or `/api/documents`.
4. **Part 1 only on this branch.** The page, the server routes, the sample
   files, the vitest, and the not-yet-passing `securebank-upload.md`. Part 2
   is its own branch off this spec.

Left at the proposed defaults, not separately decided: the allow-list
(`.pdf .png .jpg .jpeg .txt .csv`) and the 1 MB per-file limit.
