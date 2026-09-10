# API Server Specification — v1

## Overview

A REST API server that allows callers to send natural language test steps for execution against persistent browser sessions. Each session manages its own browser instance, stays open between requests, and accumulates state (captured outputs, page context) across multiple step batches.

---

## Startup

- New CLI command (e.g. `ai-ui-automation serve`) starts the API server.
- Server listens on a configurable host and port, defined in the existing project config file.
- A default API key is defined in the config file. All requests must include this key in the `x-api-key` header.

### Config Fields

| Field         | Description                        | Default         |
|---------------|------------------------------------|-----------------|
| `api.host`    | Host to bind the server to         | `127.0.0.1`     |
| `api.port`    | Port to listen on                  | `3100`          |
| `api.apiKey`  | API key for authentication         | (default value)  |

---

## Authentication

All endpoints require the `x-api-key` header matching the configured API key.

- Missing or invalid key returns `401 Unauthorized`.

---

## Endpoints

### POST /sessions/:id/steps

Execute a batch of test steps within a named session.

#### Session ID

- `:id` is a caller-provided string (e.g. `"my-checkout-test"`, `"login flow"`).
- Maximum 128 characters. Spaces are allowed.
- If the session does not exist, it is created implicitly (a new browser instance is launched).
- If the session was previously closed (via a "Close the browser" step), a new session is created with the same ID.
- If the session is currently executing a previous request, the new request is queued and processed after the current execution completes.

#### Request Body

```json
{
  "config": {
    "baseUrl": "http://localhost:3000",
    "timeout": "30s",
    "viewport": "mobile"
  },
  "steps": [
    "Navigate to the login page",
    "Enter \"{{email}}\" in the email field",
    "[output: welcome_text] Assert the welcome message is visible"
  ],
  "parameters": {
    "email": "demo@example.com",
    "password": "secret123"
  }
}
```

| Field        | Required | Description |
|--------------|----------|-------------|
| `config`     | No       | Session configuration. Only allowed on the **first request** for a session. Sending `config` on subsequent requests returns `400 Bad Request`. |
| `config.baseUrl` | No  | Base URL for the application under test. |
| `config.timeout` | No  | Timeout per step (e.g. `"30s"`, `"2m"`). |
| `config.viewport` | No | Render this session's pages at exactly this size, headed **and** headless. See below. |

#### `config.viewport`

The raw `## Config: viewport:` value from the test file, forwarded verbatim —
clients do not resolve it, the server does. One validator means the CLI, the
editor and an MCP agent all refuse the same values with the same words.

| Value | Page size |
|---|---|
| `mobile` | 390 × 844 |
| `tablet` | 768 × 1024 |
| `desktop` | 1440 × 900 |
| `<width>x<height>` (e.g. `390x844`) | exactly that |

- Case-insensitive, surrounding whitespace trimmed. Each dimension must be
  between 100 and 10000.
- Anything else is refused with
  ``Invalid '## Config: viewport: <value>' — expected a preset (mobile | tablet | desktop) or `<width>x<height>` (e.g. `390x844`).``
  Validation runs **before the browser launches**, so an invalid value fails the
  batch with no browser side effects.
- Refused alongside `config.cdp`: a viewport cannot be imposed on a browser the
  user started and sized themselves.
- Like the rest of `config`, it is write-once — see the note on the `config`
  row above. A client that wants a different size on a live session closes the
  session first (`DELETE /sessions/:id`) and sends the new value on the next
  batch.
- CSS breakpoints only. No touch events, no mobile user agent, no
  `devicePixelRatio` change.
| `steps`      | Yes      | Array of natural language step strings. At least one step is required. |
| `parameters` | No       | Key-value object for `{{variable}}` interpolation in steps. Can override previously captured output variables. |

#### Step Format

Steps are natural language instructions, identical to the format used in markdown test files:

- **Plain instructions**: `"Click the Sign In button"`
- **Parameter interpolation**: `"Enter \"{{email}}\" in the email field"` — resolved from `parameters` in the request body, or from previously captured output variables.
- **Output capture**: `"[output: variable_name] Get the displayed username"` — captures a DOM value into a named variable. Multiple outputs per step are supported: `"[output: plan_name] [output: plan_price] Get the plan details"`.
- **Variable assignment**: `"Set {{summary}} to \"{{username}} had {{balance}}\""` — stores a value built from the session's existing variables under a new name, with no AI call. The template resolves `{{name}}` and `${env.X}` / `${data.x}` against the session as it stands; a reference it cannot resolve fails the step rather than storing the literal. Note that a **malformed** `Set {{name}} to …` is *not* rejected here: this endpoint receives step strings and never parses markdown, so a line that does not match the form is sent to the AI as ordinary prose. The parse-time refusal applies to files read by the CLI and by the MCP tools, not to steps posted here.
- **Ignored prefixes**: `[input: variable_name]` and `[interactive]` are silently skipped, as they are interactive/terminal concepts that do not apply to the API.

A step may also name a file to upload — `Upload file attachments/logo.png`, or
with Windows-style backslashes, which are normalised. The path is resolved
against the folder holding the `testFilePath` sent with the request, and is
fenced to the project root: a path that resolves outside it is refused. The file
must be readable **by the server process** — the bytes are read where the server
runs, not on the client machine — so a client on another host has to put the
file somewhere the server can read it. A request that omits `testFilePath` has
no folder to resolve a relative path against, so it can only use absolute paths.

#### Output Variable Accumulation

- Output variables captured via `[output: var]`, and values written by a `Set {{name}} to "…"` step, are stored in the session.
- They accumulate across multiple requests to the same session.
- They are automatically available for `{{variable}}` interpolation in subsequent requests without the caller needing to re-pass them.
- A caller can override a previously captured output by passing the same key in the `parameters` object.

#### Execution Behavior

- Steps execute **synchronously** — the HTTP response is returned only after all steps have completed or one has failed.
- If a step fails, execution **stops immediately**. Remaining steps are not executed.
- The response includes results for all steps that were attempted (including the failed one).

#### Leaving a flow early

A step written `If <condition> then return` (or `… then stop`), and a step whose
whole text is that tail (`Return`, `Stop here`, `Stop running the remaining
steps`), ends the innermost flow it is in **as a pass**: the
rest of a `### Section` body, the rest of a skill body, or the rest of the run
when the step is in the main flow. The run status is unaffected — a return is
not a failure — and the steps left behind are reported as **skipped**, never as
passed. See `stories/step-flow-control.md`.

- The returning step itself is an ordinary passed step: `status: "passed"`, with
  `reasoning` reading `Returned from "<section or skill>"` or `Ended the run`,
  plus the model's own account of why the condition held.
- Every step the return leaves behind gets a `results[]` entry with
  `status: "skipped"` and `reasoning` of the form
  `Not run: step 3 returned from "Sign in" — <the returning step's authored
  line>` (or `Not run: step 3 ended the run — …`), the appended line clipped to
  80 characters with `…`. The number is the **expanded** step index, matching
  the `results[]` order and the run log; the text is the step as AUTHORED,
  never interpolated, so a resolved secret cannot ride out on it. That holds for
  a step in the body of a **looped section** too, even though the request's
  `sections` carry no `rawSteps` parallel (§3.2): the server pins that body's
  match side to the section's own `steps`, which §3.2 defines as the raw body
  line, before it interpolates a row into the text it executes. Skipped steps
  take no screenshot and capture no outputs.
- `stepsCompleted` does not count the steps a `return`/`stop` skipped, so a run
  that returned from the main flow reports fewer completed steps than
  `stepsTotal` and still has `"status": "passed"`. That is the rule for THIS
  producer only: a step a **decision** skipped — the untaken half of an
  `If` / `Otherwise`, a loop body that ran no passes — is counted, as an
  `[input:]` / `[interactive]` step skipped unattended always has been, because
  none of those is ever coming and the number is a progress denominator. The
  `stepsCompleted` row under *Response Body* states the whole rule in one
  place.

On the SSE stream (`?stream=1`) each skipped step is announced by its own event:

```
event: step:skip
data: {"type":"step:skip","line":9,"frame":{…},"reason":"Not run: step 3 returned from \"Sign in\" — If the page title contains \"Dashboard\" then return"}
```

| Field    | Description |
|----------|-------------|
| `line`   | 1-based source line, in `frame`'s file, of the step (or call) that did not run. |
| `frame`  | Origin frame, when the request asked for skill/section expansion. Optional, as on every other step event. |
| `reason` | The same sentence the step's `results[]` row carries. |

A `step:skip` has **no matching `step:start`**, and no `frame:push` is emitted
for a skipped step's frame. That is deliberate: a section or skill invoked
inside the returned body must not push and pop cleanly, or its call line would
paint as passed for work that never ran. Such a nested call gets a
`step:skip` of its own, addressed by the **invocation line in the parent
frame's file** — the line the author sees in the editor. The frame the return
left pops normally, at the next executed step's frame transition or at end of
run, so the call line that invoked it does show as passed: it ran, and it
returned.

Clients that do not know `step:skip` drop it, which is the safe direction —
the line keeps whatever it was showing rather than the run failing.

#### The other skipped-step event

A step that never ran for a reason other than a `return` — the untaken half of
an `If` / `Otherwise` decision, the guard line of a chain in which nothing held
and there was no `Otherwise`, a loop body that ran no passes, or an `[input:]` /
`[interactive]` step this endpoint will not run unattended — arrives on an older
convention: a `step:pass` carrying `output: "skipped"`.

```
event: step:pass
data: {"type":"step:pass","line":5,"output":"skipped","reason":"Skipped: another branch of this decision was taken","skipKind":"not-taken"}
```

| Field      | Description |
|------------|-------------|
| `output`   | The literal `"skipped"`. Every client that derives a glyph or a log line from `step:pass` must check this before reporting the step as passed. |
| `reason`   | The same sentence the step's `results[]` row carries. **Optional** — a server older than this field sends none, and the sentence reads without it. |
| `skipKind` | `"unattended"` (an `[input:]` / `[interactive]` step: it needs a person before it can ever pass) or `"not-taken"` (a branch or loop body the run decided against: nothing is wanted from anyone). **Optional, and absent means `"unattended"`** — until the field existed that was this event's only producer. A consumer that must tell the two apart reads this rather than the prose in `reason`. |

Both events stay. `step:skip` is the better shape, but the extension is an HTTP
client of whichever server its workspace points at, and a client that stopped
reading the older convention would repaint the untaken branch **green** against
a server nobody had restarted.

#### Response Body

```json
{
  "sessionId": "my-checkout-test",
  "status": "passed",
  "stepsCompleted": 5,
  "stepsTotal": 5,
  "results": [
    {
      "step": "Navigate to the login page",
      "status": "passed",
      "actions": [
        { "type": "navigate", "url": "http://localhost:3000/login" }
      ],
      "screenshot": "data:image/png;base64,...",
      "reasoning": "Navigating to the login page from baseUrl",
      "outputs": {}
    },
    {
      "step": "[output: username] Get the displayed username",
      "status": "passed",
      "actions": [
        { "type": "extract", "selector": ".profile-name" }
      ],
      "screenshot": "data:image/png;base64,...",
      "reasoning": "Found the username in the profile header",
      "outputs": { "username": "Jane Smith" }
    },
    {
      "step": "[output: email] Get the displayed email address",
      "status": "passed",
      "actions": [
        { "type": "extract", "selector": ".profile-email" }
      ],
      "screenshot": "data:image/png;base64,...",
      "reasoning": "Found the email below the username",
      "outputs": { "email": "jane@example.com" }
    },
    {
      "step": "[output: plan_name] [output: plan_price] Get the subscription plan name and price",
      "status": "passed",
      "actions": [
        { "type": "extract", "selector": ".plan-details" }
      ],
      "screenshot": "data:image/png;base64,...",
      "reasoning": "Extracted plan name and price from the subscription card",
      "outputs": { "plan_name": "Pro", "plan_price": "$29/mo" }
    },
    {
      "step": "Click the Edit Profile button",
      "status": "passed",
      "actions": [
        { "type": "click", "selector": "#edit-profile-btn" }
      ],
      "screenshot": "data:image/png;base64,...",
      "reasoning": "Clicked the edit button in the profile header",
      "outputs": {}
    }
  ],
  "outputs": {
    "username": "Jane Smith",
    "email": "jane@example.com",
    "plan_name": "Pro",
    "plan_price": "$29/mo"
  },
  "error": null
}
```

| Field            | Description |
|------------------|-------------|
| `sessionId`      | The session ID from the request. |
| `status`         | `"passed"` if all steps succeeded, `"failed"` if an assertion failed, `"error"` if a step encountered an unexpected error. |
| `stepsCompleted` | Number of steps that executed successfully. Steps skipped by a `return`/`stop` are not counted — they did not execute. Steps a **decision** skipped (the untaken half of an `If` / `Otherwise`, or a loop body that ran no passes) ARE counted, as an `[input:]` skip always has been: this number is a progress denominator against `stepsTotal`, and an untaken branch is never coming, so a run whose chain skipped three steps would otherwise stop three short of the end forever. See `stories/control-flow.md` §"What `stepsCompleted` counts". |
| `stepsTotal`     | Total number of steps in the request. |
| `results`        | Array of per-step results, in execution order. Includes all attempted steps (up to and including the failed step, if any). |
| `results[].step` | The original step text as provided. |
| `results[].status` | `"passed"`, `"failed"`, `"error"`, or `"skipped"` for this individual step. `"skipped"` means the step did not run: an earlier step ended the flow it was in (see *Leaving a flow early*), a decision took another branch, or a loop ran no passes. `reasoning` says which. One exception, kept for compatibility: an `[input:]` / `[interactive]` step this endpoint will not run unattended is still reported `"passed"` with a `reasoning` that says it was skipped. On the SSE stream all three arrive as skips. |
| `results[].actions` | Array of structured actions the AI determined and executed for this step. |
| `results[].screenshot` | Base64-encoded screenshot taken after the step completed. |
| `results[].reasoning` | The AI's reasoning for how it interpreted and executed the step. On a `"skipped"` step, why it did not run — e.g. `Not run: step 3 returned from "Sign in" — If the page title contains "Dashboard" then return`. |
| `results[].outputs` | Outputs captured by this specific step. Empty object `{}` if no `[output:]` prefix was used. |
| `outputs`        | Accumulated outputs across all steps in this request, merged with outputs from any previous requests in this session. |
| `error`          | `null` on success. On failure: `{ "step": <index>, "message": "..." }` where `step` is the zero-based index of the failing step. |

#### Error Response (failed step)

```json
{
  "sessionId": "my-checkout-test",
  "status": "failed",
  "stepsCompleted": 1,
  "stepsTotal": 3,
  "results": [
    {
      "step": "Navigate to the login page",
      "status": "passed",
      "actions": [{ "type": "navigate", "url": "http://localhost:3000/login" }],
      "screenshot": "data:image/png;base64,...",
      "reasoning": "...",
      "outputs": {}
    },
    {
      "step": "Assert the welcome banner shows \"Hello Admin\"",
      "status": "failed",
      "actions": [{ "type": "assert", "expected": "Hello Admin" }],
      "screenshot": "data:image/png;base64,...",
      "reasoning": "The welcome banner shows 'Hello Guest', not 'Hello Admin'",
      "outputs": {}
    }
  ],
  "outputs": {},
  "error": {
    "step": 1,
    "message": "Assertion failed: expected 'Hello Admin' but found 'Hello Guest'"
  }
}
```

---

### GET /sessions/:id

Get the current state of an active session.

#### Response Body

```json
{
  "sessionId": "my-checkout-test",
  "status": "active",
  "currentUrl": "http://localhost:3000/profile",
  "pageTitle": "User Profile — MyApp",
  "screenshot": "data:image/png;base64,...",
  "outputs": {
    "username": "Jane Smith",
    "email": "jane@example.com"
  },
  "totalStepsExecuted": 12
}
```

| Field                | Description |
|----------------------|-------------|
| `sessionId`          | The session ID. |
| `status`             | `"active"`, `"executing"` (currently running steps), or `"queued"` (has pending requests). |
| `currentUrl`         | The current URL of the browser page. |
| `pageTitle`          | The current page title. |
| `screenshot`         | Base64-encoded screenshot of the current browser state. |
| `outputs`            | All accumulated output variables for this session. |
| `totalStepsExecuted` | Total number of steps executed across all requests to this session. |

#### Error Responses

- `404 Not Found` — Session ID does not exist or has been closed.

---

### GET /sessions

List all active sessions.

#### Response Body

```json
{
  "sessions": [
    {
      "sessionId": "my-checkout-test",
      "status": "active",
      "currentUrl": "http://localhost:3000/profile",
      "pageTitle": "User Profile — MyApp",
      "totalStepsExecuted": 12
    },
    {
      "sessionId": "login flow",
      "status": "executing",
      "currentUrl": "http://localhost:3000/login",
      "pageTitle": "Login — MyApp",
      "totalStepsExecuted": 3
    }
  ]
}
```

- Only active (not closed) sessions are returned.
- No screenshots in the list endpoint (to keep responses lightweight). Use `GET /sessions/:id` for screenshots.

---

## Session Lifecycle

```
[First POST /sessions/:id/steps]
        |
        v
   Session Created (new browser instance launched)
        |
        v
   Active — accepts step requests, queues if busy
        |
        v
   [Step "Close the browser" executed]
        |
        v
   Session Closed (browser instance destroyed, removed from active list)
        |
        v
   [POST /sessions/:id/steps with same ID]
        |
        v
   New Session Created (fresh browser instance, no state carried over)
```

- Each session = one dedicated browser instance.
- Multiple sessions run in parallel, each with independent browser instances.
- Sessions use the globally configured AI provider and model.

---

## HTTP Status Codes

| Status | Meaning |
|--------|---------|
| `200`  | Success (steps executed, even if a step failed — check `status` field). |
| `400`  | Bad request (e.g. `config` sent on non-first request, missing `steps` array, session ID exceeds 128 chars). |
| `401`  | Unauthorized (missing or invalid `x-api-key` header). |
| `404`  | Session not found (for `GET /sessions/:id` on a closed or nonexistent session). |
| `500`  | Internal server error. |

---

## Out of Scope (v1)

- WebSocket streaming of step progress
- Video recording
- Parallel step execution within a single session
- Per-session AI provider/model configuration
- Per-session browser configuration (headless/headed, viewport, proxy)
- Session persistence across server restarts
